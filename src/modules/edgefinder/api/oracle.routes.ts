import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { AppError } from '@core/middleware/error-handler';
import type {
  AssetData,
  ScorecardAsset,
  ScorecardAssetKey,
  ScorecardSection,
  ScorecardIndicator,
  CotDetail,
  CotAsset,
  CotScore,
  HeatmapResponse,
  FxPairData,
  FxPairKey,
  FxCategoryCard,
  FxIndicatorRow,
  FxCotSide,
  ResultTag,
  HistoryRange,
  ScoreHistoryResponse,
  ScoreHistoryPoint,
  ScoreHistoryBreakdownEntry,
  IndicatorHistoryResponse,
  IndicatorHistoryPoint,
  CotHistoryResponse,
  CotHistoryPoint,
  CycleStancesResponse,
  CycleStanceEntry,
  NextReleaseInfo,
} from './oracle.types';
import {
  scoreToFrontendBias,
  clampCotValue,
  scoreToIndicatorValue,
  pairScoreToIndicatorValue,
  compute12WeekHistory,
  computePair12WeekHistory,
  isAging,
  formatDateShort,
  formatPercentWithSign,
  formatIndicatorValue,
  computeSurprise,
  INDICATOR_SLOT,
  EMPTY_INDICATOR_SLOTS,
  PAIR_ROW_TO_SLOT,
  uiGroupToSectionLabel,
  uiGroupToHeatmapCategory,
  SECTION_COLORS,
  dbFrequencyToHeatmapFrequency,
} from './oracle-mappers';
import { getCompassSnapshot } from '@modules/edgefinder/services/compass/compass-public.service';
import { calendarEventsRepository } from '@core/repositories/calendar-events.repository';
import { findOverdueByIndicatorCodes } from '@modules/edgefinder/services/overdue-resolver';
import {
  getInstrumentRegistry,
  requireScorecardAsset,
  requirePair,
  requireScoreSubject,
  requireCotAsset,
} from './instrument-registry';
import { buildDataHealth, EMPTY_DATA_HEALTH } from './data-health';
import { collapseToLatestReleasePerIndicator } from '@core/repositories/latest-release-by-indicator';

export const oracleRouter = Router();

