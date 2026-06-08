import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '@core/middleware/error-handler';
import { getLatestScorecard, getScorecardHistory } from '@modules/nifty/services/public-api.service';
import { getUsdLabDetail, getUsdLabSubIndicatorHistory } from '@modules/nifty/services/usd-lab.service';
import type {
  PublicScorecard,
  PublicIndicator,
  PublicScorecardHistoryItem,
  PublicBand,
} from '@modules/nifty/types/public-api.types';
import type {
  NiftyScorecard,
  NiftyScorecardHistoryItem,
  NiftyIndicator,
  NiftyBand,
  NiftyCompositionFlag,
  NiftyRegimeBucket,
  NiftyIndicatorScore,
} from './nifty.types';
import { NIFTY_PATTERNS } from './nifty-patterns.data';

export const niftyPublicV2Router = Router();

// ============================================================================
// Type conversion helpers
// ============================================================================

function toNiftyBand(band: PublicBand): NiftyBand {
  // PublicBand and NiftyBand use the same string literals
  return band as NiftyBand;
}

function toNiftyCompositionFlag(flag: string | null | undefined): NiftyCompositionFlag {
  const valid = ['INFLATION_LED', 'DEMAND_DESTRUCTION', 'MIXED', 'INFLATION_HOT', 'DEMAND_REACCEL'];
  if (flag && valid.includes(flag)) return flag as NiftyCompositionFlag;
  return null;
}

function toNiftyRegimeBucket(bucket: string | undefined): NiftyRegimeBucket | undefined {
  const valid = ['BULL', 'BEAR_DEEP', 'BEAR_LIGHT', 'TOP_CORRECTION', 'MIXED'];
  if (bucket && valid.includes(bucket)) return bucket as NiftyRegimeBucket;
  return undefined;
}

function toNiftyIndicatorScore(score: number | null): NiftyIndicatorScore {
  if (score === -2 || score === -1 || score === 0 || score === 1 || score === 2) return score;
  return 0;
}

/** Strip code/outcome/flags/reason from PublicIndicator → NiftyIndicator */
function toNiftyIndicator(pub: PublicIndicator): NiftyIndicator {
  return {
    id: pub.id,
    name: pub.name,
    short: pub.short,
    composite: pub.composite,
    score: toNiftyIndicatorScore(pub.score),
    value: pub.value,
    magnitude: pub.magnitude,
    ...(pub.trajectory_3m_avg !== undefined ? { trajectory_3m_avg: pub.trajectory_3m_avg } : {}),
    last_change_date: pub.last_change_date,
    ...(pub.prev_score !== undefined ? { prev_score: toNiftyIndicatorScore(pub.prev_score) } : {}),
  };
}

function toNiftyScorecardFull(pub: PublicScorecard): NiftyScorecard {
  return {
    id: pub.id,
    date: pub.date,
    phase: pub.phase,
    bucket: toNiftyRegimeBucket(pub.bucket),
    indicators: (pub.indicators ?? []).map(toNiftyIndicator),
    domestic_composite: pub.domestic_composite,
    external_composite: pub.external_composite,
    net_score: pub.net_score,
    band: toNiftyBand(pub.band),
    ind9_raw_composite: pub.ind9_raw_composite ?? null,
    ind9_sub_indicators: buildInd9SubIndicators(pub.ind9_sub_indicators),
    composition_flag: toNiftyCompositionFlag(pub.composition_flag),
    peak_score_active: pub.peak_score_active,
    ...(pub.peak_score_peak_date ? { peak_score_peak_date: pub.peak_score_peak_date } : {}),
    ...(pub.peak_score_peak_value !== undefined ? { peak_score_peak_value: pub.peak_score_peak_value } : {}),
    ...(pub.velocity_short !== undefined ? { velocity_short: pub.velocity_short } : {}),
    conflict_flag: pub.conflict_flag,
    notes: pub.notes,
    catalysts: pub.catalysts ?? [],
  };
}

