import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { getSkipDates } from './frozen-date-crosscheck';
import { Prisma } from '@prisma/client';

export interface RollingWindowParams {
  indicatorCode: string;
  indicatorId: string;
  observationDate: Date;
  windowSize: number;
}

export interface RollingWindowRow {
  value: Prisma.Decimal;
  observationDate: Date;
}

export type RollingWindowResult =
  | { ok: true; points: RollingWindowRow[] }
  | { ok: false; have: number };

/**
 * Selects the most recent `windowSize` valid (non-frozen) data_points rows
 * up to and including observationDate, ordered newest-first (index 0 = most
 * recent).
 *
 * Extracted 2026-08-17 from what was previously identical, byte-for-byte
 * copy-pasted window-selection logic in rolling-pct-direction.handler.ts and
 * rolling-pct-tiered.handler.ts (the only two consumers — both scoped
 * exclusively to IND_NIFTY_10_DXY / 11_BRENT / 12_USDINR). One implementation
 * of the shared logic; both handlers now call this instead of duplicating it.
 */
export async function selectRollingWindow(
  params: RollingWindowParams,
): Promise<RollingWindowResult> {
  const { indicatorCode, indicatorId, observationDate, windowSize } = params;

  const { skipDates, warnings } = await getSkipDates({
    indicatorCode,
    indicatorId,
    observationDate,
    lookbackRows: windowSize,
  });

  for (const warning of warnings) {
    logger.warn(warning, 'Suspected frozen feed breakage detected during rolling window scan');
  }

  const supersetTake =
    skipDates.size > 0 ? Math.max(windowSize + skipDates.size, windowSize * 3, 40) : windowSize;

  const superset = await prisma.dataPoint.findMany({
    where: {
      indicatorId,
      isCurrent: true,
      observationDate: { lte: observationDate },
    },
    orderBy: { observationDate: 'desc' },
    take: supersetTake,
  });

  const points = superset
    .filter((p) => !skipDates.has(p.observationDate.toISOString().slice(0, 10)))
    .slice(0, windowSize);

  if (points.length < windowSize) {
    return { ok: false, have: points.length };
  }
  return { ok: true, points };
}
