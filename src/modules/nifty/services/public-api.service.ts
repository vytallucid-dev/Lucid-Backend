import { Prisma, FetchStatus, FetchTriggerType } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { AppError } from '@core/middleware/error-handler';
import {
  PublicScorecard,
  PublicScorecardHistoryItem,
  PublicIndicator,
  PublicIndicatorMetadata,
  PublicIndicatorDetail,
  PublicIndicatorScore,
  PublicBand,
  PublicComposite,
  PublicCompositionFlag,
  PublicAdminLogsResponse,
  PublicAdminLogEntry,
} from '../types/public-api.types';
import {
  formatIndicatorValue,
  formatMagnitude,
  describeDataSource,
  indicatorOutputRange,
  indicatorShortName,
} from './public-api.formatters';

interface LatestDataPointRow {
  indicator_id: string;
  id: string;
  observation_date: Date;
  value: Prisma.Decimal;
  source: string;
  data_quality_flag: string | null;
  is_current: boolean;
}

interface PriorDataPointRow {
  indicator_id: string;
  observation_date: Date;
  value: Prisma.Decimal;
}

interface PriorScoreRow {
  indicator_id: string;
  observation_date: Date;
  score: number;
  flag: string | null;
}

interface IndicatorLastUpdatedRow {
  indicator_id: string;
  observation_date: Date;
}

const DOMESTIC_CODES = new Set([
  'IND_NIFTY_01_PMI_MFG',
  'IND_NIFTY_02_PMI_SVC',
  'IND_NIFTY_03_CPI',
  'IND_NIFTY_04_RBI_RATE',
  'IND_NIFTY_05_IIP',
  'IND_NIFTY_07_DII_ABSORPTION',
]);

const HISTORY_DEFAULT_LIMIT = 100;
const HISTORY_MAX_LIMIT = 365;
const LOGS_DEFAULT_LIMIT = 25;
const LOGS_MAX_LIMIT = 100;
const INDICATOR_HISTORY_DAYS = 30;

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toIsoDateTime(d: Date): string {
  return d.toISOString();
}

function asScore(value: number): PublicIndicatorScore {
  if (value === -2 || value === -1 || value === 0 || value === 1 || value === 2) {
    return value;
  }
  // Defensive — should never happen given DB constraints
  throw new Error(`Invalid score value: ${value}`);
}

function compositeFor(indicatorCode: string): PublicComposite {
  return DOMESTIC_CODES.has(indicatorCode) ? 'Domestic' : 'External';
}

/**
 * Resolves the 13-indicator array for a scorecard using bulk queries.
 * Uses Postgres DISTINCT ON for latest-per-indicator lookups, reducing
 * query count from ~40 to 4 per scorecard. See Phase 6E-2 for rationale.
 */
