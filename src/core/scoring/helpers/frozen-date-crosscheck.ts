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
}

export interface GetSkipDatesResult {
  skipDates: Set<string>;
  warnings: FrozenWarning[];
}

interface SeriesRow {
  date: string;
  value: string;
}

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

function findFrozenDates(series: SeriesRow[]): Map<string, string> {
  const frozen = new Map<string, string>();
  for (let i = 0; i < series.length; i++) {
    const current = series[i];
    const older = series[i + 1];
    const newer = series[i - 1];
    const matchesOlder = older !== undefined && current.value === older.value;
    const matchesNewer = newer !== undefined && current.value === newer.value;
    if (matchesOlder || matchesNewer) {
      frozen.set(current.date, current.value);
    }
  }
  return frozen;
}

export async function getSkipDates(params: GetSkipDatesParams): Promise<GetSkipDatesResult> {
  const { indicatorCode, indicatorId, observationDate, lookbackRows } = params;

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

  const targetFrozen = findFrozenDates(targetSeries);
  const otherFrozenByCode = new Map<string, Map<string, string>>();
  for (const [code, series] of otherSeriesByCode) {
    otherFrozenByCode.set(code, findFrozenDates(series));
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
