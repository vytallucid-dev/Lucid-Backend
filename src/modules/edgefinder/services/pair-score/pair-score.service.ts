import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { AppError } from '@core/middleware/error-handler';
import { scoreIndicator } from '@core/scoring/engine';
import type { ScoringResult } from '@core/scoring/types';
import { classifyChangePercent, combineCotLabelsForPair } from '@core/scoring/handlers/cot';
import type { CotLabel } from '@core/scoring/handlers/cot';
import { compassClassificationsRepository } from '@core/repositories/compass-classifications.repository';
import {
  edgefinderPairScoresRepository,
  type UpsertPairScoreResult,
} from '@core/repositories/edgefinder-pair-scores.repository';
import type { Regime } from '@modules/edgefinder/services/scorecard/compass-overrides';
import { mapScoreToLabel } from '@modules/edgefinder/services/scorecard/asset-scorecard.service';
import {
  loadPairTemplateFromDb,
  getPairDefinition,
  type Currency,
  type PairDefinition,
  type PairRowConfig,
} from './pair-template.config';
import {
  evaluatePairRow,
  type IndicatorScoreSnapshot,
  type PairRowResult,
} from './pair-row-calculator';
import { computePairCompassOverrides } from './pair-compass-overrides';

export interface AssemblePairScoreResult {
  pairScoreId: string;
  pairCode: string;
  scoreDate: Date;
  basePairScore: number;
  pairCotScore: number;
  baseTotal: number;
  compassAdjustment: number;
  totalScore: number;
  ratingLabel: string;
  regime: Regime;
  /** Count of template rows applicable to this pair (rowIncluded=true). */
  rowCount: number;
  /** Count of rows that contributed a non-zero pair score. */
  rowsScored: number;
  action: 'inserted' | 'revised' | 'skipped';
}

interface CotSideSnapshot {
  label: CotLabel | null;
  contractCode: string | null;
  traderCategory: string | null;
  weeklyChangePct: number | null;
  reportDate: string | null;
}

function directionFromMetadata(meta: Record<string, unknown>): string | null {
  const d = meta.direction;
  return typeof d === 'string' ? d : null;
}

async function scoreIndicatorForRow(
  indicatorCode: string,
  scoreDate: Date,
): Promise<IndicatorScoreSnapshot> {
  let result: ScoringResult;
  try {
    result = await scoreIndicator({ indicatorCode, observationDate: scoreDate });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { indicatorCode, message },
      'Pair score: indicator scoring threw — treating as insufficient_data',
    );
    return { indicatorCode, score: 0, direction: null, outcome: 'insufficient_data' };
  }

  if (result.kind === 'insufficient_data') {
    return { indicatorCode, score: 0, direction: null, outcome: 'insufficient_data' };
  }
  if (result.kind === 'carry_forward') {
    return {
      indicatorCode,
      score: result.score,
      direction: directionFromMetadata(result.metadata),
      outcome: 'carry_forward',
    };
  }
  return {
    indicatorCode,
    score: result.score,
    direction: directionFromMetadata(result.metadata),
    outcome: 'scored',
  };
}

async function loadCotChangeLabel(
  currency: Currency,
  scoreDate: Date,
): Promise<CotSideSnapshot> {
  const asset = await prisma.asset.findUnique({
    where: { code: currency },
    select: { metadata: true },
  });
  if (!asset) {
    return {
      label: null,
      contractCode: null,
      traderCategory: null,
      weeklyChangePct: null,
      reportDate: null,
    };
  }
  const meta = (asset.metadata ?? {}) as Prisma.JsonObject;
  const contractCode =
    typeof meta.cotContractCode === 'string' ? meta.cotContractCode : null;
  const traderCategory =
    typeof meta.cotTraderCategory === 'string' ? meta.cotTraderCategory : null;
  if (!contractCode || !traderCategory) {
    return {
      label: null,
      contractCode,
      traderCategory,
      weeklyChangePct: null,
      reportDate: null,
    };
  }

  const cot = await prisma.cotData.findFirst({
    where: {
      contractCode,
      traderCategory,
      isCurrent: true,
      reportDate: { lte: scoreDate },
    },
    orderBy: { reportDate: 'desc' },
  });
  if (!cot || cot.weeklyChangePct === null) {
    return {
      label: null,
      contractCode,
      traderCategory,
      weeklyChangePct: null,
      reportDate: cot?.reportDate?.toISOString().slice(0, 10) ?? null,
    };
  }
  const weeklyChangePct = Number(cot.weeklyChangePct);
  return {
    label: classifyChangePercent(weeklyChangePct),
    contractCode,
    traderCategory,
    weeklyChangePct,
    reportDate: cot.reportDate.toISOString().slice(0, 10),
  };
}

