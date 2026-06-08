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
} from './oracle.types';
import {
  scoreToFrontendBias,
  clampCotValue,
  scoreToIndicatorValue,
  pairScoreToIndicatorValue,
  compute12WeekHistory,
  computePair12WeekHistory,
  isStale,
  formatDateShort,
  formatPercentWithSign,
  formatIndicatorValue,
  computeSurprise,
  computeNextRelease,
  INDICATOR_SLOT,
  EMPTY_INDICATOR_SLOTS,
  PAIR_ROW_TO_SLOT,
  uiGroupToSectionLabel,
  uiGroupToHeatmapCategory,
  SECTION_COLORS,
  dbFrequencyToHeatmapFrequency,
  ORACLE_ASSETS,
  FX_PAIR_META,
  SCORECARD_KEY_TO_ASSET_CODE,
  SCORECARD_ASSET_META,
  COT_ASSETS,
} from './oracle-mappers';

export const oracleRouter = Router();

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
    const allCodes = ORACLE_ASSETS.map((a) => a.dbCode);
    const assetRecords = await prisma.asset.findMany({ where: { code: { in: allCodes } } });
    const assetByCode = new Map(assetRecords.map((a) => [a.code, a]));

    const fxCodes = ['EURUSD', 'GBPUSD', 'USDJPY', 'EURJPY', 'GBPJPY'];
    const fxPairIds = fxCodes
      .map((c) => assetByCode.get(c)?.id)
      .filter((id): id is string => id !== undefined);

    const [pairScoreRows, xauScorecardResult] = await Promise.all([
      prisma.edgefinderPairScore.findMany({
        where: { pairId: { in: fxPairIds }, isCurrent: true },
        orderBy: { scoreDate: 'desc' },
        select: {
          pairId: true,
          totalScore: true,
          pairCotScore: true,
          rowBreakdown: true,
        },
      }),
      (async () => {
        const xauAsset = assetByCode.get('XAUUSD');
        if (!xauAsset) return null;
        return prisma.edgefinderScorecard.findFirst({
          where: { assetId: xauAsset.id, isCurrent: true },
          orderBy: { observationDate: 'desc' },
          select: { totalScore: true, cotScore: true, indicatorBreakdown: true },
        });
      })(),
    ]);

    const latestPairScore = new Map<string, (typeof pairScoreRows)[0]>();
    for (const ps of pairScoreRows) {
      if (!latestPairScore.has(ps.pairId)) latestPairScore.set(ps.pairId, ps);
    }

    const result: AssetData[] = ORACLE_ASSETS.map((meta) => {
      const asset = assetByCode.get(meta.dbCode);
      const base = {
        asset: meta.code,
        type: meta.type,
        flag: meta.flag,
      };

      if (meta.type === 'Forex' && asset) {
        const ps = latestPairScore.get(asset.id);
        if (!ps) {
          return {
            ...base, score: null, bias: null, cot: null, ...EMPTY_INDICATOR_SLOTS,
            outcome: 'insufficient_data' as const,
            reason: 'No pair score computed yet for this FX pair',
          };
        }
        const rows = parseArray<RowBreakdownEntry>(ps.rowBreakdown);
        const slots = { ...EMPTY_INDICATOR_SLOTS };
        for (const row of rows) {
          const slotKey = PAIR_ROW_TO_SLOT[row.rowName];
          if (slotKey !== undefined) {
            // When both sides are absent the indicator doesn't apply to this pair
            // (e.g. PCE/NFP/ADP/JOLTS/Claims on EURJPY or GBPJPY). The scoring
            // engine keeps rowIncluded=true with pairScore=0 for these, so we
            // must check outcomes rather than rowIncluded to distinguish
            // "both absent → null" from "genuinely neutral → 0".
            const bothAbsent =
              row.indicatorA.outcome === 'absent' &&
              row.indicatorB.outcome === 'absent';
            slots[slotKey] = bothAbsent
              ? null
              : pairScoreToIndicatorValue(row.pairScore, row.rowIncluded);
          }
        }
        return {
          ...base,
          score: ps.totalScore,
          bias: scoreToFrontendBias(ps.totalScore),
          cot: clampCotValue(ps.pairCotScore),
          ...slots,
          outcome: 'scored' as const,
          reason: null,
        };
      }

      // Forex asset not in DB (shouldn't occur in practice)
      if (meta.type === 'Forex') {
        return {
          ...base, score: null, bias: null, cot: null, ...EMPTY_INDICATOR_SLOTS,
          outcome: 'insufficient_data' as const,
          reason: 'FX pair not found in database',
        };
      }

      if (meta.code === 'XAUUSD' && xauScorecardResult) {
        const entries = parseArray<IndicatorBreakdownEntry>(xauScorecardResult.indicatorBreakdown);
        const slots = { ...EMPTY_INDICATOR_SLOTS };
        for (const entry of entries) {
          if (entry.isCot) continue;
          const slotKey = INDICATOR_SLOT[entry.indicatorCode];
          if (slotKey !== undefined) {
            slots[slotKey] = scoreToIndicatorValue(entry.score, entry.outcome);
          }
        }
        return {
          ...base,
          score: xauScorecardResult.totalScore,
          bias: scoreToFrontendBias(xauScorecardResult.totalScore),
          cot: clampCotValue(xauScorecardResult.cotScore),
          ...slots,
          outcome: 'scored' as const,
          reason: null,
        };
      }

      if (meta.code === 'XAUUSD') {
        return {
          ...base, score: null, bias: null, cot: null, ...EMPTY_INDICATOR_SLOTS,
          outcome: 'insufficient_data' as const,
          reason: 'No scorecard computed for Gold yet',
        };
      }

      // SPY, NAS100 — deferred pending backtesting
      return {
        ...base, score: null, bias: null, cot: null, ...EMPTY_INDICATOR_SLOTS,
        outcome: 'deferred' as const,
        reason: 'Scoring deferred pending backtesting. Activation planned post-v1.',
      };
    });

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// GET /api/oracle/scorecard?asset=USD
// ============================================================================