async function resolveIndicators(
  observationDate: Date,
  indicatorBreakdown: Record<string, unknown>,
): Promise<PublicIndicator[]> {
  const indicators = await prisma.indicator.findMany({
    where: { tool: 'nifty', isActive: true },
    orderBy: { displayOrder: 'asc' },
  });

  if (indicators.length === 0) return [];

  const indicatorIds = indicators.map((i) => i.id);
  const cpiIndicator = indicators.find((i) => i.code === 'IND_NIFTY_03_CPI');

  const [latestDataPoints, priorDataPoints, priorScores, cpiScore] = await Promise.all([
    prisma.$queryRaw<LatestDataPointRow[]>`
      SELECT DISTINCT ON (dp.indicator_id)
        dp.indicator_id,
        dp.id,
        dp.observation_date,
        dp.value,
        dp.source,
        dp.data_quality_flag,
        dp.is_current
      FROM data_points dp
      WHERE dp.indicator_id = ANY(${indicatorIds}::text[])
        AND dp.is_current = true
        AND dp.observation_date <= ${observationDate}::date
      ORDER BY dp.indicator_id, dp.observation_date DESC
    `,
    prisma.$queryRaw<PriorDataPointRow[]>`
      WITH latest_per_indicator AS (
        SELECT DISTINCT ON (indicator_id) indicator_id, observation_date
        FROM data_points
        WHERE indicator_id = ANY(${indicatorIds}::text[])
          AND is_current = true
          AND observation_date <= ${observationDate}::date
        ORDER BY indicator_id, observation_date DESC
      )
      SELECT DISTINCT ON (dp.indicator_id)
        dp.indicator_id,
        dp.observation_date,
        dp.value
      FROM data_points dp
      JOIN latest_per_indicator l ON l.indicator_id = dp.indicator_id
      WHERE dp.is_current = true
        AND dp.observation_date < l.observation_date
      ORDER BY dp.indicator_id, dp.observation_date DESC
    `,
    prisma.$queryRaw<PriorScoreRow[]>`
      SELECT DISTINCT ON (s.indicator_id)
        s.indicator_id,
        s.observation_date,
        s.score,
        s.flag
      FROM scores s
      WHERE s.indicator_id = ANY(${indicatorIds}::text[])
        AND s.observation_date < ${observationDate}::date
      ORDER BY s.indicator_id, s.observation_date DESC
    `,
    cpiIndicator
      ? prisma.score.findFirst({
          where: { indicatorId: cpiIndicator.id, observationDate },
          orderBy: { computedAt: 'desc' },
        })
      : Promise.resolve(null),
  ]);

  const latestByIndicator = new Map<string, LatestDataPointRow>(
    latestDataPoints.map((r) => [r.indicator_id, r]),
  );
  const priorByIndicator = new Map<string, PriorDataPointRow>(
    priorDataPoints.map((r) => [r.indicator_id, r]),
  );
  const priorScoreByIndicator = new Map<string, PriorScoreRow>(
    priorScores.map((r) => [r.indicator_id, r]),
  );

  const results: PublicIndicator[] = [];

  for (const ind of indicators) {
    const breakdownEntry = (indicatorBreakdown[ind.code] ?? null) as {
      score: number | null;
      outcome: 'scored' | 'carry_forward' | 'insufficient_data';
      flags: string[];
      reason?: string;
    } | null;

    const currentDp = latestByIndicator.get(ind.id) ?? null;
    const priorDp = priorByIndicator.get(ind.id) ?? null;
    const priorScore = priorScoreByIndicator.get(ind.id) ?? null;

    const currentValue = currentDp ? Number(currentDp.value) : null;
    const priorValue = priorDp ? Number(priorDp.value) : null;

    const formattedValue = formatIndicatorValue(ind.code, currentValue);
    const magnitudeText = formatMagnitude(ind.code, currentValue, priorValue);
    const score = breakdownEntry?.score ?? null;
    const lastChangeDate = currentDp ? toIsoDate(currentDp.observation_date) : '';

    // Extract trajectory_3m_avg for CPI from the score's computationMetadata
    let trajectory3mAvg: string | undefined;
    if (ind.code === 'IND_NIFTY_03_CPI') {
      const cpiMeta = (cpiScore?.computationMetadata ?? {}) as {
        threeMonthAvg?: number;
      };
      if (typeof cpiMeta.threeMonthAvg === 'number') {
        trajectory3mAvg = `${cpiMeta.threeMonthAvg.toFixed(2)}%`;
      }
    }

    const item: PublicIndicator = {
      id: ind.displayOrder ?? 0,
      code: ind.code,
      name: ind.name,
      short: indicatorShortName(ind.code),
      composite: compositeFor(ind.code),
      score: score !== null ? asScore(score) : null,
      value: formattedValue,
      magnitude: magnitudeText,
      last_change_date: lastChangeDate,
      outcome: breakdownEntry?.outcome ?? 'insufficient_data',
      flags: breakdownEntry?.flags ?? [],
      ...(breakdownEntry?.reason ? { reason: breakdownEntry.reason } : {}),
      ...(trajectory3mAvg ? { trajectory_3m_avg: trajectory3mAvg } : {}),
      ...(priorScore !== null ? { prev_score: asScore(priorScore.score) } : {}),
    };

    results.push(item);
  }

  return results;
}

