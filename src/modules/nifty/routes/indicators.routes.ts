import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '@core/db/prisma';
import { AppError } from '@core/middleware/error-handler';

export const indicatorsRouter = Router();

// TODO(auth): Currently mounted under /api/nifty with no auth.
// Add Supabase Auth middleware when ready.

const listDataPointsParamsSchema = z.object({
  code: z.string().min(1),
});

const listDataPointsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(20),
  include_historical_vintages: z.coerce.boolean().default(false),
});

indicatorsRouter.get(
  '/indicators/:code/data-points',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const paramsParsed = listDataPointsParamsSchema.safeParse(req.params);
      if (!paramsParsed.success) {
        throw new AppError(400, 'Invalid params', 'VALIDATION_ERROR', paramsParsed.error.flatten());
      }
      const queryParsed = listDataPointsQuerySchema.safeParse(req.query);
      if (!queryParsed.success) {
        throw new AppError(400, 'Invalid query', 'VALIDATION_ERROR', queryParsed.error.flatten());
      }

      const indicator = await prisma.indicator.findUnique({
        where: { code: paramsParsed.data.code },
      });

      if (!indicator) {
        throw new AppError(404, `Indicator not found: ${paramsParsed.data.code}`, 'INDICATOR_NOT_FOUND');
      }

      const dataPoints = await prisma.dataPoint.findMany({
        where: {
          indicatorId: indicator.id,
          ...(queryParsed.data.include_historical_vintages ? {} : { isCurrent: true }),
        },
        orderBy: [{ observationDate: 'desc' }, { vintageDate: 'desc' }],
        take: queryParsed.data.limit,
        select: {
          id: true,
          observationDate: true,
          value: true,
          vintageDate: true,
          isCurrent: true,
          dataQualityFlag: true,
          source: true,
          notes: true,
        },
      });

      res.json({
        success: true,
        indicator: {
          code: indicator.code,
          name: indicator.name,
          frequency: indicator.frequency,
          dataSource: indicator.dataSource,
          unit: indicator.unit,
        },
        count: dataPoints.length,
        dataPoints: dataPoints.map((dp) => ({
          id: dp.id,
          observationDate: dp.observationDate.toISOString().slice(0, 10),
          value: dp.value.toString(),
          vintageDate: dp.vintageDate.toISOString(),
          isCurrent: dp.isCurrent,
          dataQualityFlag: dp.dataQualityFlag,
          source: dp.source,
          notes: dp.notes,
        })),
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/nifty/indicators/:code/detail
//
// Returns per-observation-date breakdown for one indicator, joining:
//   - data_points (value, forecast, previous, sourceMetadata, quality flag)
//   - scores (score, outcome, flags, computationMetadata)
//   - scoring_rules (ruleType, ruleDefinition in use at that date)
//
// Query params:
//   limit   — max rows (default 30, max 365)
//   from    — YYYY-MM-DD, filter from date (inclusive)
//   to      — YYYY-MM-DD, filter to date (inclusive)
// ─────────────────────────────────────────────────────────────────────────────

const indicatorDetailQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(365).default(30),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

indicatorsRouter.get(
  '/indicators/:code/detail',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const paramsParsed = listDataPointsParamsSchema.safeParse(req.params);
      if (!paramsParsed.success) {
        throw new AppError(400, 'Invalid params', 'VALIDATION_ERROR', paramsParsed.error.flatten());
      }
      const queryParsed = indicatorDetailQuerySchema.safeParse(req.query);
      if (!queryParsed.success) {
        throw new AppError(400, 'Invalid query', 'VALIDATION_ERROR', queryParsed.error.flatten());
      }

      const indicator = await prisma.indicator.findUnique({
        where: { code: paramsParsed.data.code },
        include: {
          scoringRules: {
            where: { effectiveTo: null },
            orderBy: { version: 'desc' },
            take: 1,
          },
        },
      });

      if (!indicator) {
        throw new AppError(
          404,
          `Indicator not found: ${paramsParsed.data.code}`,
          'INDICATOR_NOT_FOUND',
        );
      }

      const { limit, from, to } = queryParsed.data;

      const fromDate = from ? new Date(`${from}T00:00:00.000Z`) : undefined;
      const toDate = to ? new Date(`${to}T00:00:00.000Z`) : undefined;

      // Fetch current data points in date range
      const dataPoints = await prisma.dataPoint.findMany({
        where: {
          indicatorId: indicator.id,
          isCurrent: true,
          ...(fromDate || toDate
            ? {
                observationDate: {
                  ...(fromDate ? { gte: fromDate } : {}),
                  ...(toDate ? { lte: toDate } : {}),
                },
              }
            : {}),
        },
        orderBy: { observationDate: 'desc' },
        take: limit,
        select: {
          id: true,
          observationDate: true,
          value: true,
          forecastValue: true,
          previousValue: true,
          vintageDate: true,
          isCurrent: true,
          dataQualityFlag: true,
          source: true,
          sourceMetadata: true,
          notes: true,
          createdBy: true,
        },
      });

      if (dataPoints.length === 0) {
        res.json({
          success: true,
          indicator: buildIndicatorMeta(indicator),
          activeRule: buildActiveRule(indicator.scoringRules[0] ?? null),
          count: 0,
          entries: [],
        });
        return;
      }

      const obsDates = dataPoints.map((dp) => dp.observationDate);

      // Fetch scores for exactly these observation dates
      const scores = await prisma.score.findMany({
        where: {
          indicatorId: indicator.id,
          observationDate: { in: obsDates },
        },
        orderBy: { computedAt: 'desc' },
        select: {
          id: true,
          observationDate: true,
          score: true,
          flag: true,
          computedAt: true,
          computationMetadata: true,
          ruleVersion: {
            select: {
              id: true,
              version: true,
              ruleType: true,
              ruleDefinition: true,
            },
          },
        },
      });

      // Latest score per observation date
      const scoreByDate = new Map<string, (typeof scores)[0]>();
      for (const s of scores) {
        const key = s.observationDate.toISOString().slice(0, 10);
        if (!scoreByDate.has(key)) scoreByDate.set(key, s);
      }

      const entries = dataPoints.map((dp) => {
        const dateKey = dp.observationDate.toISOString().slice(0, 10);
        const score = scoreByDate.get(dateKey) ?? null;
        const meta = (score?.computationMetadata ?? {}) as Record<string, unknown>;

        return {
          observationDate: dateKey,
          dataPoint: {
            id: dp.id,
            value: Number(dp.value),
            forecastValue: dp.forecastValue !== null ? Number(dp.forecastValue) : null,
            previousValue: dp.previousValue !== null ? Number(dp.previousValue) : null,
            dataQualityFlag: dp.dataQualityFlag ?? null,
            source: dp.source,
            sourceMetadata: dp.sourceMetadata ?? null,
            notes: dp.notes ?? null,
            enteredBy: dp.createdBy ?? null,
            vintageDate: dp.vintageDate.toISOString(),
          },
          score: score
            ? {
                id: score.id,
                value: score.score,
                flag: score.flag ?? null,
                computedAt: score.computedAt.toISOString(),
                outcome: meta.carry_forward === true ? 'carry_forward' : 'scored',
                flags: Array.isArray(meta.flags) ? meta.flags : score.flag ? [score.flag] : [],
                computationDetail: meta,
                rule: {
                  version: score.ruleVersion.version,
                  ruleType: score.ruleVersion.ruleType,
                  ruleDefinition: score.ruleVersion.ruleDefinition,
                },
              }
            : null,
        };
      });

      res.json({
        success: true,
        indicator: buildIndicatorMeta(indicator),
        activeRule: buildActiveRule(indicator.scoringRules[0] ?? null),
        count: entries.length,
        entries,
      });
    } catch (err) {
      next(err);
    }
  },
);

function buildIndicatorMeta(indicator: {
  code: string;
  name: string;
  frequency: string;
  dataSource: string;
  unit: string | null;
  displayOrder: number | null;
  compositeGroup: string | null;
  country: string | null;
  uiGroup: string | null;
}) {
  return {
    code: indicator.code,
    name: indicator.name,
    frequency: indicator.frequency,
    dataSource: indicator.dataSource,
    unit: indicator.unit ?? null,
    displayOrder: indicator.displayOrder ?? null,
    compositeGroup: indicator.compositeGroup ?? null,
    country: indicator.country ?? null,
    uiGroup: indicator.uiGroup ?? null,
  };
}

function buildActiveRule(rule: {
  version: number;
  ruleType: string;
  ruleDefinition: object;
} | null) {
  if (!rule) return null;
  return {
    version: rule.version,
    ruleType: rule.ruleType,
    ruleDefinition: rule.ruleDefinition,
  };
}