interface RowEvaluationContext {
  pair: PairDefinition;
  scoreDate: Date;
  scoreCache: Map<string, IndicatorScoreSnapshot>;
}

async function getOrFetchScore(
  indicatorCode: string,
  ctx: RowEvaluationContext,
): Promise<IndicatorScoreSnapshot> {
  const cached = ctx.scoreCache.get(indicatorCode);
  if (cached) return cached;
  const fresh = await scoreIndicatorForRow(indicatorCode, ctx.scoreDate);
  ctx.scoreCache.set(indicatorCode, fresh);
  return fresh;
}

async function evaluateRow(
  config: PairRowConfig,
  ctx: RowEvaluationContext,
): Promise<PairRowResult> {
  const baseCode = config.indicators[ctx.pair.base];
  const quoteCode = config.indicators[ctx.pair.quote];
  const baseScore = baseCode ? await getOrFetchScore(baseCode, ctx) : null;
  const quoteScore = quoteCode ? await getOrFetchScore(quoteCode, ctx) : null;
  return evaluatePairRow({
    config,
    baseCurrency: ctx.pair.base,
    quoteCurrency: ctx.pair.quote,
    baseScore,
    quoteScore,
  });
}

function buildRowBreakdown(rows: PairRowResult[]): Prisma.InputJsonValue {
  return rows.map((r) => ({
    rowName: r.rowName,
    uiGroup: r.uiGroup,
    indicatorA: {
      code: r.indicatorA.code,
      score: r.indicatorA.score,
      direction: r.indicatorA.direction,
      inverted: r.indicatorA.inverted,
      outcome: r.indicatorA.outcome,
    },
    indicatorB: {
      code: r.indicatorB.code,
      score: r.indicatorB.score,
      direction: r.indicatorB.direction,
      inverted: r.indicatorB.inverted,
      outcome: r.indicatorB.outcome,
    },
    pairScore: r.pairScore,
    notes: r.notes,
    rowIncluded: r.rowIncluded,
  }));
}

function buildCotBreakdown(
  base: CotSideSnapshot,
  quote: CotSideSnapshot,
  pairCotScore: number,
): Prisma.InputJsonValue | null {
  if (base.label === null && quote.label === null) return null;
  return {
    pairCotScore,
    baseSide: {
      label: base.label,
      contractCode: base.contractCode,
      traderCategory: base.traderCategory,
      weeklyChangePct: base.weeklyChangePct,
      reportDate: base.reportDate,
    },
    quoteSide: {
      label: quote.label,
      contractCode: quote.contractCode,
      traderCategory: quote.traderCategory,
      weeklyChangePct: quote.weeklyChangePct,
      reportDate: quote.reportDate,
    },
  };
}

function buildCompassOverridesJson(
  regime: Regime,
  pairCode: string,
  totalAdjustment: number,
  overridesFired: ReadonlyArray<{ code: string; adjustment: number; pair: string }>,
): Prisma.InputJsonValue | null {
  if (overridesFired.length === 0) return null;
  return {
    regime,
    pair: pairCode,
    overridesFired: overridesFired.map((o) => ({
      code: o.code,
      adjustment: o.adjustment,
      pair: o.pair,
    })),
    totalAdjustment,
  };
}