async function mapScorecardToPublic(
  scorecard: {
    id: string;
    observationDate: Date;
    netScore: number;
    domesticScore: number;
    externalScore: number;
    band: string | null;
    ratingLabel: string;
    conflictFlag: boolean;
    ind9RawComposite: number | null;
    compositionFlag: string | null;
    indicatorBreakdown: Prisma.JsonValue;
    specialFlags: Prisma.JsonValue;
    scoreVelocity1d: Prisma.Decimal | null;
    peakScoreCeilingState: Prisma.JsonValue | null;
  },
): Promise<PublicScorecard> {
  const breakdown = (scorecard.indicatorBreakdown ?? {}) as Record<string, unknown>;
  const specialFlags = (scorecard.specialFlags ?? {}) as {
    missingIndicators?: string[];
  };
  const indicators = await resolveIndicators(scorecard.observationDate, breakdown);
  const band = (scorecard.band ?? scorecard.ratingLabel) as PublicBand;

  const peakState = scorecard.peakScoreCeilingState as {
    status?: 'active' | 'inactive';
    peakDate?: string;
    peakNetScore?: number;
  } | null;

  const peakScoreActive = peakState?.status === 'active';
  const peakScorePeakDate =
    peakState?.status === 'active' ? peakState.peakDate : undefined;
  const peakScorePeakValue =
    peakState?.status === 'active' ? peakState.peakNetScore : undefined;

  const velocityShort =
    scorecard.scoreVelocity1d !== null ? Number(scorecard.scoreVelocity1d) : undefined;

  return {
    id: scorecard.id,
    date: toIsoDate(scorecard.observationDate),
    indicators,
    domestic_composite: scorecard.domesticScore,
    external_composite: scorecard.externalScore,
    net_score: scorecard.netScore,
    band,
    ind9_raw_composite: scorecard.ind9RawComposite,
    ind9_sub_indicators: {}, // Populated when EdgeFinder lands
    composition_flag: scorecard.compositionFlag as PublicCompositionFlag,
    peak_score_active: peakScoreActive,
    ...(peakScorePeakDate !== undefined ? { peak_score_peak_date: peakScorePeakDate } : {}),
    ...(peakScorePeakValue !== undefined ? { peak_score_peak_value: peakScorePeakValue } : {}),
    ...(velocityShort !== undefined ? { velocity_short: velocityShort } : {}),
    conflict_flag: scorecard.conflictFlag,
    catalysts: [],
    missing_indicators: specialFlags.missingIndicators ?? [],
  };
}

export async function getLatestScorecard(): Promise<PublicScorecard> {
  const scorecard = await prisma.niftyScorecard.findFirst({
    where: { isCurrent: true },
    orderBy: { observationDate: 'desc' },
  });

  if (!scorecard) {
    throw new AppError(
      404,
      'No scorecards exist yet. Run /api/admin/scorecard/assemble first.',
      'NO_SCORECARDS',
    );
  }

  return mapScorecardToPublic(scorecard);
}

export async function getScorecardByDate(
  observationDate: Date,
): Promise<PublicScorecard> {
  const scorecard = await prisma.niftyScorecard.findFirst({
    where: { observationDate, isCurrent: true },
    orderBy: { vintageDate: 'desc' },
  });

  if (!scorecard) {
    throw new AppError(
      404,
      `No scorecard for ${toIsoDate(observationDate)}`,
      'SCORECARD_NOT_FOUND',
    );
  }

  return mapScorecardToPublic(scorecard);
}

export interface ScorecardHistoryParams {
  from?: Date;
  to?: Date;
  limit?: number;
  includeBreakdown?: boolean;
}