const scorecardQuerySchema = z.object({
  asset: z.enum(['USD', 'EUR', 'GBP', 'JPY', 'Gold', 'SPY', 'NAS100']),
});

async function buildCotDetail(assetCode: string, cotScoreFromScorecard: number): Promise<CotDetail> {
  const asset = await prisma.asset.findFirst({ where: { code: assetCode } });
  if (!asset) {
    return { netPositioning: 'Neutral', weeklyChange: 'Neutral', cotScore: cotScoreFromScorecard, longPct: '—', shortPct: '—', deltaWeekly: '—' };
  }
  const cotRow = await prisma.cotData.findFirst({
    where: { assetId: asset.id, isCurrent: true },
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
    const assetKey = parsed.data.asset as ScorecardAssetKey;
    const dbCode = SCORECARD_KEY_TO_ASSET_CODE[assetKey];
    const meta = SCORECARD_ASSET_META[assetKey];

    // Deferred assets — short-circuit before any DB query
    if (assetKey === 'SPY' || assetKey === 'NAS100') {
      const deferred: ScorecardAsset = {
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
        outcome: 'deferred',
        reason: 'Scoring deferred pending backtesting. Activation planned post-v1.',
      };
      res.json({ success: true, data: deferred });
      return;
    }

    const assetRecord = await prisma.asset.findFirst({ where: { code: dbCode } });
    if (!assetRecord) {
      throw new AppError(404, `Asset not found: ${dbCode}`, 'ASSET_NOT_FOUND');
    }

    const scorecard = await prisma.edgefinderScorecard.findFirst({
      where: { assetId: assetRecord.id, isCurrent: true },
      orderBy: { observationDate: 'desc' },
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
          observationDate: true,
          value: true,
          forecastValue: true,
          previousValue: true,
        },
      }),
      buildCotDetail(dbCode, scorecard.cotScore),
      compute12WeekHistory(assetRecord.id, now),
    ]);

    const indicatorByCode = new Map(indicatorRecords.map((i) => [i.code, i]));
    const dpByIndicatorId = new Map<string, (typeof dataPointRows)[0]>();
    for (const dp of dataPointRows) {
      if (!dpByIndicatorId.has(dp.indicatorId)) dpByIndicatorId.set(dp.indicatorId, dp);
    }

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

      const stale = dp ? isStale(dp.observationDate, now) : false;

      const isInsufficient = entry.outcome === 'insufficient_data' || entry.outcome === 'absent';
      const indicatorOutcome: 'scored' | 'insufficient_data' | 'stale' = isInsufficient
        ? 'insufficient_data'
        : stale ? 'stale' : 'scored';

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
        ...(stale && dp ? { staleDate: formatDateShort(dp.observationDate) } : {}),
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
    const allCodes = COT_ASSETS.map((a) => a.dbCode);
    const assetRecords = await prisma.asset.findMany({ where: { code: { in: allCodes } } });
    const assetByCode = new Map(assetRecords.map((a) => [a.code, a]));
    // Only the non-deferred COT instruments carry cot_data / scorecard rows.
    const dataAssetIds = COT_ASSETS.filter((m) => !m.deferred)
      .map((m) => assetByCode.get(m.dbCode)?.id)
      .filter((id): id is string => id !== undefined);

    const fourWeeksAgo = new Date();
    fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 35); // ~5 weeks buffer

    const [cotRows, cotHistoryRows, scorecardRows] = await Promise.all([
      prisma.cotData.findMany({
        where: { assetId: { in: dataAssetIds }, isCurrent: true },
        orderBy: { reportDate: 'desc' },
        select: {
          assetId: true,
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
        where: { assetId: { in: dataAssetIds }, reportDate: { gte: fourWeeksAgo } },
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

    const result: CotAsset[] = COT_ASSETS.map((meta) => {
      // Deferred instruments (SPY, NAS100) — no CFTC ingestion yet.
      if (meta.deferred) {
        return {
          asset: meta.code,
          flag: meta.flag,
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
          scoreTooltip: 'Scoring deferred pending backtesting',
          trend: null,
          outcome: 'deferred' as const,
          reason: 'Scoring deferred pending backtesting. Activation planned post-v1.',
        };
      }

      const asset = assetByCode.get(meta.dbCode);
      const cot = asset ? latestCot.get(asset.id) : undefined;

      if (!asset || !cot) {
        return {
          asset: meta.code,
          flag: meta.flag,
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
        flag: meta.flag,
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

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// GET /api/oracle/heatmap
// ============================================================================

oracleRouter.get('/heatmap', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const countries = ['US', 'EU', 'UK', 'JP'];
    const assetCodeByCountry: Record<string, string> = { US: 'USD', EU: 'EUR', UK: 'GBP', JP: 'JPY' };

    const [indicators, scorecardAssets] = await Promise.all([
      prisma.indicator.findMany({
        where: { tool: 'edgefinder', isActive: true, country: { in: countries } },
        orderBy: [{ country: 'asc' }, { uiGroup: 'asc' }, { code: 'asc' }],
      }),
      prisma.asset.findMany({
        where: { code: { in: ['USD', 'EUR', 'GBP', 'JPY'] } },
        select: { id: true, code: true },
      }),
    ]);

    const indicatorIds = indicators.map((i) => i.id);
    const assetByCode = new Map(scorecardAssets.map((a) => [a.code, a]));
    const scorecardAssetIds = scorecardAssets.map((a) => a.id);

    const [dataPointRows, scorecardRows] = await Promise.all([
      prisma.dataPoint.findMany({
        where: { indicatorId: { in: indicatorIds }, isCurrent: true },
        orderBy: { observationDate: 'desc' },
        select: {
          indicatorId: true,
          observationDate: true,
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

    const dpByIndicatorId = new Map<string, (typeof dataPointRows)[0]>();
    for (const dp of dataPointRows) {
      if (!dpByIndicatorId.has(dp.indicatorId)) dpByIndicatorId.set(dp.indicatorId, dp);
    }

    // Build code → score map from latest scorecards
    const latestScorecard = new Map<string, (typeof scorecardRows)[0]>();
    for (const sc of scorecardRows) {
      if (!latestScorecard.has(sc.assetId)) latestScorecard.set(sc.assetId, sc);
    }

    const indicatorScoreMap = new Map<string, { score: number | null; outcome: string; reason: string | null }>();
    for (const country of countries) {
      const assetCode = assetCodeByCountry[country];
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
    const grouped: HeatmapResponse = { US: [], EU: [], UK: [], JP: [] };

    for (const ind of indicators) {
      const country = ind.country as 'US' | 'EU' | 'UK' | 'JP';
      const category = uiGroupToHeatmapCategory(ind.uiGroup);
      if (!category) continue;

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
      const nextRelease = isDaily
        ? 'Daily'
        : isEventDriven
          ? '—'
          : dp ? computeNextRelease(dp.observationDate, freq) : '—';

      const stale = dp && !isDaily ? isStale(dp.observationDate, now) : false;

      const isInsufficient = !scoreEntry
        || scoreEntry.outcome === 'insufficient_data'
        || scoreEntry.outcome === 'absent';

      const score: 1 | 0 | -1 | null = isInsufficient
        ? null
        : toNullableScore(scoreEntry!.score, scoreEntry!.outcome);

      const outcome: 'scored' | 'insufficient_data' | 'stale' = isInsufficient
        ? 'insufficient_data'
        : stale ? 'stale' : 'scored';

      const reason: string | null = isInsufficient
        ? (scoreEntry?.reason ?? 'No data ingested')
        : null;

      grouped[country].push({
        name: ind.name,
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
        ...(stale ? { stale: true } : {}),
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
  pair: z.enum(['EURUSD', 'GBPUSD', 'USDJPY', 'EURJPY', 'GBPJPY']).optional(),
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
  const pairMeta = FX_PAIR_META[pairCode];
  if (!pairMeta) return null;

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
      select: { indicatorId: true, value: true, forecastValue: true },
    }),
    buildFxCotSide(pairMeta.base),
    buildFxCotSide(pairMeta.quote),
  ]);

  // const indById = new Map(indicatorRecords.map((i) => [i.id, i]));
  const indByCode = new Map(indicatorRecords.map((i) => [i.code, i]));
  const dpByIndicatorId = new Map<string, (typeof dataPointRows)[0]>();
  for (const dp of dataPointRows) {
    if (!dpByIndicatorId.has(dp.indicatorId)) dpByIndicatorId.set(dp.indicatorId, dp);
  }

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

    return {
      result,
      actual: actualNum !== null ? formatIndicatorValue(side.code, actualNum) : null,
      ...(forecastNum !== null ? { forecast: formatIndicatorValue(side.code, forecastNum) } : {}),
      ...(forecastNum !== null && actualNum !== null
        ? { surprise: computeSurprise(side.code, actualNum, forecastNum) ?? undefined }
        : {}),
      outcome: 'scored',
    };
  }

  // Group rows into categories
  const categoryMap = new Map<'ECONOMIC GROWTH' | 'INFLATION' | 'JOBS MARKET', FxIndicatorRow[]>();

  for (const row of rows) {
    const categoryLabel = uiGroupToHeatmapCategory(row.uiGroup);
    if (!categoryLabel) continue;

    const fxRow: FxIndicatorRow = {
      name: row.rowName,
      currA: buildIndicatorSide(row.indicatorA),
      currB: buildIndicatorSide(row.indicatorB),
      pairScore: row.rowIncluded ? row.pairScore : null,
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
  };
}

oracleRouter.get('/fx-scorecard', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = fxScorecardQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, 'Invalid query params', 'VALIDATION_ERROR', parsed.error.flatten());
    }

    const now = new Date();
    const requestedPair = parsed.data.pair as FxPairKey | undefined;
    const pairCodes: FxPairKey[] = requestedPair
      ? [requestedPair]
      : ['EURUSD', 'GBPUSD', 'USDJPY', 'EURJPY', 'GBPJPY'];

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
