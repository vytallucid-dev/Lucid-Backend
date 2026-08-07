/**
 * Phase 3 — insufficient-data / staleness census for Oracle responses.
 *
 * Every new AUD, CN and JP indicator currently returns insufficient_data
 * because nothing has been ingested for them yet, so an AUD score today
 * reflects only the other side of each pair. The API must say so rather than
 * presenting a confident number built on silence.
 *
 * Staleness reuses the EXISTING frequency-scaled bands from the admin
 * data-gaps report (daily 5/14, weekly 10/21, monthly 45/75, quarterly
 * 100/130, event_driven 365/730) — no second mechanism is introduced. This is
 * what makes AU PPI legible: it is quarterly against monthly counterparts, so
 * it scores anyway but shows up in the staleness display once it passes its
 * own 100-day band rather than a monthly one.
 */
import { prisma } from '@core/db/prisma';
import { classifySeverity } from '@modules/nifty/services/data-gaps.service';
import type { DataHealth } from './oracle.types';

/** Share of insufficient inputs at or above which an instrument reads as degraded. */
const DEGRADED_FRACTION = 1 / 3;

export const EMPTY_DATA_HEALTH: DataHealth = {
  total: 0,
  insufficient: 0,
  stale: 0,
  insufficientCodes: [],
  staleCodes: [],
  degraded: false,
};

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Build the census for a set of indicator codes.
 *
 * @param codes            every scoring input for the instrument (COT excluded)
 * @param insufficientCodes the subset the scoring engine could not score
 */
export async function buildDataHealth(
  codes: string[],
  insufficientCodes: string[],
  asOf: Date,
): Promise<DataHealth> {
  const unique = [...new Set(codes)];
  if (unique.length === 0) return { ...EMPTY_DATA_HEALTH };

  const indicators = await prisma.indicator.findMany({
    where: { code: { in: unique } },
    select: {
      code: true,
      frequency: true,
      // Not take:1 — an indicator can now have more than one isCurrent row
      // on its latest observationDate (Flash + Final coexisting). Staleness
      // only needs the most recent DATE (which release doesn't matter for
      // "how long since anything printed"), so take every current row and
      // reduce to max(observationDate) below rather than trusting row order.
      dataPoints: {
        where: { isCurrent: true },
        orderBy: { observationDate: 'desc' },
        select: { observationDate: true },
      },
    },
  });

  const insufficient = new Set(insufficientCodes);
  const staleCodes: DataHealth['staleCodes'] = [];

  for (const ind of indicators) {
    // A code with no usable score is already counted as insufficient; reporting
    // it as stale as well would double-count the same gap.
    if (insufficient.has(ind.code)) continue;
    const latest = ind.dataPoints.reduce<Date | undefined>(
      (max, dp) => (!max || dp.observationDate > max ? dp.observationDate : max),
      undefined,
    );
    if (!latest) continue;
    const daysSince = daysBetween(latest, asOf);
    const severity = classifySeverity(daysSince, ind.frequency);
    if (severity === 'warning' || severity === 'critical') {
      staleCodes.push({ code: ind.code, daysSince, severity });
    }
  }

  staleCodes.sort((a, b) => b.daysSince - a.daysSince);
  const insufficientList = unique.filter((c) => insufficient.has(c)).sort();

  return {
    total: unique.length,
    insufficient: insufficientList.length,
    stale: staleCodes.length,
    insufficientCodes: insufficientList,
    staleCodes,
    degraded: unique.length > 0 && insufficientList.length / unique.length >= DEGRADED_FRACTION,
  };
}