// ============================================================================
// GET /api/oracle/compass
// Full Compass snapshot (current regime, 6 input votes, score impact, 30-day
// audit history) assembled in one batched, indexed read. The classifier writes
// once per day, so the payload is identical for every user — a short private
// cache + SWR keeps repeat loads off the DB. Returns data:null before the first
// classification exists (fresh DB), which the client renders as an empty state.
// ============================================================================
oracleRouter.get('/compass', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const snapshot = await getCompassSnapshot();
    res.set('Cache-Control', 'private, max-age=120, stale-while-revalidate=300');
    res.json({ success: true, data: snapshot });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// JSON breakdown helpers — typed views of Prisma.JsonValue
// ============================================================================

interface IndicatorBreakdownEntry {
  indicatorCode: string;
  score: number | null;
  uiGroup: string | null;
  isCot: boolean;
  outcome: 'scored' | 'carry_forward' | 'insufficient_data' | 'absent';
  reason: string | null;
}

interface RowBreakdownSide {
  code: string | null;
  score: number;
  outcome: string;
  direction: string | null;
}

interface RowBreakdownEntry {
  rowName: string;
  uiGroup: string;
  indicatorA: RowBreakdownSide;
  indicatorB: RowBreakdownSide;
  pairScore: number;
  notes: string | null;
  rowIncluded: boolean;
}

interface CotBreakdownSide {
  label: string | null;
  weeklyChangePct: number | null;
}

interface CotBreakdownEntry {
  pairCotScore: number;
  baseSide: CotBreakdownSide;
  quoteSide: CotBreakdownSide;
}

function parseArray<T>(json: Prisma.JsonValue | null | undefined): T[] {
  if (Array.isArray(json)) return json as unknown as T[];
  return [];
}

function parseObject<T>(json: Prisma.JsonValue | null | undefined): T | null {
  if (json !== null && json !== undefined && typeof json === 'object' && !Array.isArray(json)) {
    return json as unknown as T;
  }
  return null;
}

function toScore(score: number | null): 1 | 0 | -1 {
  if (score === null || score === 0) return 0;
  return score > 0 ? 1 : -1;
}

/** Returns null for insufficient_data/absent outcomes; otherwise maps score to 1|0|-1. */
function toNullableScore(
  score: number | null,
  outcome: string,
): 1 | 0 | -1 | null {
  if (outcome === 'insufficient_data' || outcome === 'absent') return null;
  return toScore(score);
}

function toResultTag(score: number, outcome: string): ResultTag {
  if (outcome === 'absent' || outcome === 'insufficient_data') return 'N/A';
  if (score > 0) return 'BEAT';
  if (score < 0) return 'MISS';
  return 'MET';
}

function toCotLabel(label: string | null): 'Bullish' | 'Bearish' | 'Neutral' {
  if (label === 'Bullish') return 'Bullish';
  if (label === 'Bearish') return 'Bearish';
  return 'Neutral';
}

// ============================================================================
// GET /api/oracle/assets
// ============================================================================

oracleRouter.get('/assets', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Phase 3: the screener universe comes from the registry. Inactive assets
    // (SPY/NAS100/US30) and unmapped ones (DXY) are excluded by construction.
    const registry = await getInstrumentRegistry();
    const screener = registry.screener;

    const allCodes = screener.map((a) => a.code);
    const assetRecords = await prisma.asset.findMany({ where: { code: { in: allCodes } } });
    const assetByCode = new Map(assetRecords.map((a) => [a.code, a]));

    const fxPairIds = screener
      .filter((a) => a.type === 'Forex')
      .map((a) => assetByCode.get(a.code)?.id)
      .filter((id): id is string => id !== undefined);

    const [pairScoreRows, scorecardRows] = await Promise.all([
      prisma.edgefinderPairScore.findMany({
        where: { pairId: { in: fxPairIds }, isCurrent: true },
        orderBy: { scoreDate: 'desc' },
        select: {
          pairId: true,
          scoreDate: true,
          totalScore: true,
          pairCotScore: true,
          rowBreakdown: true,
        },
      }),
      (async () => {
        const nonPairIds = screener
          .filter((a) => a.type !== 'Forex')
          .map((a) => assetByCode.get(a.code)?.id)
          .filter((id): id is string => id !== undefined);
        if (nonPairIds.length === 0) return [];
        return prisma.edgefinderScorecard.findMany({
          where: { assetId: { in: nonPairIds }, isCurrent: true },
          orderBy: { observationDate: 'desc' },
          select: {
            assetId: true, totalScore: true, cotScore: true,
            indicatorBreakdown: true, observationDate: true,
          },
        });
      })(),
    ]);
    const latestScorecard = new Map<string, (typeof scorecardRows)[0]>();
    for (const sc of scorecardRows) {
      if (!latestScorecard.has(sc.assetId)) latestScorecard.set(sc.assetId, sc);
    }

    // Global "last updated" = the most recent underlying score date across all
    // assets shown in the table (FX pair scoreDates + scorecard dates).
    let lastUpdatedDate: Date | null = null;
    for (const sc of scorecardRows) {
      if (!lastUpdatedDate || sc.observationDate > lastUpdatedDate) lastUpdatedDate = sc.observationDate;
    }
    for (const ps of pairScoreRows) {
      if (!lastUpdatedDate || ps.scoreDate > lastUpdatedDate) lastUpdatedDate = ps.scoreDate;
    }
    const lastUpdated = lastUpdatedDate ? lastUpdatedDate.toISOString() : null;

    const asOf = lastUpdatedDate ?? new Date();

    const latestPairScore = new Map<string, (typeof pairScoreRows)[0]>();
    for (const ps of pairScoreRows) {
      if (!latestPairScore.has(ps.pairId)) latestPairScore.set(ps.pairId, ps);
    }

    const built = await Promise.all(
      screener.map(async (meta): Promise<Omit<AssetData, 'lastUpdated'>> => {
        const asset = assetByCode.get(meta.code);
        const base = { asset: meta.code, type: meta.type, flag: meta.flag };
        const empty = {
          ...base, score: null, bias: null, cot: null, ...EMPTY_INDICATOR_SLOTS,
          inapplicableSlots: [] as string[], dataHealth: { ...EMPTY_DATA_HEALTH },
        };

        if (meta.type === 'Forex' && asset) {
          const ps = latestPairScore.get(asset.id);
          if (!ps) {
            return {
              ...empty,
              outcome: 'insufficient_data' as const,
              reason: 'No pair score computed yet for this FX pair',
            };
          }
          const rows = parseArray<RowBreakdownEntry>(ps.rowBreakdown);
          const slots = { ...EMPTY_INDICATOR_SLOTS };
          const inapplicableSlots: string[] = [];
          const codes: string[] = [];
          const insufficient: string[] = [];

          for (const row of rows) {
            const slotKey = PAIR_ROW_TO_SLOT[row.rowName];
            for (const side of [row.indicatorA, row.indicatorB]) {
              if (!side.code) continue;
              codes.push(side.code);
              if (side.outcome === 'insufficient_data') insufficient.push(side.code);
            }
            if (slotKey === undefined) continue;

            // Three distinct nulls, kept distinct:
            //   - hard-excluded  (rowIncluded=false)  -> row not in this pair
            //   - both sides absent (soft "dead" row) -> row inapplicable here
            //   - genuinely neutral                   -> 0
            const bothAbsent =
              row.indicatorA.outcome === 'absent' && row.indicatorB.outcome === 'absent';
            if (!row.rowIncluded || bothAbsent) {
              slots[slotKey] = null;
              inapplicableSlots.push(slotKey);
              continue;
            }
            slots[slotKey] = pairScoreToIndicatorValue(row.pairScore, row.rowIncluded);
          }

          return {
            ...base,
            score: ps.totalScore,
            bias: scoreToFrontendBias(ps.totalScore),
            cot: clampCotValue(ps.pairCotScore),
            ...slots,
            inapplicableSlots: [...new Set(inapplicableSlots)].sort(),
            dataHealth: await buildDataHealth(codes, insufficient, asOf),
            outcome: 'scored' as const,
            reason: null,
          };
        }

        if (meta.type === 'Forex') {
          return {
            ...empty,
            outcome: 'insufficient_data' as const,
            reason: 'FX pair not found in database',
          };
        }

        const sc = asset ? latestScorecard.get(asset.id) : undefined;
        if (!sc) {
          return {
            ...empty,
            outcome: 'insufficient_data' as const,
            reason: `No scorecard computed for ${meta.name} yet`,
          };
        }

        const entries = parseArray<IndicatorBreakdownEntry>(sc.indicatorBreakdown);
        const slots = { ...EMPTY_INDICATOR_SLOTS };
        const codes: string[] = [];
        const insufficient: string[] = [];
        for (const entry of entries) {
          if (entry.isCot) continue;
          codes.push(entry.indicatorCode);
          if (entry.outcome === 'insufficient_data') insufficient.push(entry.indicatorCode);
          const slotKey = INDICATOR_SLOT[entry.indicatorCode];
          if (slotKey !== undefined) {
            slots[slotKey] = scoreToIndicatorValue(entry.score, entry.outcome);
          }
        }
        return {
          ...base,
          score: sc.totalScore,
          bias: scoreToFrontendBias(sc.totalScore),
          cot: clampCotValue(sc.cotScore),
          ...slots,
          inapplicableSlots: [],
          dataHealth: await buildDataHealth(codes, insufficient, asOf),
          outcome: 'scored' as const,
          reason: null,
        };
      }),
    );

    const result: AssetData[] = built.map((row) => ({ ...row, lastUpdated }));

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// GET /api/oracle/scorecard-subjects
// ============================================================================
//
// Issue 1 fix: the Asset Scorecard picker previously derived from
// /api/oracle/assets (the screener projection — Forex pairs, Gold, indices;
// it has NEVER contained standalone currencies) filtered to non-Forex, which
// only ever left Gold and the indices once Phase 7 removed the picker's own
// hardcoded currency list. The scorecard endpoint's actual valid-subject set
// is registry.scorecardByKey (every asset with >= 1 asset_indicator_map row —
// currencies + Gold — the same set requireScorecardAsset validates against
// below). No endpoint exposed that set as a list before this; this is that
// endpoint, so the frontend can derive the picker from it instead of holding
// its own list.
oracleRouter.get('/scorecard-subjects', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const registry = await getInstrumentRegistry();
    const data = [...registry.scorecardByKey.values()]
      .map((i) => ({ key: i.key, name: i.scorecardName, flag: i.scorecardFlag || i.flag, type: i.type }))
      .sort((a, b) => a.key.localeCompare(b.key));
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// GET /api/oracle/scorecard?asset=USD
// ============================================================================

// Phase 3: the asset param is validated against the registry at runtime rather
// than a hardcoded enum, so a newly registered asset is accepted immediately and
// an unknown one gets a 400 naming it.
const scorecardQuerySchema = z.object({
  asset: z.string().min(1),
});

async function buildCotDetail(assetId: string, cotScoreFromScorecard: number): Promise<CotDetail> {
  const cotRow = await prisma.cotData.findFirst({
    where: { assetId, isCurrent: true },
    orderBy: { reportDate: 'desc' },
    select: { netPositioningLabel: true, changeLabel: true, longPct: true, shortPct: true, weeklyChangePct: true },
  });
  if (!cotRow) {
    return { netPositioning: 'Neutral', weeklyChange: 'Neutral', cotScore: cotScoreFromScorecard, longPct: '—', shortPct: '—', deltaWeekly: '—' };
  }
  return {
    netPositioning: toCotLabel(cotRow.netPositioningLabel),
    weeklyChange: toCotLabel(cotRow.changeLabel),
    cotScore: cotScoreFromScorecard,
    longPct: cotRow.longPct ? `${Number(cotRow.longPct).toFixed(1)}%` : '—',
    shortPct: cotRow.shortPct ? `${Number(cotRow.shortPct).toFixed(1)}%` : '—',
    deltaWeekly: cotRow.weeklyChangePct ? formatPercentWithSign(Number(cotRow.weeklyChangePct)) : '—',
  };
}

oracleRouter.get('/scorecard', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = scorecardQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, 'Missing or invalid asset query param', 'VALIDATION_ERROR', parsed.error.flatten());
    }
    // Throws 400 naming the code when the asset is not a registered, active,
    // mapped EdgeFinder asset. SPY/NAS100/US30 land here while isActive=false.
    const instrument = await requireScorecardAsset(parsed.data.asset);
    const assetKey = instrument.key as ScorecardAssetKey;
    const dbCode = instrument.code;
    const meta = { name: instrument.scorecardName, flag: instrument.scorecardFlag };

    const assetRecord = await prisma.asset.findFirst({ where: { code: dbCode } });
    if (!assetRecord) {
      throw new AppError(404, `Asset not found: ${dbCode}`, 'ASSET_NOT_FOUND');
    }

    const scorecard = await prisma.edgefinderScorecard.findFirst({
      where: { assetId: assetRecord.id, isCurrent: true },
      orderBy: { observationDate: 'desc' },
      // Only the fields this handler reads — avoids pulling the large
      // cotBreakdown / compassOverridesApplied JSON blobs.
      select: {
        totalScore: true,
        fundamentalsScore: true,
        cotScore: true,
        indicatorBreakdown: true,
        observationDate: true,
      },
    });

    const now = new Date();

    if (!scorecard) {
      const noData: ScorecardAsset = {
        key: assetKey,
        name: meta.name,
        flag: meta.flag,
        totalScore: null,
        fundamentals: null,
        cotScore: null,
        bias: null,
        cot: null,
        sections: [],
        scoreHistory: null,
        outcome: 'insufficient_data',
        reason: 'Scorecard not yet computed for this asset',
        lastUpdated: null,
      };
      res.json({ success: true, data: noData });
      return;
    }

    const breakdown = parseArray<IndicatorBreakdownEntry>(scorecard.indicatorBreakdown);
    const fundamentalEntries = breakdown.filter((e) => !e.isCot);
    const indicatorCodes = fundamentalEntries.map((e) => e.indicatorCode);

    const [indicatorRecords, dataPointRows, cotDetail, scoreHistory] = await Promise.all([
      prisma.indicator.findMany({
        where: { code: { in: indicatorCodes } },
        select: { id: true, code: true, name: true },
      }),
      prisma.dataPoint.findMany({
        where: {
          indicator: { code: { in: indicatorCodes } },
          isCurrent: true,
        },
        orderBy: { observationDate: 'desc' },
        select: {
          indicatorId: true,
          variant: true,
          observationDate: true,
          vintageDate: true,
          value: true,
          forecastValue: true,
          previousValue: true,
        },
      }),
      buildCotDetail(assetRecord.id, scorecard.cotScore),
      compute12WeekHistory(assetRecord.id, now),
    ]);

    const indicatorByCode = new Map(indicatorRecords.map((i) => [i.code, i]));
    // Most-recent-release wins when an indicator has more than one isCurrent
    // row for the same latest observationDate (Flash + Final coexisting) —
    // see B3/collapseToLatestReleasePerIndicator.
    const dpByIndicatorId = await collapseToLatestReleasePerIndicator(dataPointRows);

    // B1 — overdue is per-event, so a single indicator can carry more than
    // one overdue occurrence (Flash overdue AND Final overdue). The row only
    // needs to know THAT it's overdue, not which occurrence — any() suffices
    // here; the badge/panel is what needs the individual events.
    const overdueByCode = await findOverdueByIndicatorCodes(indicatorCodes, now);

    const sectionMap = new Map<
      'ECONOMIC GROWTH' | 'INFLATION' | 'JOBS MARKET',
      ScorecardIndicator[]
    >();

    for (const entry of fundamentalEntries) {
      const sectionLabel = uiGroupToSectionLabel(entry.uiGroup ?? '');
      if (!sectionLabel) continue;

      const indRecord = indicatorByCode.get(entry.indicatorCode);
      if (!indRecord) continue;

      const dp = dpByIndicatorId.get(indRecord.id);
      const actualNum = dp ? Number(dp.value) : null;
      const forecastNum = dp?.forecastValue !== null && dp?.forecastValue !== undefined
        ? Number(dp.forecastValue)
        : null;
      const previousNum = dp?.previousValue !== null && dp?.previousValue !== undefined
        ? Number(dp.previousValue)
        : null;

      const aging = dp ? isAging(dp.observationDate, now) : false;

      const isInsufficient = entry.outcome === 'insufficient_data' || entry.outcome === 'absent';
      const indicatorOutcome: 'scored' | 'insufficient_data' | 'aging' = isInsufficient
        ? 'insufficient_data'
        : aging ? 'aging' : 'scored';

      const indicator: ScorecardIndicator = {
        name: indRecord.name,
        actual: isInsufficient ? null : (actualNum !== null ? formatIndicatorValue(entry.indicatorCode, actualNum) : null),
        forecast: isInsufficient ? null : (forecastNum !== null ? formatIndicatorValue(entry.indicatorCode, forecastNum) : null),
        previous: isInsufficient ? null : (previousNum !== null ? formatIndicatorValue(entry.indicatorCode, previousNum) : null),
        surprise: isInsufficient ? null : (forecastNum !== null && actualNum !== null
          ? computeSurprise(entry.indicatorCode, actualNum, forecastNum) ?? null
          : null),
        score: isInsufficient ? null : toNullableScore(entry.score, entry.outcome),
        outcome: indicatorOutcome,
        reason: isInsufficient ? (entry.reason ?? 'No data ingested') : null,
        ...(aging && dp ? { agingDate: formatDateShort(dp.observationDate) } : {}),
        ...((overdueByCode.get(entry.indicatorCode)?.length ?? 0) > 0 ? { overdue: true } : {}),
      };

      if (!sectionMap.has(sectionLabel)) sectionMap.set(sectionLabel, []);
      sectionMap.get(sectionLabel)!.push(indicator);
    }

    const SECTION_ORDER = ['ECONOMIC GROWTH', 'INFLATION', 'JOBS MARKET'] as const;
    const sections: ScorecardSection[] = SECTION_ORDER
      .filter((label) => sectionMap.has(label))
      .map((label) => {
        const indicators = sectionMap.get(label)!;
        return {
          label,
          color: SECTION_COLORS[label],
          subtotal: indicators.reduce((sum, i) => sum + (i.score ?? 0), 0),
          indicators,
        };
      });

    const response: ScorecardAsset = {
      key: assetKey,
      name: meta.name,
      flag: meta.flag,
      totalScore: scorecard.totalScore,
      fundamentals: scorecard.fundamentalsScore,
      cotScore: scorecard.cotScore,
      bias: scoreToFrontendBias(scorecard.totalScore),
      cot: cotDetail,
      sections,
      scoreHistory,
      outcome: 'scored',
      reason: null,
      lastUpdated: scorecard.observationDate.toISOString(),
    };

    res.json({ success: true, data: response });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// GET /api/oracle/cot
// ============================================================================

oracleRouter.get('/cot', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Phase 3: derived from assets holding a cotContractCode. The filter is
    // ACTIVE as well as has-a-code — SPY/NAS100/US30 gained contract codes in
    // Phase 1 but are still isActive=false, so they are excluded here rather
    // than surfacing as deferred rows.
    const registry = await getInstrumentRegistry();
    const cotInstruments = registry.cot;

    const allCodes = cotInstruments.map((a) => a.code);
    const assetRecords = await prisma.asset.findMany({ where: { code: { in: allCodes } } });
    const assetByCode = new Map(assetRecords.map((a) => [a.code, a]));
    const dataAssetIds = cotInstruments
      .map((m) => assetByCode.get(m.code)?.id)
      .filter((id): id is string => id !== undefined);

    const fourWeeksAgo = new Date();
    fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 35); // ~5 weeks buffer

    const [cotRows, cotHistoryRows, scorecardRows] = await Promise.all([
      prisma.cotData.findMany({
        where: { assetId: { in: dataAssetIds }, isCurrent: true },
        orderBy: { reportDate: 'desc' },
        select: {
          assetId: true,
          reportDate: true,
          releaseDate: true,
          longContracts: true,
          shortContracts: true,
          changeInLongContracts: true,
          changeInShortContracts: true,
          longPct: true,
          shortPct: true,
          weeklyChangePct: true,
          netPositioningLabel: true,
          changeLabel: true,
        },
      }),
      prisma.cotData.findMany({
        // isCurrent guard: without it, revised (vintage-flipped) rows would
        // double-count a week in the 4-week trend sparkline.
        where: { assetId: { in: dataAssetIds }, isCurrent: true, reportDate: { gte: fourWeeksAgo } },
        orderBy: { reportDate: 'asc' },
        select: { assetId: true, weeklyChangePct: true },
      }),
      prisma.edgefinderScorecard.findMany({
        where: { assetId: { in: dataAssetIds }, isCurrent: true },
        orderBy: { observationDate: 'desc' },
        select: { assetId: true, cotScore: true },
      }),
    ]);

    const latestCot = new Map<string, (typeof cotRows)[0]>();
    for (const row of cotRows) {
      if (!latestCot.has(row.assetId)) latestCot.set(row.assetId, row);
    }

    // Global "Data as of / Released" = the most recent CFTC report across all
    // tracked instruments (all assets in a given release share these dates).
    let latestReport: { reportDate: Date; releaseDate: Date } | null = null;
    for (const row of latestCot.values()) {
      if (!latestReport || row.reportDate > latestReport.reportDate) {
        latestReport = { reportDate: row.reportDate, releaseDate: row.releaseDate };
      }
    }
    const dataAsOf = latestReport ? latestReport.reportDate.toISOString() : null;
    const releasedOn = latestReport ? latestReport.releaseDate.toISOString() : null;

    const trendMap = new Map<string, number[]>();
    for (const h of cotHistoryRows) {
      if (!trendMap.has(h.assetId)) trendMap.set(h.assetId, []);
      trendMap.get(h.assetId)!.push(Number(h.weeklyChangePct ?? 0));
    }

    // COT score comes from each instrument's asset scorecard (USD/EUR/GBP/JPY/XAUUSD).
    const cotScoreByAssetId = new Map<string, number>();
    for (const sc of scorecardRows) {
      if (!cotScoreByAssetId.has(sc.assetId)) cotScoreByAssetId.set(sc.assetId, sc.cotScore);
    }

    const built = cotInstruments.map((meta): Omit<CotAsset, 'dataAsOf' | 'releasedOn'> => {
      const asset = assetByCode.get(meta.code);
      const cot = asset ? latestCot.get(asset.id) : undefined;

      if (!asset || !cot) {
        return {
          asset: meta.code,
          flag: meta.cotFlag,
          type: meta.type,
          longContracts: null,
          shortContracts: null,
          deltaLong: null,
          deltaShort: null,
          longPct: null,
          shortPct: null,
          netPctChange: null,
          netPosition: null,
          cotScore: null,
          scoreTooltip: 'No COT data available',
          trend: null,
          outcome: 'insufficient_data' as const,
          reason: 'CFTC weekly COT report not yet ingested for this asset',
        };
      }

      const rawTrend = trendMap.get(asset.id) ?? [];
      const trend = rawTrend.slice(-4);
      while (trend.length < 4) trend.unshift(0);

      const cotScoreRaw = cotScoreByAssetId.get(asset.id) ?? 0;
      const cotScore = clampCotValue(cotScoreRaw) as CotScore;

      const longContracts = cot.longContracts ?? 0;
      const shortContracts = cot.shortContracts ?? 0;
      const netLabel = toCotLabel(cot.netPositioningLabel);
      const changeLabel = toCotLabel(cot.changeLabel);
      const scoreTooltip = `Net ${netLabel.toLowerCase()}; weekly change ${changeLabel.toLowerCase()}. COT score: ${cotScoreRaw >= 0 ? '+' : ''}${cotScoreRaw}`;

      return {
        asset: meta.code,
        flag: meta.cotFlag,
        type: meta.type,
        longContracts,
        shortContracts,
        deltaLong: cot.changeInLongContracts ?? 0,
        deltaShort: cot.changeInShortContracts ?? 0,
        longPct: Number(cot.longPct ?? 0),
        shortPct: Number(cot.shortPct ?? 0),
        netPctChange: Number(cot.weeklyChangePct ?? 0),
        netPosition: longContracts - shortContracts,
        cotScore,
        scoreTooltip,
        trend,
        outcome: 'scored' as const,
        reason: null,
      };
    });

    const result: CotAsset[] = built.map((row) => ({ ...row, dataAsOf, releasedOn }));

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// GET /api/oracle/heatmap
// ============================================================================

// Issue 2 fix: currency asset code -> heatmap economy key. Membership (which
// currencies exist) is still fully registry-derived below; this only decides
// the display key for each one. GBP -> "UK" is the only non-trivial entry —
// the rest just drop the trailing letter. A currency with no entry here
// falls back to its own code, so a newly registered currency still gets a
// group instead of being dropped.
const HEATMAP_ECONOMY_KEY: Record<string, string> = { USD: 'US', EUR: 'EU', GBP: 'UK', JPY: 'JP', AUD: 'AU' };
function heatmapEconomyKeyForAsset(assetCode: string): string {
  return HEATMAP_ECONOMY_KEY[assetCode] ?? assetCode;
}

oracleRouter.get('/heatmap', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Issue 2: group by the asset an indicator belongs to (asset_indicator_map),
    // not by the indicator's raw country field — the same fix Phase 6 applied
    // to the admin panel and Phase 2 applied to the scoring layer. AUD owns
    // both AU (ten Australian indicators) and CN (the RatingDog China PMI,
    // scored to AUD as a demand proxy) — grouping by raw country produced a
    // phantom "CN" economy holding just that one indicator; grouping by owning
    // ASSET correctly folds both into a single AUD/"AU" economy. COT
    // pseudo-rows are excluded via the is_cot flag.
    const registry = await getInstrumentRegistry();
    const currencyCodes = [...registry.scorecardByKey.values()]
      .filter((i) => i.assetClass === 'currency')
      .map((i) => i.code);

    const mapRows = await prisma.assetIndicatorMap.findMany({
      where: {
        isCot: false,
        asset: { code: { in: currencyCodes } },
        indicator: { tool: 'edgefinder', isActive: true },
      },
      select: { asset: { select: { code: true } }, indicatorId: true },
    });

    const assetCodeByIndicatorId = new Map<string, string>();
    for (const m of mapRows) {
      if (!assetCodeByIndicatorId.has(m.indicatorId)) assetCodeByIndicatorId.set(m.indicatorId, m.asset.code);
    }
    const indicatorIds = [...assetCodeByIndicatorId.keys()];
    const assetCodesInUse = [...new Set(assetCodeByIndicatorId.values())].sort();
    const countries = assetCodesInUse.map(heatmapEconomyKeyForAsset);

    const [indicators, scorecardAssets] = await Promise.all([
      prisma.indicator.findMany({
        where: { id: { in: indicatorIds } },
        orderBy: [{ uiGroup: 'asc' }, { code: 'asc' }],
      }),
      prisma.asset.findMany({
        where: { code: { in: assetCodesInUse } },
        select: { id: true, code: true },
      }),
    ]);

    const assetByCode = new Map(scorecardAssets.map((a) => [a.code, a]));
    const scorecardAssetIds = scorecardAssets.map((a) => a.id);

    const [dataPointRows, scorecardRows] = await Promise.all([
      prisma.dataPoint.findMany({
        where: { indicatorId: { in: indicatorIds }, isCurrent: true },
        orderBy: { observationDate: 'desc' },
        select: {
          indicatorId: true,
          variant: true,
          observationDate: true,
          vintageDate: true,
          value: true,
          forecastValue: true,
          previousValue: true,
        },
      }),
      prisma.edgefinderScorecard.findMany({
        where: { assetId: { in: scorecardAssetIds }, isCurrent: true },
        orderBy: { observationDate: 'desc' },
        select: { assetId: true, indicatorBreakdown: true },
      }),
    ]);

    // Most-recent-release wins when an indicator has more than one isCurrent
    // row for the same latest observationDate (Flash + Final coexisting).
    const dpByIndicatorId = await collapseToLatestReleasePerIndicator(dataPointRows);

    // Build code → score map from latest scorecards
    const latestScorecard = new Map<string, (typeof scorecardRows)[0]>();
    for (const sc of scorecardRows) {
      if (!latestScorecard.has(sc.assetId)) latestScorecard.set(sc.assetId, sc);
    }

    const indicatorScoreMap = new Map<string, { score: number | null; outcome: string; reason: string | null }>();
    for (const assetCode of assetCodesInUse) {
      const asset = assetByCode.get(assetCode);
      if (!asset) continue;
      const sc = latestScorecard.get(asset.id);
      if (!sc) continue;
      const breakdown = parseArray<IndicatorBreakdownEntry>(sc.indicatorBreakdown);
      for (const entry of breakdown) {
        if (!entry.isCot && !indicatorScoreMap.has(entry.indicatorCode)) {
          indicatorScoreMap.set(entry.indicatorCode, {
            score: entry.score,
            outcome: entry.outcome,
            reason: entry.reason ?? null,
          });
        }
      }
    }

    const now = new Date();

    // B1/B4: nextRelease derives from stored calendar_events, never from
    // frequency arithmetic. One batched query for every indicator on the
    // heatmap (NIFTY indicators are structurally absent from `indicators`
    // here — this route only ever loads tool:'edgefinder' rows — so there is
    // no NIFTY branch to write; a code with no stored future event is simply
    // absent from the returned map, same as any other unresolved code).
    const nextReleaseByCode = await calendarEventsRepository.findNextByIndicatorCodes(
      indicators.map((i) => i.code),
      now,
    );

    // B1 — overdue: a specific scheduled release passed with no matching
    // entry. Independent of `aging` below (see the shared comment on
    // isAging in oracle-mappers.ts). NIFTY indicators never appear in
    // `indicators` here (edgefinder-only route), so they never enter this
    // lookup and are structurally never overdue — no special-casing needed.
    const overdueByCode = await findOverdueByIndicatorCodes(
      indicators.map((i) => i.code),
      now,
    );

    // Seeded from the asset-derived economy-key list rather than a fixed
    // four keys, so a newly onboarded currency gets its own group instead of
    // pushing onto undefined.
    const grouped: HeatmapResponse = {};
    for (const c of countries) grouped[c] = [];

    for (const ind of indicators) {
      const ownerAssetCode = assetCodeByIndicatorId.get(ind.id);
      if (!ownerAssetCode) continue; // not reached: indicatorIds is itself derived from this map
      const economyKey = heatmapEconomyKeyForAsset(ownerAssetCode);
      const category = uiGroupToHeatmapCategory(ind.uiGroup);
      if (!category) continue;

      // Issue 2: label the cross-country proxy clearly rather than hide the
      // country distinction — the indicator's own name is untouched (still
      // "RatingDog China Manufacturing PMI" per Phase 6's rename); only the
      // heatmap row label gets the suffix, so it's obvious why a
      // China-country indicator sits inside the AUD/"AU" economy.
      const displayName = ind.country === 'CN' && ownerAssetCode !== 'CN' ? `${ind.name} (AUD proxy)` : ind.name;

      const dp = dpByIndicatorId.get(ind.id);
      const scoreEntry = indicatorScoreMap.get(ind.code);
      const freq = ind.frequency as string;
      const isDaily = freq === 'daily';
      const isEventDriven = freq === 'event_driven';

      const actualNum = dp ? Number(dp.value) : null;
      const forecastNum = dp?.forecastValue !== null && dp?.forecastValue !== undefined
        ? Number(dp.forecastValue)
        : null;
      const previousNum = dp?.previousValue !== null && dp?.previousValue !== undefined
        ? Number(dp.previousValue)
        : null;

      const lastRelease = isDaily
        ? 'Daily'
        : dp ? formatDateShort(dp.observationDate) : '—';

      // B1: the next scheduled occurrence of any variant, from calendar_events
      // — not derived from lastRelease + frequency. Null is the honest,
      // common answer: the feed is current-week-only, so most indicators have
      // no future event stored at any given moment. isDaily/isEventDriven
      // indicators simply never have a calendar_events row (no FF release
      // maps to them), so they fall out of the same null path with no
      // special-casing needed here — unlike the old arithmetic, which had to
      // hand-write a 'Daily'/'—' branch for exactly those two cases.
      const nextCalendarEvent = nextReleaseByCode.get(ind.code);
      const nextRelease: NextReleaseInfo | null = nextCalendarEvent
        ? { scheduledAt: nextCalendarEvent.scheduledAt.toISOString(), variant: nextCalendarEvent.variant }
        : null;

      const aging = dp && !isDaily ? isAging(dp.observationDate, now) : false;

      const isInsufficient = !scoreEntry
        || scoreEntry.outcome === 'insufficient_data'
        || scoreEntry.outcome === 'absent';

      const score: 1 | 0 | -1 | null = isInsufficient
        ? null
        : toNullableScore(scoreEntry!.score, scoreEntry!.outcome);

      const outcome: 'scored' | 'insufficient_data' | 'aging' = isInsufficient
        ? 'insufficient_data'
        : aging ? 'aging' : 'scored';

      const reason: string | null = isInsufficient
        ? (scoreEntry?.reason ?? 'No data ingested')
        : null;

      grouped[economyKey].push({
        code: ind.code,
        name: displayName,
        frequency: dbFrequencyToHeatmapFrequency(isEventDriven ? 'monthly' : freq),
        category,
        lastRelease,
        nextRelease,
        actual: isInsufficient ? null : (actualNum !== null ? formatIndicatorValue(ind.code, actualNum) : null),
        forecast: isInsufficient ? null : (forecastNum !== null ? formatIndicatorValue(ind.code, forecastNum) : null),
        previous: isInsufficient ? null : (previousNum !== null ? formatIndicatorValue(ind.code, previousNum) : null),
        surprise: isInsufficient ? null : (forecastNum !== null && actualNum !== null
          ? computeSurprise(ind.code, actualNum, forecastNum) ?? null
          : null),
        score,
        outcome,
        reason,
        ...(aging ? { aging: true } : {}),
        ...((overdueByCode.get(ind.code)?.length ?? 0) > 0 ? { overdue: true } : {}),
      });
    }

    res.json({ success: true, data: grouped });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// GET /api/oracle/fx-scorecard?pair=EURUSD  (omit pair= to get all 5)
// ============================================================================

const fxScorecardQuerySchema = z.object({
  // Phase 3: validated against the registry at runtime, not a fixed enum.
  pair: z.string().min(1).optional(),
});

async function buildFxCotSide(
  currencyCode: string,
): Promise<FxCotSide> {
  const asset = await prisma.asset.findFirst({ where: { code: currencyCode } });
  if (!asset) {
    return { longPct: '—', shortPct: '—', changePct: '—', direction: 'Neutral' };
  }
  const cotRow = await prisma.cotData.findFirst({
    where: { assetId: asset.id, isCurrent: true },
    orderBy: { reportDate: 'desc' },
    select: { longPct: true, shortPct: true, weeklyChangePct: true, netPositioningLabel: true },
  });
  if (!cotRow) {
    return { longPct: '—', shortPct: '—', changePct: '—', direction: 'Neutral' };
  }
  return {
    longPct: cotRow.longPct ? `${Number(cotRow.longPct).toFixed(1)}%` : '—',
    shortPct: cotRow.shortPct ? `${Number(cotRow.shortPct).toFixed(1)}%` : '—',
    changePct: cotRow.weeklyChangePct ? formatPercentWithSign(Number(cotRow.weeklyChangePct)) : '—',
    direction: toCotLabel(cotRow.netPositioningLabel),
  };
}

async function buildFxPairData(
  pairCode: FxPairKey,
  pairAssetId: string,
  now: Date,
): Promise<FxPairData | null> {
  const registry = await getInstrumentRegistry();
  const instrument = registry.pairs.get(pairCode);
  if (!instrument || !instrument.base || !instrument.quote) return null;
  const baseCcy = registry.byCode.get(instrument.base);
  const quoteCcy = registry.byCode.get(instrument.quote);
  const pairMeta = {
    label: instrument.scorecardName,
    base: instrument.base,
    quote: instrument.quote,
    currAName: instrument.base,
    currAFlag: baseCcy?.flag ?? '',
    currBName: instrument.quote,
    currBFlag: quoteCcy?.flag ?? '',
  };

  const pairScoreRow = await prisma.edgefinderPairScore.findFirst({
    where: { pairId: pairAssetId, isCurrent: true },
    orderBy: { scoreDate: 'desc' },
  });

  if (!pairScoreRow) {
    return {
      key: pairCode,
      label: pairMeta.label,
      currAName: pairMeta.currAName,
      currAFlag: pairMeta.currAFlag,
      currBName: pairMeta.currBName,
      currBFlag: pairMeta.currBFlag,
      totalScore: null,
      fundamentals: null,
      cotScore: null,
      bias: null,
      cotA: null,
      cotB: null,
      cotNote: null,
      categories: [],
      scoreHistory: null,
      outcome: 'insufficient_data' as const,
      reason: 'No pair score computed yet for this FX pair',
      lastUpdated: null,
    };
  }

  const rows = parseArray<RowBreakdownEntry>(pairScoreRow.rowBreakdown);
  const cotBreakdown = parseObject<CotBreakdownEntry>(pairScoreRow.cotBreakdown ?? null);

  // Collect all indicator codes to batch-fetch data points
  const indicatorCodes = new Set<string>();
  for (const row of rows) {
    if (row.indicatorA.code) indicatorCodes.add(row.indicatorA.code);
    if (row.indicatorB.code) indicatorCodes.add(row.indicatorB.code);
  }

  const [scoreHistory, indicatorRecords, dataPointRows, cotA, cotB] = await Promise.all([
    computePair12WeekHistory(pairAssetId, now),
    prisma.indicator.findMany({
      where: { code: { in: Array.from(indicatorCodes) } },
      select: { id: true, code: true, frequency: true },
    }),
    prisma.dataPoint.findMany({
      where: {
        indicator: { code: { in: Array.from(indicatorCodes) } },
        isCurrent: true,
      },
      orderBy: { observationDate: 'desc' },
      select: {
        indicatorId: true,
        variant: true,
        observationDate: true,
        vintageDate: true,
        value: true,
        forecastValue: true,
      },
    }),
    buildFxCotSide(pairMeta.base),
    buildFxCotSide(pairMeta.quote),
  ]);

  // const indById = new Map(indicatorRecords.map((i) => [i.id, i]));
  const indByCode = new Map(indicatorRecords.map((i) => [i.code, i]));
  // Most-recent-release wins when an indicator has more than one isCurrent
  // row for the same latest observationDate (Flash + Final coexisting).
  const dpByIndicatorId = await collapseToLatestReleasePerIndicator(dataPointRows);

  // Brought in line with the asset scorecard and heatmap — this row previously
  // had no aging or overdue concept at all.
  const overdueByCode = await findOverdueByIndicatorCodes(Array.from(indicatorCodes), now);

  function buildIndicatorSide(
    side: RowBreakdownSide,
  ): FxIndicatorRow['currA'] {
    const result = toResultTag(side.score, side.outcome);
    const isNa = result === 'N/A';

    if (!side.code || isNa) {
      return { result: 'N/A', actual: null, outcome: 'insufficient_data' };
    }

    const indRecord = indByCode.get(side.code);
    const dp = indRecord ? dpByIndicatorId.get(indRecord.id) : undefined;
    const actualNum = dp ? Number(dp.value) : null;
    const forecastNum = dp?.forecastValue !== null && dp?.forecastValue !== undefined
      ? Number(dp.forecastValue)
      : null;
    // frequency is not daily-excluded here the way the heatmap does (isDaily
    // guard) because this row shape carries no `frequency` per side to check
    // — aging is computed the same way the asset scorecard does (any dp).
    const aging = dp ? isAging(dp.observationDate, now) : false;
    const overdue = (overdueByCode.get(side.code)?.length ?? 0) > 0;

    return {
      result,
      actual: actualNum !== null ? formatIndicatorValue(side.code, actualNum) : null,
      ...(forecastNum !== null ? { forecast: formatIndicatorValue(side.code, forecastNum) } : {}),
      ...(forecastNum !== null && actualNum !== null
        ? { surprise: computeSurprise(side.code, actualNum, forecastNum) ?? undefined }
        : {}),
      outcome: aging ? 'aging' : 'scored',
      ...(aging && dp ? { agingDate: formatDateShort(dp.observationDate) } : {}),
      ...(overdue ? { overdue: true } : {}),
    };
  }

  // Group rows into categories
  const categoryMap = new Map<'ECONOMIC GROWTH' | 'INFLATION' | 'JOBS MARKET', FxIndicatorRow[]>();

  for (const row of rows) {
    const categoryLabel = uiGroupToHeatmapCategory(row.uiGroup);
    if (!categoryLabel) continue;

    // Phase 3 row visibility.
    // HARD-excluded (rowIncluded=false): the row is not part of this pair's
    // template at all — Tokyo Core CPI in EURUSD, AU Employment Change in
    // USDJPY. It is omitted entirely rather than rendered as an empty line.
    if (!row.rowIncluded) continue;

    // SOFT-excluded: the row is in the template but neither side supplies an
    // indicator (the five USD-only rows in a pair with no USD). It stays
    // visible scoring 0, flagged so a consumer can tell "does not apply here"
    // from "data came in neutral" — both of which are pairScore 0.
    const inapplicable =
      row.indicatorA.outcome === 'absent' && row.indicatorB.outcome === 'absent';

    const fxRow: FxIndicatorRow = {
      name: row.rowName,
      currA: buildIndicatorSide(row.indicatorA),
      currB: buildIndicatorSide(row.indicatorB),
      pairScore: row.pairScore,
      inapplicable,
    };

    if (!categoryMap.has(categoryLabel)) categoryMap.set(categoryLabel, []);
    categoryMap.get(categoryLabel)!.push(fxRow);
  }

  const CAT_ORDER = ['ECONOMIC GROWTH', 'INFLATION', 'JOBS MARKET'] as const;
  const categories: FxCategoryCard[] = CAT_ORDER
    .filter((label) => categoryMap.has(label))
    .map((label) => {
      const indicators = categoryMap.get(label)!;
      const subtotal = indicators.reduce((sum, r) => sum + (r.pairScore ?? 0), 0);
      return {
        label,
        color: SECTION_COLORS[label],
        subtotal,
        indicators,
      };
    });

  // COT note
  const baseDir = cotA.direction.toLowerCase();
  const quoteDir = cotB.direction.toLowerCase();
  const cotNote = `${pairMeta.currAName} net ${baseDir}; ${pairMeta.currBName} net ${quoteDir}. Pair COT score: ${pairScoreRow.pairCotScore >= 0 ? '+' : ''}${pairScoreRow.pairCotScore}`;

  // Suppress unused var warning — cotBreakdown is available if more detail needed later
  void cotBreakdown;

  return {
    key: pairCode,
    label: pairMeta.label,
    currAName: pairMeta.currAName,
    currAFlag: pairMeta.currAFlag,
    currBName: pairMeta.currBName,
    currBFlag: pairMeta.currBFlag,
    totalScore: pairScoreRow.totalScore,
    fundamentals: pairScoreRow.basePairScore,
    cotScore: pairScoreRow.pairCotScore,
    bias: scoreToFrontendBias(pairScoreRow.totalScore),
    cotA,
    cotB,
    cotNote,
    categories,
    scoreHistory,
    outcome: 'scored' as const,
    reason: null,
    lastUpdated: pairScoreRow.scoreDate.toISOString(),
  };
}

oracleRouter.get('/fx-scorecard', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = fxScorecardQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, 'Invalid query params', 'VALIDATION_ERROR', parsed.error.flatten());
    }

    const now = new Date();
    // requirePair throws a 400 naming the code when it is not a registered,
    // active FX pair — so an unknown pair never falls through to a silent 404.
    const requestedPair = parsed.data.pair
      ? ((await requirePair(parsed.data.pair)).code as FxPairKey)
      : undefined;
    const registry = await getInstrumentRegistry();
    const pairCodes: FxPairKey[] = requestedPair
      ? [requestedPair]
      : ([...registry.pairs.values()]
          .sort((a, b) => a.screenerOrder - b.screenerOrder || a.code.localeCompare(b.code))
          .map((p) => p.code) as FxPairKey[]);

    const assetRecords = await prisma.asset.findMany({
      where: { code: { in: pairCodes } },
      select: { id: true, code: true },
    });
    const assetByCode = new Map(assetRecords.map((a) => [a.code, a]));

    const results = await Promise.all(
      pairCodes.map(async (code) => {
        const asset = assetByCode.get(code);
        if (!asset) return null;
        return buildFxPairData(code, asset.id, now);
      }),
    );

    const data = results.filter((r): r is FxPairData => r !== null);

    if (requestedPair) {
      if (data.length === 0) {
        throw new AppError(404, `No data for pair: ${requestedPair}`, 'PAIR_NOT_FOUND');
      }
      res.json({ success: true, data: data[0] });
    } else {
      res.json({ success: true, data });
    }
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Dated-history endpoints (Oracle Tools engine) — ADDITIVE, expose-only.
//
// These expose the dated rows already stored in edgefinder_scorecards /
// edgefinder_pair_scores / data_points / cot_data / currency_cycle_stance.
// They do NOT alter the flat 12-week `scoreHistory: number[]` the scorecard
// pages depend on (that path — compute12WeekHistory — is left untouched).
// All are vintage-aware (isCurrent: true), matching the existing reads.
// ============================================================================

/** Maps a UI range to a lookback window in days. */
const RANGE_DAYS: Record<HistoryRange, number> = {
  '1M': 31,
  '3M': 93,
  '6M': 186,
  '1Y': 372,
};

/** Returns the earliest date to include for a given range, relative to now. */
function rangeStart(range: HistoryRange, asOf: Date): Date {
  const d = new Date(asOf);
  d.setUTCDate(d.getUTCDate() - RANGE_DAYS[range]);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** YYYY-MM-DD from a Date (UTC). */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const historyRangeSchema = z
  .enum(['1M', '3M', '6M', '1Y'])
  .default('3M');

// ----------------------------------------------------------------------------
// GET /api/oracle/score-history?subject=USD&range=3M
// Dated total-score series for an asset (USD/EUR/GBP/JPY/Gold) or FX pair
// (EURUSD/GBPUSD/USDJPY/EURJPY/GBPJPY). Asset points carry the per-date
// indicatorBreakdown that produced each score; pair points carry an empty
// breakdown (the row breakdown shape differs and isn't part of this series).
// ----------------------------------------------------------------------------

// Phase 3: subjects are validated against the registry at runtime.
const scoreHistoryQuerySchema = z.object({
  subject: z.string().min(1),
  range: historyRangeSchema,
});

oracleRouter.get('/score-history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = scoreHistoryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, 'Missing or invalid subject/range query param', 'VALIDATION_ERROR', parsed.error.flatten());
    }
    const { subject, range } = parsed.data;
    const now = new Date();
    const from = rangeStart(range, now);
    const { instrument, isPair } = await requireScoreSubject(subject);
    const registry = await getInstrumentRegistry();

    if (isPair) {
      const baseCcy = instrument.base ? registry.byCode.get(instrument.base) : undefined;
      const quoteCcy = instrument.quote ? registry.byCode.get(instrument.quote) : undefined;
      const meta = {
        label: instrument.scorecardName,
        currAFlag: baseCcy?.flag ?? '',
        currBFlag: quoteCcy?.flag ?? '',
      };
      const assetRecord = await prisma.asset.findFirst({ where: { code: subject } });
      if (!assetRecord) {
        throw new AppError(404, `Pair not found: ${subject}`, 'PAIR_NOT_FOUND');
      }
      const rows = await prisma.edgefinderPairScore.findMany({
        where: { pairId: assetRecord.id, isCurrent: true, scoreDate: { gte: from, lte: now } },
        orderBy: { scoreDate: 'asc' },
        select: { scoreDate: true, totalScore: true, basePairScore: true, pairCotScore: true },
      });
      const points: ScoreHistoryPoint[] = rows.map((r) => ({
        date: isoDate(r.scoreDate),
        totalScore: r.totalScore,
        fundamentalsScore: r.basePairScore,
        cotScore: r.pairCotScore,
        bias: scoreToFrontendBias(r.totalScore),
        indicatorBreakdown: [],
      }));
      const response: ScoreHistoryResponse = {
        subject,
        kind: 'pair',
        name: meta.label,
        flag: `${meta.currAFlag}${meta.currBFlag}`,
        range,
        from: points.length ? points[0].date : null,
        to: points.length ? points[points.length - 1].date : null,
        points,
        outcome: points.length ? 'scored' : 'insufficient_data',
        reason: points.length ? null : 'No pair-score history in range',
      };
      res.json({ success: true, data: response });
      return;
    }

    // Asset subject
    const dbCode = instrument.code;
    const meta = { name: instrument.scorecardName, flag: instrument.scorecardFlag };
    const assetRecord = await prisma.asset.findFirst({ where: { code: dbCode } });
    if (!assetRecord) {
      throw new AppError(404, `Asset not found: ${dbCode}`, 'ASSET_NOT_FOUND');
    }
    const rows = await prisma.edgefinderScorecard.findMany({
      where: { assetId: assetRecord.id, isCurrent: true, observationDate: { gte: from, lte: now } },
      orderBy: { observationDate: 'asc' },
      select: {
        observationDate: true,
        totalScore: true,
        fundamentalsScore: true,
        cotScore: true,
        indicatorBreakdown: true,
      },
    });
    const points: ScoreHistoryPoint[] = rows.map((r) => ({
      date: isoDate(r.observationDate),
      totalScore: r.totalScore,
      fundamentalsScore: r.fundamentalsScore,
      cotScore: r.cotScore,
      bias: scoreToFrontendBias(r.totalScore),
      indicatorBreakdown: parseArray<ScoreHistoryBreakdownEntry>(r.indicatorBreakdown),
    }));
    const response: ScoreHistoryResponse = {
      subject,
      kind: 'asset',
      name: meta.name,
      flag: meta.flag,
      range,
      from: points.length ? points[0].date : null,
      to: points.length ? points[points.length - 1].date : null,
      points,
      outcome: points.length ? 'scored' : 'insufficient_data',
      reason: points.length ? null : 'No scorecard history in range',
    };
    res.json({ success: true, data: response });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------------------------
// GET /api/oracle/indicator-history?code=US_CPI_YOY&range=6M
// Dated release series for a single indicator (value / forecast / previous),
// with per-release surprise (actual - forecast). Vintage-aware (isCurrent).
// ----------------------------------------------------------------------------

const indicatorHistoryQuerySchema = z.object({
  code: z.string().min(1).max(50),
  range: historyRangeSchema,
});

oracleRouter.get('/indicator-history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = indicatorHistoryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, 'Missing or invalid code/range query param', 'VALIDATION_ERROR', parsed.error.flatten());
    }
    const { code, range } = parsed.data;
    const now = new Date();
    const from = rangeStart(range, now);

    const indicator = await prisma.indicator.findUnique({
      where: { code },
      select: { id: true, code: true, name: true },
    });
    if (!indicator) {
      throw new AppError(404, `Indicator not found: ${code}`, 'INDICATOR_NOT_FOUND');
    }

    const rows = await prisma.dataPoint.findMany({
      where: { indicatorId: indicator.id, isCurrent: true, observationDate: { gte: from, lte: now } },
      orderBy: { observationDate: 'asc' },
      select: { observationDate: true, value: true, forecastValue: true, previousValue: true },
    });

    const points: IndicatorHistoryPoint[] = rows.map((r) => {
      const value = Number(r.value);
      const forecast = r.forecastValue !== null ? Number(r.forecastValue) : null;
      const previous = r.previousValue !== null ? Number(r.previousValue) : null;
      return {
        date: isoDate(r.observationDate),
        value,
        forecast,
        previous,
        surprise: forecast !== null ? value - forecast : null,
      };
    });

    const response: IndicatorHistoryResponse = {
      code: indicator.code,
      name: indicator.name,
      range,
      from: points.length ? points[0].date : null,
      to: points.length ? points[points.length - 1].date : null,
      points,
      outcome: points.length ? 'scored' : 'insufficient_data',
      reason: points.length ? null : 'No data points in range',
    };
    res.json({ success: true, data: response });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------------------------
// GET /api/oracle/cot-history?asset=USD&range=6M
// Dated CFTC positioning series per asset (USD/EUR/GBP/JPY/Gold). Exposes the
// real historical cot_data rows (multiple reportDates already stored). No
// pair-COT logic is touched — this reads the same single-asset cot_data the
// COT page already uses, just across time. (Recon found no COT pair bug.)
// ----------------------------------------------------------------------------

// Phase 3: validated against the registry's COT set at runtime.
const cotHistoryQuerySchema = z.object({
  asset: z.string().min(1),
  range: historyRangeSchema,
});

oracleRouter.get('/cot-history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = cotHistoryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, 'Missing or invalid asset/range query param', 'VALIDATION_ERROR', parsed.error.flatten());
    }
    const { asset, range } = parsed.data;
    const now = new Date();
    const from = rangeStart(range, now);

    // Gold's cot_data is keyed by XAUUSD; currencies key by their own code.
    const cotInstrument = await requireCotAsset(asset);
    const dbCode = cotInstrument.code;
    const flag = cotInstrument.cotFlag;

    const assetRecord = await prisma.asset.findFirst({ where: { code: dbCode } });
    if (!assetRecord) {
      throw new AppError(404, `Asset not found: ${dbCode}`, 'ASSET_NOT_FOUND');
    }

    const rows = await prisma.cotData.findMany({
      where: { assetId: assetRecord.id, isCurrent: true, reportDate: { gte: from, lte: now } },
      orderBy: { reportDate: 'asc' },
      select: {
        reportDate: true,
        releaseDate: true,
        longContracts: true,
        shortContracts: true,
        longPct: true,
        shortPct: true,
        weeklyChangePct: true,
        netPositioningLabel: true,
        changeLabel: true,
      },
    });

    const toLabel = (l: string | null): 'Bullish' | 'Bearish' | 'Neutral' | null =>
      l === 'Bullish' || l === 'Bearish' || l === 'Neutral' ? l : l === null ? null : 'Neutral';

    const points: CotHistoryPoint[] = rows.map((r) => {
      const longPct = r.longPct !== null ? Number(r.longPct) : null;
      const shortPct = r.shortPct !== null ? Number(r.shortPct) : null;
      return {
        reportDate: isoDate(r.reportDate),
        releaseDate: isoDate(r.releaseDate),
        longContracts: r.longContracts,
        shortContracts: r.shortContracts,
        longPct,
        shortPct,
        netPct: longPct !== null && shortPct !== null ? longPct - shortPct : null,
        weeklyChangePct: r.weeklyChangePct !== null ? Number(r.weeklyChangePct) : null,
        netPositioningLabel: toLabel(r.netPositioningLabel),
        changeLabel: toLabel(r.changeLabel),
      };
    });

    const response: CotHistoryResponse = {
      asset,
      flag,
      range,
      from: points.length ? points[0].reportDate : null,
      to: points.length ? points[points.length - 1].reportDate : null,
      points,
      outcome: points.length ? 'scored' : 'insufficient_data',
      reason: points.length ? null : 'No COT history in range',
    };
    res.json({ success: true, data: response });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------------------------
// GET /api/oracle/cycle-stances
// Active central-bank cycle stance per currency, effective-dated. Mirrors the
// admin read (cycle-stances.routes.ts) but is served under the Oracle router.
//
// NOTE: the Oracle router is mounted with `requireAuth` (app.ts), so this is a
// signed-in read like every other Oracle endpoint — NOT anonymous. A truly
// unauthenticated public route can't be added here without changing the shared
// /api/oracle mount, which is out of scope for this additive pass and would
// affect every existing Oracle read. Flagged in the self-verify report.
// ----------------------------------------------------------------------------

oracleRouter.get('/cycle-stances', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const today = new Date();

    const stances = await prisma.currencyCycleStance.findMany({
      where: {
        effectiveFrom: { lte: today },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }],
      },
      orderBy: [{ currencyCode: 'asc' }, { effectiveFrom: 'desc' }],
    });

    // Deduplicate — keep only the latest active row per currency (mirrors admin).
    const seen = new Set<string>();
    const active = stances.filter((s) => {
      if (seen.has(s.currencyCode)) return false;
      seen.add(s.currencyCode);
      return true;
    });

    const entries: CycleStanceEntry[] = active.map((s) => ({
      currencyCode: s.currencyCode,
      stance: (s.stance === 'CUTTING' || s.stance === 'HIKING' ? s.stance : 'NEUTRAL') as CycleStanceEntry['stance'],
      effectiveFrom: isoDate(s.effectiveFrom),
      effectiveTo: s.effectiveTo ? isoDate(s.effectiveTo) : null,
      notes: s.notes ?? null,
    }));

    const response: CycleStancesResponse = { stances: entries };
    res.json({ success: true, data: response });
  } catch (err) {
    next(err);
  }
});
