import { prisma } from '@core/db/prisma';

/**
 * Fed constraint (Phase 6 Addendum 8B). A single global, effective-dated
 * judgment value about the Fed, stored ADDITIVELY on the USD rows of the
 * existing currency_cycle_stance table (Fed ↔ USD) — see Task 0.2 recon.
 *
 *   CONSTRAINED = the Fed cannot answer hot inflation with hikes → inflation
 *                 is a gold tailwind → gold Override 2 applies.
 *   FREE        = the Fed can hike into inflation → hot CPI/PPI/PCE stay
 *                 classically gold-bearish → Override 2 suppressed.
 *
 * Resolution mirrors the cycle-stance convention exactly (greatest
 * effective_from <= t, with an open/covering effective_to). Manually updated
 * by the user like a cycle stance — no automation. Fail-safe default is FREE:
 * if no USD row resolves, or the resolved row has no fed_constraint set, the
 * gold override behaves classically (Override 2 suppressed under Risk-Off).
 */
export type FedConstraint = 'FREE' | 'CONSTRAINED';

export interface FedConstraintResolution {
  value: FedConstraint;
  /** effectiveFrom of the USD cycle-stance row the value was read from, or null when defaulted. */
  effectiveFrom: string | null;
}

export async function resolveFedConstraint(observationDate: Date): Promise<FedConstraintResolution> {
  const row = await prisma.currencyCycleStance.findFirst({
    where: {
      currencyCode: 'USD',
      effectiveFrom: { lte: observationDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: observationDate } }],
    },
    orderBy: { effectiveFrom: 'desc' },
    select: { fedConstraint: true, effectiveFrom: true },
  });

  if (!row || row.fedConstraint !== 'CONSTRAINED') {
    // Missing row, or an explicit/absent non-CONSTRAINED value → FREE (fail-safe).
    return {
      value: 'FREE',
      effectiveFrom: row ? row.effectiveFrom.toISOString().slice(0, 10) : null,
    };
  }

  return { value: 'CONSTRAINED', effectiveFrom: row.effectiveFrom.toISOString().slice(0, 10) };
}
