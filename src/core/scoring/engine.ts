import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { AppError } from '@core/middleware/error-handler';
import { ScoringContext, ScoringResult } from './types';
import { thresholdHandler } from './handlers/threshold.handler';
import { twoComponentCpiHandler } from './handlers/two-component-cpi.handler';
import { cycleRegimeHandler } from './handlers/cycle-regime.handler';
import { rollingTieredHandler } from './handlers/rolling-tiered.handler';
import { rollingRatioExcludingHandler } from './handlers/rolling-ratio-excluding.handler';
import { bandWithFlagHandler } from './handlers/band-with-flag.handler';
import { manualRawCompositeHandler } from './handlers/manual-raw-composite.handler';
import { rollingPctDirectionHandler } from './handlers/rolling-pct-direction.handler';
import { rollingPctTieredHandler } from './handlers/rolling-pct-tiered.handler';
import { thresholdBandsHandler } from './handlers/threshold-bands.handler';
import { normalHandler } from './handlers/normal.handler';
import { invertedHandler } from './handlers/inverted.handler';
import { cpiRateCycleHandler } from './handlers/cpi-rate-cycle.handler';
import { us02ySmaHandler } from './handlers/us02y-sma.handler';
import { rateDecisionHandler } from './handlers/rate-decision.handler';
import { cotTwoComponentHandler } from './handlers/cot';

type Handler = (ctx: ScoringContext) => Promise<ScoringResult>;

const HANDLERS_BY_TYPE: Record<string, Handler> = {
  threshold: thresholdHandler,
  two_component_cpi: twoComponentCpiHandler,
  cycle_regime: cycleRegimeHandler,
  rolling_tiered: rollingTieredHandler,
  rolling_ratio_excluding: rollingRatioExcludingHandler,
  band_with_flag: bandWithFlagHandler,
  manual_raw_composite: manualRawCompositeHandler,
  rolling_pct_direction: rollingPctDirectionHandler,
  rolling_pct_tiered: rollingPctTieredHandler,
  threshold_bands: thresholdBandsHandler,
  normal: normalHandler,
  inverted: invertedHandler,
  cpi_rate_cycle: cpiRateCycleHandler,
  us02y_sma: us02ySmaHandler,
  rate_decision: rateDecisionHandler,
  cot_two_component: cotTwoComponentHandler,
};

export interface ScoreIndicatorParams {
  indicatorCode: string;
  observationDate: Date;
  allowCarryForward?: boolean;
}

export async function scoreIndicator(params: ScoreIndicatorParams): Promise<ScoringResult> {
  const indicator = await prisma.indicator.findUnique({
    where: { code: params.indicatorCode },
  });
  if (!indicator) {
    throw new AppError(404, `Indicator not found: ${params.indicatorCode}`, 'INDICATOR_NOT_FOUND');
  }

  const rule = await prisma.scoringRule.findFirst({
    where: {
      indicatorId: indicator.id,
      effectiveFrom: { lte: params.observationDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: params.observationDate } }],
    },
    orderBy: { version: 'desc' },
  });
  if (!rule) {
    throw new AppError(
      404,
      `No active scoring rule for ${params.indicatorCode} on ${params.observationDate.toISOString().slice(0, 10)}`,
      'NO_ACTIVE_RULE',
    );
  }

  const ruleDef = rule.ruleDefinition as Record<string, unknown>;
  const ruleType = ruleDef.type as string | undefined;
  if (!ruleType) {
    throw new AppError(500, `Rule ${rule.id} has no 'type' field in ruleDefinition`, 'INVALID_RULE');
  }

  const handler = HANDLERS_BY_TYPE[ruleType];
  if (!handler) {
    throw new AppError(500, `No handler for rule type: ${ruleType}`, 'NO_HANDLER');
  }

  const ctx: ScoringContext = {
    indicatorId: indicator.id,
    indicatorCode: indicator.code,
    observationDate: params.observationDate,
    ruleVersionId: rule.id,
    ruleDefinition: ruleDef,
  };

  const result = await handler(ctx);

  if (result.kind === 'insufficient_data' && params.allowCarryForward !== false) {
    const priorScore = await prisma.score.findFirst({
      where: {
        indicatorId: indicator.id,
        observationDate: { lt: params.observationDate },
      },
      orderBy: { observationDate: 'desc' },
    });

    if (priorScore) {
      const daysStale = Math.floor(
        (params.observationDate.getTime() - priorScore.observationDate.getTime()) /
          (1000 * 60 * 60 * 24),
      );
      const priorMeta = (priorScore.computationMetadata ?? {}) as Record<string, unknown>;
      logger.info(
        {
          indicatorCode: params.indicatorCode,
          daysStale,
          sourceDate: priorScore.observationDate,
        },
        'Score carry-forward promoted',
      );
      return {
        kind: 'carry_forward',
        score: priorScore.score as -2 | -1 | 0 | 1 | 2,
        sourceDate: priorScore.observationDate,
        daysStale,
        flags: priorScore.flag ? [priorScore.flag, 'CARRY_FORWARD'] : ['CARRY_FORWARD'],
        metadata: { originalReason: result.reason, priorMetadata: priorMeta },
      };
    }
  }

  return result;
}