/**
 * Fetch the JPY Safe Haven boost value from the most recent JPY asset scorecard.
 * Returns the adjustment (typically 1) when OVERRIDE_3_JPY_SAFE_HAVEN fired,
 * or 0 if the scorecard is absent or the override did not fire.
 */
async function fetchJpySafeHavenBoost(scoreDate: Date): Promise<number> {
  const jpyAsset = await prisma.asset.findUnique({
    where: { code: 'JPY' },
    select: { id: true },
  });
  if (!jpyAsset) return 0;

  const jpyCard = await prisma.edgefinderScorecard.findFirst({
    where: {
      assetId: jpyAsset.id,
      isCurrent: true,
      observationDate: { lte: scoreDate },
    },
    orderBy: { observationDate: 'desc' },
    select: { compassOverridesApplied: true },
  });

  const applied = jpyCard?.compassOverridesApplied;
  if (!applied || typeof applied !== 'object' || Array.isArray(applied)) return 0;

  const overridesFired = (applied as Record<string, unknown>).overridesFired;
  if (!Array.isArray(overridesFired)) return 0;

  const safeHaven = overridesFired.find(
    (o): o is { code: string; adjustment: number } =>
      typeof o === 'object' &&
      o !== null &&
      (o as { code: string }).code === 'OVERRIDE_3_JPY_SAFE_HAVEN',
  );
  return safeHaven?.adjustment ?? 0;
}

/**
 * Build a synthetic PairRowResult for the COT row so it appears as a
 * dedicated entry in rowBreakdown alongside the fundamental rows.
 * pairScore here is the combined pair COT score from combineCotLabelsForPair.
 */
function buildCotPairRow(
  pair: PairDefinition,
  baseCot: CotSideSnapshot,
  quoteCot: CotSideSnapshot,
  pairCotScore: number,
): PairRowResult {
  const labelToScore = (label: CotLabel | null): number =>
    label === 'Bullish' ? 1 : label === 'Bearish' ? -1 : 0;

  return {
    rowName: 'COT (Change %)',
    uiGroup: 'COT',
    indicatorA: {
      code: `${pair.base}_COT`,
      score: labelToScore(baseCot.label),
      direction: baseCot.label,
      inverted: false,
      outcome: baseCot.label !== null ? 'scored' : 'insufficient_data',
    },
    indicatorB: {
      code: `${pair.quote}_COT`,
      score: labelToScore(quoteCot.label),
      direction: quoteCot.label,
      inverted: false,
      outcome: quoteCot.label !== null ? 'scored' : 'insufficient_data',
    },
    pairScore: pairCotScore,
    notes:
      baseCot.label === null || quoteCot.label === null
        ? 'COT data unavailable for one or both currencies'
        : null,
    rowIncluded: true,
  };
}

/**
 * Assemble the pair score for a single FX pair on a given date.
 *
 * Per Spec v2 §7: pair template rows are loaded from the DB (pair_template_rows)
 * rather than a static config file, so any seed change (e.g. PPI becoming BILATERAL)
 * is automatically inherited. Pair COT is Change %-only via `combineCotLabelsForPair`
 * and is appended as a dedicated COT row in rowBreakdown. Compass Override 3 (JPY
 * Safe Haven) propagates from the JPY asset scorecard into all JPY-quote pairs;
 * Override 5 (Carry Unwind) applies on top for EURJPY/GBPJPY.
 */