export async function getScorecardHistory(
  params: ScorecardHistoryParams,
): Promise<{
  items: PublicScorecard[] | PublicScorecardHistoryItem[];
  count: number;
  limit: number;
}> {
  const limit = Math.min(params.limit ?? HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT);

  const where: Prisma.NiftyScorecardWhereInput = {
    isCurrent: true,
    ...(params.from || params.to
      ? {
          observationDate: {
            ...(params.from ? { gte: params.from } : {}),
            ...(params.to ? { lte: params.to } : {}),
          },
        }
      : {}),
  };

  const scorecards = await prisma.niftyScorecard.findMany({
    where,
    orderBy: { observationDate: 'desc' },
    take: limit,
  });

  if (params.includeBreakdown) {
    const full: PublicScorecard[] = [];
    for (const sc of scorecards) {
      full.push(await mapScorecardToPublic(sc));
    }
    return { items: full, count: full.length, limit };
  }

  const items: PublicScorecardHistoryItem[] = scorecards.map((sc) => {
    const peakState = sc.peakScoreCeilingState as {
      status?: 'active' | 'inactive';
    } | null;
    return {
      id: sc.id,
      date: toIsoDate(sc.observationDate),
      net_score: sc.netScore,
      domestic_composite: sc.domesticScore,
      external_composite: sc.externalScore,
      band: (sc.band ?? sc.ratingLabel) as PublicBand,
      conflict_flag: sc.conflictFlag,
      composition_flag: sc.compositionFlag as PublicCompositionFlag,
      peak_score_active: peakState?.status === 'active',
      ind9_raw_composite: sc.ind9RawComposite,
    };
  });

  return { items, count: items.length, limit };
}

export async function getIndicators(): Promise<PublicIndicatorMetadata[]> {
  const indicators = await prisma.indicator.findMany({
    where: { tool: 'nifty' },
    orderBy: { displayOrder: 'asc' },
  });

  const indicatorIds = indicators.map((i) => i.id);

  const lastUpdatedRows =
    indicatorIds.length > 0
      ? await prisma.$queryRaw<IndicatorLastUpdatedRow[]>`
          SELECT DISTINCT ON (dp.indicator_id)
            dp.indicator_id,
            dp.observation_date
          FROM data_points dp
          WHERE dp.indicator_id = ANY(${indicatorIds}::text[])
            AND dp.is_current = true
          ORDER BY dp.indicator_id, dp.observation_date DESC
        `
      : [];

  const lastUpdatedByIndicator = new Map<string, Date>(
    lastUpdatedRows.map((r) => [r.indicator_id, r.observation_date]),
  );

  return indicators.map((ind) => {
    const lastUpdated = lastUpdatedByIndicator.get(ind.id);
    return {
      id: ind.displayOrder ?? 0,
      code: ind.code,
      name: ind.name,
      short: indicatorShortName(ind.code),
      composite: compositeFor(ind.code),
      output_range: indicatorOutputRange(ind.code),
      cadence: ind.frequency,
      data_source: describeDataSource(ind.dataSource),
      unit: ind.unit,
      description: ind.description,
      last_updated: lastUpdated ? toIsoDate(lastUpdated) : null,
      is_active: ind.isActive,
    };
  });
}

export interface IndicatorDetailParams {
  code: string;
  includeHistory?: boolean;
}

