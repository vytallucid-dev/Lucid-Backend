import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { AppError } from '@core/middleware/error-handler';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import {
  VALIDATION_WINDOWS,
  getWindowByName,
  type ValidationWindowName,
} from '@modules/edgefinder/services/compass/validation/validation-windows.config';
import { backfillWindow } from '@modules/edgefinder/services/compass/validation/historical-backfill.service';
import {
  runValidation,
  getMostRecentReport,
} from '@modules/edgefinder/services/compass/validation/validation-harness.service';

export const adminValidationRouter = Router();

const WINDOW_NAMES = ['2008_GFC', '2020_COVID', '2022_HIKES', '2024_YEN_UNWIND'] as const;

// ============================================================================
// POST /backfill — kick off backfill in the background
// ============================================================================

const backfillBodySchema = z.object({
  windowName: z.enum([...WINDOW_NAMES, 'all']).optional(),
});

adminValidationRouter.post(
  '/backfill',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = backfillBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(
          400,
          'Invalid body',
          'VALIDATION_ERROR',
          parsed.error.flatten(),
        );
      }
      const target = parsed.data.windowName ?? 'all';
      const triggeredBy =
        (req.headers['x-admin-user'] as string | undefined) ?? null;

      const windows =
        target === 'all'
          ? VALIDATION_WINDOWS
          : [getWindowByName(target as ValidationWindowName)];

      const job = await dataFetchLogRepository.start({
        jobName: 'compass_validation_backfill_job',
        triggerType: 'backfill',
        triggeredBy,
        metadata: {
          windowsQueued: windows.map((w) => w.windowName),
        },
      });

      // Fire-and-forget: run windows sequentially in the background. Errors
      // are logged but don't crash the process.
      void (async (): Promise<void> => {
        const startedAt = Date.now();
        const summaries: Array<{ windowName: string; logId: string }> = [];
        try {
          for (const w of windows) {
            const result = await backfillWindow(
              {
                windowName: w.windowName,
                startDate: w.startDate,
                endDate: w.endDate,
              },
              triggeredBy,
            );
            summaries.push({
              windowName: result.windowName,
              logId: result.logId,
            });
          }
          await dataFetchLogRepository.complete({
            logId: job.id,
            status: 'success',
            metadata: {
              windowsCompleted: summaries,
              durationMs: Date.now() - startedAt,
            },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(
            { jobId: job.id, message },
            'Compass validation backfill job failed',
          );
          await dataFetchLogRepository.complete({
            logId: job.id,
            status: 'failed',
            errors: { message },
            metadata: {
              windowsCompleted: summaries,
              durationMs: Date.now() - startedAt,
            },
          });
        }
      })();

      res.json({
        jobId: job.id,
        status: 'started' as const,
        windowsQueued: windows.map((w) => w.windowName),
      });
    } catch (err) {
      next(err);
    }
  },
);

// ============================================================================
// GET /status — per-window backfill progress
// ============================================================================

adminValidationRouter.get(
  '/status',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const windows = await Promise.all(
        VALIDATION_WINDOWS.map(async (cfg) => {
          const tradingDaysExpected = countTradingDays(cfg.startDate, cfg.endDate);
          const [inputCount, lastInput] = await Promise.all([
            prisma.compassInput.count({
              where: {
                isValidation: true,
                observationDate: { gte: cfg.startDate, lte: cfg.endDate },
              },
            }),
            prisma.compassInput.findFirst({
              where: {
                isValidation: true,
                observationDate: { gte: cfg.startDate, lte: cfg.endDate },
              },
              orderBy: { computedAt: 'desc' },
              select: { computedAt: true },
            }),
          ]);

          // 6 inputs per trading day = expected total
          const expectedRows = tradingDaysExpected * 6;
          const tradingDaysComplete = Math.floor(inputCount / 6);

          let backfillStatus:
            | 'not_started'
            | 'in_progress'
            | 'completed'
            | 'failed';
          if (inputCount === 0) backfillStatus = 'not_started';
          else if (inputCount >= expectedRows) backfillStatus = 'completed';
          else backfillStatus = 'in_progress';

          return {
            windowName: cfg.windowName,
            backfillStatus,
            tradingDaysExpected,
            tradingDaysComplete,
            lastUpdated: lastInput?.computedAt ?? null,
          };
        }),
      );

      res.json({ windows });
    } catch (err) {
      next(err);
    }
  },
);

// ============================================================================
// POST /run — run validation harness synchronously
// ============================================================================

adminValidationRouter.post(
  '/run',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const report = await runValidation();
      res.json(report);
    } catch (err) {
      next(err);
    }
  },
);

// ============================================================================
// GET /report — most recent persisted validation report
// ============================================================================

adminValidationRouter.get(
  '/report',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const report = await getMostRecentReport();
      if (!report) {
        throw new AppError(
          404,
          'No validation report exists yet. POST /run to generate one.',
          'NO_REPORT',
        );
      }
      res.json(report);
    } catch (err) {
      next(err);
    }
  },
);

function countTradingDays(start: Date, end: Date): number {
  let count = 0;
  const cursor = new Date(start);
  while (cursor.getTime() <= end.getTime()) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}
