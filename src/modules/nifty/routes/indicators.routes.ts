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