function buildInd9SubIndicators(
  raw: Record<string, unknown> | undefined | null,
): Record<string, NiftyIndicatorScore> {
  if (!raw || typeof raw !== 'object') return {};
  const result: Record<string, NiftyIndicatorScore> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (typeof val === 'number') {
      result[key] = toNiftyIndicatorScore(val);
    }
  }
  return result;
}

function toNiftyScorecardHistoryItem(
  pub: PublicScorecardHistoryItem,
): NiftyScorecardHistoryItem {
  return {
    id: pub.id,
    date: pub.date,
    net_score: pub.net_score,
    domestic_composite: pub.domestic_composite,
    external_composite: pub.external_composite,
    band: toNiftyBand(pub.band),
    conflict_flag: pub.conflict_flag,
    composition_flag: toNiftyCompositionFlag(pub.composition_flag),
    peak_score_active: pub.peak_score_active,
    ind9_raw_composite: pub.ind9_raw_composite ?? null,
  };
}

// ============================================================================
// GET /api/nifty/scorecards/latest
// ============================================================================

niftyPublicV2Router.get(
  '/scorecards/latest',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const pub = await getLatestScorecard();
      if (!pub) {
        throw new AppError(404, 'No scorecard found', 'SCORECARD_NOT_FOUND');
      }
      const data: NiftyScorecard = toNiftyScorecardFull(pub);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  },
);

// ============================================================================
// GET /api/nifty/scorecards?limit=25
// ============================================================================

const scorecardsQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^\d+$/)
    .transform((s) => Math.min(parseInt(s, 10), 365))
    .optional()
    .default('25'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

niftyPublicV2Router.get(
  '/scorecards',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = scorecardsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError(400, 'Invalid query params', 'VALIDATION_ERROR', parsed.error.flatten());
      }
      const limit = typeof parsed.data.limit === 'number'
        ? parsed.data.limit
        : parseInt(parsed.data.limit as string, 10);

      const result = await getScorecardHistory({
        from: parsed.data.from ? new Date(`${parsed.data.from}T00:00:00.000Z`) : undefined,
        to: parsed.data.to ? new Date(`${parsed.data.to}T00:00:00.000Z`) : undefined,
        limit,
        includeBreakdown: false,
      });

      const items: NiftyScorecardHistoryItem[] = (result.items as PublicScorecardHistoryItem[]).map(
        toNiftyScorecardHistoryItem,
      );

      res.json({
        success: true,
        total: result.count,
        count: items.length,
        data: items,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ============================================================================
// GET /api/nifty/usd-lab  — Indicator 9 (USD Weakness) full breakdown
// ============================================================================

niftyPublicV2Router.get(
  '/usd-lab',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await getUsdLabDetail();
      if (!data) {
        throw new AppError(404, 'No Ind 9 data available', 'IND9_NOT_FOUND');
      }
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  },
);

// ============================================================================
// GET /api/nifty/usd-lab/sub-indicator/:code  — last-12 release history (drawer)
// ============================================================================

const subIndicatorParamsSchema = z.object({
  code: z.string().regex(/^[A-Z0-9_]{2,40}$/),
});

niftyPublicV2Router.get(
  '/usd-lab/sub-indicator/:code',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = subIndicatorParamsSchema.safeParse(req.params);
      if (!parsed.success) {
        throw new AppError(400, 'Invalid sub-indicator code', 'VALIDATION_ERROR', parsed.error.flatten());
      }
      const data = await getUsdLabSubIndicatorHistory(parsed.data.code);
      if (!data) {
        throw new AppError(404, `Unknown Ind 9 sub-indicator: ${parsed.data.code}`, 'SUB_INDICATOR_NOT_FOUND');
      }
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  },
);

// ============================================================================
// GET /api/nifty/patterns
// ============================================================================

niftyPublicV2Router.get(
  '/patterns',
  (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, count: NIFTY_PATTERNS.length, data: NIFTY_PATTERNS });
    } catch (err) {
      next(err);
    }
  },
);
