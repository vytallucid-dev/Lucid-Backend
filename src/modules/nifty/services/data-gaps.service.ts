import { prisma } from '@core/db/prisma';

export type GapSeverity = 'fresh' | 'info' | 'warning' | 'critical' | 'never';

export interface IndicatorGap {
  indicatorCode: string;
  indicatorName: string;
  frequency: string;
  dataSource: string;
  lastObservationDate: string | null;
  daysSinceLastObservation: number | null;
  severity: GapSeverity;
  expectedFreshnessDays: number;
}

interface FreshnessThresholds {
  fresh: number; // <= this many days = fresh
  warning: number; // <= this many days = warning, else critical
}

/**
 * Per-frequency freshness thresholds.
 * - fresh: data is up to date
 * - info: slightly delayed but expected (light staleness)
 * - warning: overdue, action recommended
 * - critical: significantly overdue, action required
 */
const THRESHOLDS_BY_FREQUENCY: Record<string, FreshnessThresholds> = {
  daily: { fresh: 5, warning: 14 },
  weekly: { fresh: 10, warning: 21 },
  monthly: { fresh: 45, warning: 75 },
  quarterly: { fresh: 100, warning: 130 },
  event_driven: { fresh: 365, warning: 730 }, // RBI: ~8 meetings/year, so ~45-day max gap is normal
};

function classifySeverity(daysSince: number | null, freq: string): GapSeverity {
  if (daysSince === null) return 'never';

  const thresholds = THRESHOLDS_BY_FREQUENCY[freq] ?? THRESHOLDS_BY_FREQUENCY.monthly;

  if (daysSince <= thresholds.fresh) return 'fresh';
  if (daysSince <= thresholds.warning) return 'warning';
  return 'critical';
}

function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

export async function getDataGapsReport(asOf: Date = new Date()): Promise<IndicatorGap[]> {
  const indicators = await prisma.indicator.findMany({
    where: { isActive: true },
    orderBy: { displayOrder: 'asc' },
  });

  const report: IndicatorGap[] = [];

  for (const indicator of indicators) {
    const latest = await prisma.dataPoint.findFirst({
      where: { indicatorId: indicator.id, isCurrent: true },
      orderBy: { observationDate: 'desc' },
      select: { observationDate: true },
    });

    const lastObservationDate = latest?.observationDate ?? null;
    const daysSinceLastObservation = lastObservationDate
      ? daysBetween(lastObservationDate, asOf)
      : null;

    const severity = classifySeverity(daysSinceLastObservation, indicator.frequency);
    const thresholds =
      THRESHOLDS_BY_FREQUENCY[indicator.frequency] ?? THRESHOLDS_BY_FREQUENCY.monthly;

    report.push({
      indicatorCode: indicator.code,
      indicatorName: indicator.name,
      frequency: indicator.frequency,
      dataSource: indicator.dataSource,
      lastObservationDate: lastObservationDate
        ? lastObservationDate.toISOString().slice(0, 10)
        : null,
      daysSinceLastObservation,
      severity,
      expectedFreshnessDays: thresholds.fresh,
    });
  }

  return report;
}