export async function getIndicatorDetail(
  params: IndicatorDetailParams,
): Promise<PublicIndicatorDetail> {
  const ind = await prisma.indicator.findUnique({ where: { code: params.code } });
  if (!ind) {
    throw new AppError(404, `Indicator not found: ${params.code}`, 'INDICATOR_NOT_FOUND');
  }

  const latestDp = await prisma.dataPoint.findFirst({
    where: { indicatorId: ind.id, isCurrent: true },
    orderBy: { observationDate: 'desc' },
  });

  const latestScore = await prisma.score.findFirst({
    where: { indicatorId: ind.id },
    orderBy: { observationDate: 'desc' },
  });

  const detail: PublicIndicatorDetail = {
    id: ind.displayOrder ?? 0,
    code: ind.code,
    name: ind.name,
    short: indicatorShortName(ind.code),
    composite: compositeFor(ind.code),
    output_range: indicatorOutputRange(ind.code),
    cadence: ind.frequency,
    data_source: describeDataSource(ind.dataSource),
    unit: ind.unit,
    description: ind.description,
    last_updated: latestDp ? toIsoDate(latestDp.observationDate) : null,
    is_active: ind.isActive,
    latest_score: latestScore !== null ? asScore(latestScore.score) : null,
    latest_value: latestDp
      ? formatIndicatorValue(ind.code, Number(latestDp.value))
      : null,
    latest_value_raw: latestDp ? Number(latestDp.value) : null,
    latest_observation_date: latestDp ? toIsoDate(latestDp.observationDate) : null,
  };

  if (params.includeHistory) {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - INDICATOR_HISTORY_DAYS);

    const recentScores = await prisma.score.findMany({
      where: {
        indicatorId: ind.id,
        observationDate: { gte: since },
      },
      orderBy: { observationDate: 'desc' },
      take: INDICATOR_HISTORY_DAYS,
    });

    const recentDataPoints = await prisma.dataPoint.findMany({
      where: {
        indicatorId: ind.id,
        isCurrent: true,
        observationDate: { gte: since },
      },
      orderBy: { observationDate: 'desc' },
      take: INDICATOR_HISTORY_DAYS,
    });

    detail.recent_scores = recentScores.map((s) => ({
      date: toIsoDate(s.observationDate),
      score: asScore(s.score),
      value: '', // Could join with data_point here if needed
      flags: s.flag ? s.flag.split(',') : [],
    }));

    detail.recent_data_points = recentDataPoints.map((dp) => ({
      date: toIsoDate(dp.observationDate),
      value: Number(dp.value),
      source: dp.source,
      is_revised: dp.dataQualityFlag === 'revised',
    }));
  }

  return detail;
}

export interface AdminLogsQueryParams {
  jobName?: string;
  status?: string;
  triggerType?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

export async function getAdminLogs(
  params: AdminLogsQueryParams,
): Promise<PublicAdminLogsResponse> {
  const limit = Math.min(params.limit ?? LOGS_DEFAULT_LIMIT, LOGS_MAX_LIMIT);
  const offset = Math.max(params.offset ?? 0, 0);

  const where: Prisma.DataFetchLogWhereInput = {
    ...(params.jobName ? { jobName: { contains: params.jobName, mode: 'insensitive' } } : {}),
    ...(params.status ? { status: params.status as FetchStatus } : {}),
    ...(params.triggerType ? { triggerType: params.triggerType as FetchTriggerType } : {}),
    ...(params.from || params.to
      ? {
          startedAt: {
            ...(params.from ? { gte: params.from } : {}),
            ...(params.to ? { lte: params.to } : {}),
          },
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.dataFetchLog.count({ where }),
    prisma.dataFetchLog.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      take: limit,
      skip: offset,
    }),
  ]);

  const logs: PublicAdminLogEntry[] = rows.map((row) => ({
    id: row.id,
    jobName: row.jobName,
    triggerType: row.triggerType,
    triggeredBy: null,
    status: row.status,
    startedAt: toIsoDateTime(row.startedAt),
    completedAt: row.completedAt ? toIsoDateTime(row.completedAt) : null,
    durationMs: row.completedAt
      ? row.completedAt.getTime() - row.startedAt.getTime()
      : null,
    rowsInserted: row.rowsInserted ?? 0,
    rowsUpdated: row.rowsUpdated ?? 0,
    rowsSkipped: row.rowsSkipped ?? 0,
    targetDateFrom: row.targetDateFrom ? toIsoDate(row.targetDateFrom) : null,
    targetDateTo: row.targetDateTo ? toIsoDate(row.targetDateTo) : null,
    metadata: (row.metadata ?? null) as Record<string, unknown> | null,
    errors: (row.errors ?? null) as unknown[] | null,
  }));

  return { totalCount: total, limit, offset, logs };
}
