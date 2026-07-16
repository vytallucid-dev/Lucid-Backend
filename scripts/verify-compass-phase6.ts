/* eslint-disable no-console */
/**
 * Compass v2 Phase 6 verification — read-only, writes nothing.
 *
 * For each live (isValidation=false) classification on/after v2 activation,
 * prints the two override gates' state: us02y_close, us02y_sma21,
 * rate_gate_hawkish, fed_constraint + its effective date, each override's
 * active/suppressed state with the reason, and the final post-gate override
 * set. Reads only what the classifier already persisted (compass_classifications
 * gate-audit columns) plus a live fed-constraint resolution for display.
 *
 * Expected on current data: regime Caution → regime_path_riskoff false → no
 * overrides fire regardless of the gates; the gates are computed and visible
 * but inert. us02y_close / us02y_sma21 should both show real numbers.
 */
import { prisma } from '@core/db/prisma';
import { resolveFedConstraint } from '@modules/edgefinder/services/compass/fed-constraint.resolver';
import { isRegimePathRiskOff } from '@modules/edgefinder/services/compass/compass-override-gates';
import type { Regime } from '@modules/edgefinder/services/compass/compass-classifier-logic';

const DAYS_TO_CHECK = Number(process.argv[2] ?? 10);
const V2_ACTIVATION_DATE = new Date('2026-07-16');

function num(d: unknown): number | null {
  if (d === null || d === undefined) return null;
  return Number((d as { toString(): string }).toString());
}

async function main(): Promise<void> {
  const rows = await prisma.compassClassification.findMany({
    where: {
      isCurrent: true,
      isValidation: false,
      classificationDate: { gte: V2_ACTIVATION_DATE },
    },
    orderBy: { classificationDate: 'desc' },
    take: DAYS_TO_CHECK,
  });

  if (rows.length === 0) {
    console.log(
      `No live compass_classifications rows on or after v2 activation (${V2_ACTIVATION_DATE.toISOString().slice(0, 10)}) — nothing to verify yet.`,
    );
    return;
  }

  for (const day of [...rows].reverse()) {
    const dateLabel = day.classificationDate.toISOString().slice(0, 10);
    console.log(`\n=== ${dateLabel} ===`);

    const finalRegime = day.finalRegime as Regime;
    const standardActive = day.activeRegime as Regime;
    const regimePathRiskOff = isRegimePathRiskOff({
      finalRegime,
      standardActiveRegime: standardActive,
      shockAActive: day.shockAActive,
    });

    console.log(
      `  standard_active_regime=${standardActive}  final_regime=${finalRegime || '(pre-Phase-4)'}  shockA=${day.shockAActive}  shockB=${day.shockBActive}`,
    );
    console.log(`  regime_path_riskoff=${regimePathRiskOff}`);

    // --- 8A rate gate ---
    const us02yClose = num(day.us02yClose);
    const us02ySma21 = num(day.us02ySma21);
    console.log('  --- Addendum 8A: rate gate (JPY Overrides 3 & 5) ---');
    console.log(
      `    us02y_close=${us02yClose ?? 'n/a (failed open)'}  us02y_sma21=${us02ySma21 ?? 'n/a'}  rate_gate_hawkish=${day.rateGateHawkish}`,
    );
    console.log(
      `    override_3_suppressed_by_gate=${day.override3SuppressedByGate}  override_5_suppressed_by_gate=${day.override5SuppressedByGate}`,
    );

    // --- 8B fed constraint gate ---
    const fed = await resolveFedConstraint(day.classificationDate);
    console.log('  --- Addendum 8B: fed constraint (Gold Override 2) ---');
    console.log(
      `    fed_constraint(persisted)=${day.fedConstraint || '(pre-Phase-6)'}  fed_constraint(resolved-now)=${fed.value}  effectiveFrom=${fed.effectiveFrom ?? 'default(FREE)'}`,
    );
    console.log(`    override_2_suppressed_by_constraint=${day.override2SuppressedByConstraint}`);

    // --- Final post-gate override set ---
    const overridesActive = Array.isArray(day.overridesActive) ? day.overridesActive : [];
    console.log(`  overrides_active (post-gate)=[${overridesActive.join(', ') || '(none)'}]`);

    // --- Per-override reason lines ---
    const reason = (fired: boolean, suppressed: boolean, gate: string): string =>
      fired ? 'ACTIVE' : suppressed ? `SUPPRESSED (${gate})` : 'inactive (regime path not Risk-Off)';
    console.log('  per-override:');
    console.log(
      `    Override 2 (Gold):  ${reason(overridesActive.includes('OVERRIDE_2_GOLD_INFLATION_HEDGE'), day.override2SuppressedByConstraint, 'fed FREE')}`,
    );
    console.log(
      `    Override 3 (JPY):   ${reason(overridesActive.includes('OVERRIDE_3_JPY_SAFE_HAVEN'), day.override3SuppressedByGate, 'rate gate hawkish')}`,
    );
    console.log(
      `    Override 5 (Carry): ${reason(overridesActive.includes('OVERRIDE_5_CARRY_UNWIND'), day.override5SuppressedByGate, 'rate gate hawkish')}`,
    );
    console.log(
      `    Override 1 & 4 (ungated): ${regimePathRiskOff ? 'ACTIVE (regime path Risk-Off)' : 'inactive'}`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
