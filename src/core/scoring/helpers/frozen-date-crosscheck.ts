import { prisma } from '@core/db/prisma';

const CROSSCHECK_GROUP = ['IND_NIFTY_10_DXY', 'IND_NIFTY_11_BRENT', 'IND_NIFTY_12_USDINR'];

export interface FrozenWarning {
  indicatorCode: string;
  date: string;
  value: string;
  reason: 'suspected_feed_breakage';
}

export interface GetSkipDatesParams {
  indicatorCode: string;
  indicatorId: string;
  observationDate: Date;
  lookbackRows: number;
  /**
   * Minimum consecutive-run length (in the deduped, date-ordered series) for
   * a repeated value to be treated as suspect. Default 3 — raised 2026-08-17
   * from an implicit 2 (the old code flagged ANY value matching either
   * adjacent neighbor, which is equivalent to a length-2 threshold). Genuine
   * 2-day coincidences (e.g. USD/INR closing at the same 2-decimal rate on
   * back-to-back days) are common and mostly benign; excluding them from the
   * slope/sigma window for no real reason costs real observations. 3+ is a
   * much stronger frozen-feed signal.
   */
  minRunLength?: number;
}

export interface GetSkipDatesResult {
  skipDates: Set<string>;
  warnings: FrozenWarning[];
}

interface SeriesRow {
  date: string;
  value: string;
}

const DEFAULT_MIN_RUN_LENGTH = 3;

async function loadSeries(indicatorId: string, observationDate: Date, take: number): Promise<SeriesRow[]> {
  const rows = await prisma.dataPoint.findMany({
    where: {
      indicatorId,
      isCurrent: true,
      observationDate: { lte: observationDate },
    },
    orderBy: { observationDate: 'desc' },
    take,
  });
  return rows.map((r) => ({
    date: r.observationDate.toISOString().slice(0, 10),
    value: r.value.toFixed(6),
  }));
}

/**
 * Same core mechanism as before — adjacent-value comparison in the
 * date-ordered series — restructured to measure each contiguous run's total
 * length before deciding whether to flag it, rather than flagging on any
 * single adjacent match. This is a threshold change, not a different
 * detection algorithm: a run of length >= minRunLength is found by walking
 * the series and grouping consecutive equal-value entries (the same
 * adjacency comparison the old matchesOlder/matchesNewer logic used), and
 * every date inside a run that clears the threshold is flagged — which,
 * unlike the old any-neighbor-match version, was already mathematically
 * equivalent to "flag every date in any run of length >= 2" (every interior
 * date matches both neighbors, every edge date matches at least one) — see
 * chat report for the proof. Nothing here needed to become "smarter" about
 * interiors; only the length threshold needed to move.
 */
function findFrozenDates(series: SeriesRow[], minRunLength: number): Map<string, string> {
  const frozen = new Map<string, string>();
  let i = 0;
  while (i < series.length) {
    let j = i;
    while (j + 1 < series.length && series[j + 1].value === series[i].value) j++;
    const runLength = j - i + 1;
    if (runLength >= minRunLength) {
      for (let k = i; k <= j; k++) frozen.set(series[k].date, series[k].value);
    }
    i = j + 1;
  }
  return frozen;
}

export async function getSkipDates(params: GetSkipDatesParams): Promise<GetSkipDatesResult> {
  const { indicatorCode, indicatorId, observationDate, lookbackRows } = params;
  const minRunLength = params.minRunLength ?? DEFAULT_MIN_RUN_LENGTH;

  if (!CROSSCHECK_GROUP.includes(indicatorCode)) {
    return { skipDates: new Set(), warnings: [] };
  }

  const scanTake = Math.max(lookbackRows * 3, 40);

  const otherCodes = CROSSCHECK_GROUP.filter((c) => c !== indicatorCode);
  const otherIndicators = await prisma.indicator.findMany({
    where: { code: { in: otherCodes } },
  });

  const targetSeries = await loadSeries(indicatorId, observationDate, scanTake);
  const otherSeriesByCode = new Map<string, SeriesRow[]>();
  for (const other of otherIndicators) {
    const series = await loadSeries(other.id, observationDate, scanTake);
    otherSeriesByCode.set(other.code, series);
  }

  const targetFrozen = findFrozenDates(targetSeries, minRunLength);
  const otherFrozenByCode = new Map<string, Map<string, string>>();
  for (const [code, series] of otherSeriesByCode) {
    otherFrozenByCode.set(code, findFrozenDates(series, minRunLength));
  }

  const skipDates = new Set<string>();
  const warnings: FrozenWarning[] = [];

  for (const [date, value] of targetFrozen) {
    skipDates.add(date);

    const anyOtherFrozen = otherCodes.some((code) => otherFrozenByCode.get(code)?.has(date));

    if (!anyOtherFrozen) {
      warnings.push({
        indicatorCode,
        date,
        value,
        reason: 'suspected_feed_breakage',
      });
    }
  }

  return { skipDates, warnings };
}