export async function assemblePairScore(
  pairCode: string,
  scoreDate: Date,
): Promise<AssemblePairScoreResult> {
  const pairDef = getPairDefinition(pairCode);
  if (!pairDef) {
    throw new AppError(404, `Unknown pair code: ${pairCode}`, 'UNKNOWN_PAIR');
  }

  const pairAsset = await prisma.asset.findUnique({ where: { code: pairCode } });
  if (!pairAsset) {
    throw new AppError(404, `Pair asset not found: ${pairCode}`, 'PAIR_ASSET_NOT_FOUND');
  }

  // Fix 1: Load template from DB (replaces static PAIR_TEMPLATE).
  const pairTemplate = await loadPairTemplateFromDb();

  const ctx: RowEvaluationContext = {
    pair: pairDef,
    scoreDate,
    scoreCache: new Map(),
  };

  const rowResults: PairRowResult[] = [];
  for (const rowConfig of pairTemplate) {
    const result = await evaluateRow(rowConfig, ctx);
    rowResults.push(result);
  }

  // Calculate template-row stats BEFORE the COT row is appended.
  const basePairScore = rowResults
    .filter((r) => r.rowIncluded)
    .reduce((sum, r) => sum + r.pairScore, 0);
  const rowCount = rowResults.filter((r) => r.rowIncluded).length;
  const rowsScored = rowResults.filter((r) => r.rowIncluded && r.pairScore !== 0).length;

  // Fix 4: Load COT data and compute the pair COT score.
  const baseCot = await loadCotChangeLabel(pairDef.base, scoreDate);
  const quoteCot = await loadCotChangeLabel(pairDef.quote, scoreDate);
  const pairCotScore =
    baseCot.label !== null && quoteCot.label !== null
      ? combineCotLabelsForPair(baseCot.label, quoteCot.label)
      : 0;

  // Append the COT row to rowResults for dedicated UI display.
  rowResults.push(buildCotPairRow(pairDef, baseCot, quoteCot, pairCotScore));

  const baseTotal = basePairScore + pairCotScore;

  const regimeSnapshot = await compassClassificationsRepository.getRegimeAsOf(scoreDate);
  let regime: Regime;
  if (regimeSnapshot) {
    regime = regimeSnapshot.activeRegime;
  } else {
    regime = 'Caution';
    logger.warn(
      { pairCode, scoreDate: scoreDate.toISOString().slice(0, 10) },
      'No Compass classification on or before date — defaulting regime to Caution',
    );
  }

  // Fix 2: Inject JPY Safe Haven boost from asset scorecard into pair overrides.
  const jpySafeHavenBoost =
    regime === 'Risk-Off' && pairDef.quote === 'JPY'
      ? await fetchJpySafeHavenBoost(scoreDate)
      : 0;

  const overrides = computePairCompassOverrides({ pairCode, regime, jpySafeHavenBoost });
  const compassAdjustment = overrides.totalAdjustment;
  const totalScore = baseTotal + compassAdjustment;
  const ratingLabel = mapScoreToLabel(totalScore);

  const rowBreakdown = buildRowBreakdown(rowResults);
  const cotBreakdown = buildCotBreakdown(baseCot, quoteCot, pairCotScore);
  const compassOverridesApplied = buildCompassOverridesJson(
    regime,
    pairCode,
    overrides.totalAdjustment,
    overrides.overridesFired,
  );

  const upsert: UpsertPairScoreResult = await edgefinderPairScoresRepository.upsert({
    pairId: pairAsset.id,
    scoreDate,
    basePairScore,
    pairCotScore,
    baseTotal,
    compassAdjustment,
    compassOverridesApplied,
    regimeAtCompute: regime,
    totalScore,
    ratingLabel,
    rowBreakdown,
    cotBreakdown,
  });

  logger.info(
    {
      pairCode,
      scoreDate: scoreDate.toISOString().slice(0, 10),
      basePairScore,
      pairCotScore,
      compassAdjustment,
      totalScore,
      ratingLabel,
      regime,
      rowCount,
      rowsScored,
      action: upsert.action,
    },
    'EdgeFinder pair score assembled',
  );

  return {
    pairScoreId: upsert.pairScoreId,
    pairCode,
    scoreDate,
    basePairScore,
    pairCotScore,
    baseTotal,
    compassAdjustment,
    totalScore,
    ratingLabel,
    regime,
    rowCount,
    rowsScored,
    action: upsert.action,
  };
}
