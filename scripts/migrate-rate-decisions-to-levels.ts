/**
 * One-off migration: rate decisions store LEVELS, like every other indicator.
 *
 * BEFORE                                   AFTER
 *   value           bps change vs prior      the announced rate
 *   forecast_value  bps change vs prior      the expected rate
 *   previous_value  null (always)            the prior decision's rate
 *   metadata        rate_level,              (both removed — the columns are
 *                   expected_rate_level       now the single source of truth)
 *
 * The levels were never lost, only misplaced, so this is exact: every value
 * written here comes from the metadata the ingestion paths already stored, and
 * `previous_value` from the preceding row's level. Nothing is inferred.
 *
 * ── SCOPE: BY SCORING RULE, NEVER BY CODE ───────────────────────────────────
 * `IND_NIFTY_04_RBI_RATE` ends in `_RATE` but is a NIFTY `cycle_regime`
 * indicator scored by a different handler, and it has ALWAYS stored levels.
 * Selecting on the code suffix would rewrite it for no reason. This selects on
 * `scoring_rules.rule_type = 'rate_decision'`, which is what actually decides
 * whether the rate-decision handler ever reads the row.
 *
 *   npx tsx scripts/migrate-rate-decisions-to-levels.ts          # dry run
 *   npx tsx scripts/migrate-rate-decisions-to-levels.ts --apply
 */
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : null;
}

async function main(): Promise<void> {
  const indicators = await prisma.$queryRawUnsafe<Array<{ id: string; code: string }>>(`
    SELECT i.id, i.code FROM indicators i
    WHERE (
      SELECT r.rule_type::text FROM scoring_rules r
      WHERE r.indicator_id = i.id ORDER BY r.version DESC LIMIT 1
    ) = 'rate_decision'
    ORDER BY i.code`);

  console.log(`Scope: ${indicators.length} rate_decision indicators — ${indicators.map((i) => i.code).join(', ')}\n`);

  let changed = 0;
  let skipped = 0;

  for (const ind of indicators) {
    const rows = await prisma.dataPoint.findMany({
      where: { indicatorId: ind.id },
      orderBy: [{ observationDate: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true, observationDate: true, isCurrent: true,
        value: true, forecastValue: true, previousValue: true, sourceMetadata: true,
      },
    });

    // The prior level walks forward through the series, exactly as ingestion
    // computed it — the preceding decision's announced rate.
    let priorLevel: number | null = null;

    for (const r of rows) {
      const meta = { ...((r.sourceMetadata ?? {}) as Record<string, unknown>) };
      const level = num(meta.rate_level);
      const expected = num(meta.expected_rate_level);

      if (level === null) {
        // Already migrated (metadata cleared), or never carried a level.
        console.log(`  SKIP ${ind.code} ${r.observationDate.toISOString().slice(0, 10)} — no rate_level in metadata`);
        skipped++;
        if (r.isCurrent) priorLevel = num(r.value);
        continue;
      }

      delete meta.rate_level;
      delete meta.expected_rate_level;

      console.log(
        `  ${ind.code} ${r.observationDate.toISOString().slice(0, 10)}` +
        `  value ${String(r.value)} -> ${level}` +
        `  forecast ${String(r.forecastValue)} -> ${expected}` +
        `  previous ${String(r.previousValue)} -> ${priorLevel}`,
      );
      changed++;

      if (APPLY) {
        await prisma.dataPoint.update({
          where: { id: r.id },
          data: {
            value: level,
            forecastValue: expected,
            previousValue: priorLevel,
            sourceMetadata: meta as Prisma.InputJsonObject,
          },
        });
      }

      if (r.isCurrent) priorLevel = level;
    }
  }

  console.log(`\n${changed} row(s) ${APPLY ? 'migrated' : 'would change'}, ${skipped} skipped.`);
  if (!APPLY && changed > 0) console.log('Re-run with --apply to write.');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
