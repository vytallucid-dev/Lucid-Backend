import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { AppError } from '@core/middleware/error-handler';
import { logger } from '@core/utils/logger';
import { dataPointsRepository } from '@core/repositories/data-points.repository';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { getPriorRateLevel } from './rate-decision.helpers';

// Per-indicator log name (mirrors the NIFTY manual-input convention
// `manual_input_<code>`) so each indicator's detail page can filter its own
// manual entries/overrides out of data_fetch_log.
const JOB_NAME_PREFIX = 'manual_input_';

// Float tolerance for the revision-mismatch pre-check: the submitted `previous`
// is compared against the last stored actual within this epsilon. Sub-tolerance
// differences (float noise, trailing-zero re-entry) are treated as a match and
// pass through silently. This is a SEPARATE comparison from the vintage/upsert
// logic in data-points.repository (which rounds to Decimal(20,6) on same-date
// rows); this check never mutates history — it only flags the discrepancy.
export const REVISION_MATCH_TOLERANCE = 0.0001;

export interface ManualEntryInput {
  indicatorCode: string;
  observationDate: Date;
  actual: number;
  forecast: number | null;
  previous: number | null;
  notes: string | null;
  triggeredBy: string | null;
  // When a previous↔stored-actual mismatch is detected and this is not true,
  // the service returns a `revisionMismatch` result and writes nothing. When
  // true, the caller has acknowledged the discrepancy and the write proceeds.
  confirmRevision?: boolean;
}

// Returned instead of ManualEntryResult when the submitted `previous` differs
// from the last stored actual and the caller has not confirmed. Signals the
// handler to reply with a 409-style body so the frontend can prompt. Nothing
// is written and no scoring/vintage state is touched.
export interface RevisionMismatch {
  requiresRevisionConfirmation: true;
  indicatorCode: string;
  storedActual: number;
  storedActualDate: string;
  submittedPrevious: number;
}

export function isRevisionMismatch(
  result: ManualEntryResult | RevisionMismatch,
): result is RevisionMismatch {
  return 'requiresRevisionConfirmation' in result;
}

// The most recent current data point's actual value + observation date — the
// same "last stored actual" the frontend auto-fills into `previous`. Read-only;
// considers only active vintages (isCurrent). Returns null when there is no
// prior data point (first release).
async function getLastStoredActual(
  indicatorId: string,
): Promise<{ value: number; observationDate: Date } | null> {
  const latest = await prisma.dataPoint.findFirst({
    where: { indicatorId, isCurrent: true },
    orderBy: { observationDate: 'desc' },
    select: { value: true, observationDate: true },
  });
  if (!latest) return null;
  return { value: Number(latest.value), observationDate: latest.observationDate };
}

export interface ManualEntryResult {
  dataPointId: string;
  action: 'inserted' | 'revised' | 'skipped';
  indicator: { code: string; name: string };
  observationDate: Date;
  value: number;
  isRateDecision: boolean;
  rateLevel?: number;
  forecastValue: number | null;
  previousValue: number | null;
  notes: string | null;
}

export async function ingestManualEntry(
  input: ManualEntryInput,
): Promise<ManualEntryResult | RevisionMismatch> {
  const indicator = await prisma.indicator.findUnique({
    where: { code: input.indicatorCode },
    select: { id: true, code: true, name: true, dataSource: true },
  });

  if (!indicator) {
    throw new AppError(
      404,
      `Indicator ${input.indicatorCode} not found`,
      'INDICATOR_NOT_FOUND',
      { indicatorCode: input.indicatorCode },
    );
  }

  if (indicator.dataSource === 'fred') {
    throw new AppError(
      400,
      `Indicator ${input.indicatorCode} is sourced from FRED (auto-fetched). Manual entry not allowed.`,
      'INDICATOR_NOT_MANUAL_ELIGIBLE',
      { indicatorCode: input.indicatorCode, dataSource: indicator.dataSource },
    );
  }

  const isRateDecision = indicator.code.endsWith('_RATE');

  // ── Revision pre-check (additive; before any write) ──────────────────────
  // The `previous` the user typed for this new print should equal the last
  // stored actual (the same value the frontend auto-fills). If it differs, the
  // source likely revised last month's figure — or it's a typo.
  //
  // Skipped for rate decisions: those null out `previous` and store a bps
  // delta, so there is no typed previous to compare. Skipped when no `previous`
  // was submitted, or when there is no prior data point to compare against.
  //
  // On mismatch:
  //   - confirmRevision !== true → return a RevisionMismatch, write nothing.
  //   - confirmRevision === true → proceed, and audit-log the acknowledged
  //     discrepancy below. Note: this does NOT rewrite last month's stored
  //     actual and does NOT re-score anything — the vintage/upsert logic runs
  //     unchanged for THIS month's row only.
  let confirmedRevision: {
    storedActual: number;
    storedActualDate: string;
  } | null = null;

  if (!isRateDecision && input.previous !== null) {
    const lastActual = await getLastStoredActual(indicator.id);
    if (
      lastActual !== null &&
      Math.abs(input.previous - lastActual.value) > REVISION_MATCH_TOLERANCE
    ) {
      const storedActualDate = lastActual.observationDate
        .toISOString()
        .slice(0, 10);
      if (!input.confirmRevision) {
        return {
          requiresRevisionConfirmation: true,
          indicatorCode: indicator.code,
          storedActual: lastActual.value,
          storedActualDate,
          submittedPrevious: input.previous,
        };
      }
      confirmedRevision = { storedActual: lastActual.value, storedActualDate };
    }
  }

  const log = await dataFetchLogRepository.start({
    jobName: `${JOB_NAME_PREFIX}${indicator.code.toLowerCase()}`,
    triggerType: 'manual',
    triggeredBy: input.triggeredBy ?? null,
    metadata: {
      indicatorCode: input.indicatorCode,
      observationDate: input.observationDate.toISOString(),
      isRateDecision,
    },
  });

  try {
    const enteredAt = new Date().toISOString();

    if (isRateDecision) {
      const priorRate = await getPriorRateLevel(indicator.id, input.observationDate);
      const firstRelease = priorRate === null;
      const bpsChange = firstRelease ? 0 : (input.actual - priorRate) * 100;

      const sourceMetadata: Prisma.InputJsonObject = {
        manualEntry: true,
        rate_level: input.actual,
        ...(firstRelease ? { first_release: true } : {}),
        notes: input.notes ?? null,
        enteredAt,
        ...(input.triggeredBy ? { enteredBy: input.triggeredBy } : {}),
      };

      const upsert = await dataPointsRepository.upsert({
        indicatorId: indicator.id,
        observationDate: input.observationDate,
        value: bpsChange,
        forecastValue: null,
        previousValue: null,
        source: 'manual',
        sourceMetadata,
        fetchedVia: log.id,
        notes: input.notes ?? null,
      });

      await dataFetchLogRepository.complete({
        logId: log.id,
        status: 'success',
        rowsInserted: upsert.action === 'inserted' ? 1 : 0,
        rowsUpdated: upsert.action === 'revised' ? 1 : 0,
        rowsSkipped: upsert.action === 'skipped' ? 1 : 0,
      });

      logger.info(
        {
          indicatorCode: indicator.code,
          observationDate: input.observationDate.toISOString(),
          rateLevel: input.actual,
          priorRate,
          bpsChange,
          firstRelease,
          action: upsert.action,
        },
        'Manual rate-decision entry recorded',
      );

      return {
        dataPointId: upsert.dataPoint?.id ?? '',
        action: upsert.action,
        indicator: { code: indicator.code, name: indicator.name },
        observationDate: input.observationDate,
        value: bpsChange,
        isRateDecision: true,
        rateLevel: input.actual,
        forecastValue: null,
        previousValue: null,
        notes: input.notes,
      };
    }

    const sourceMetadata: Prisma.InputJsonObject = {
      manualEntry: true,
      notes: input.notes ?? null,
      enteredAt,
      ...(input.triggeredBy ? { enteredBy: input.triggeredBy } : {}),
    };

    const upsert = await dataPointsRepository.upsert({
      indicatorId: indicator.id,
      observationDate: input.observationDate,
      value: input.actual,
      forecastValue: input.forecast,
      previousValue: input.previous,
      source: 'manual',
      sourceMetadata,
      fetchedVia: log.id,
      notes: input.notes ?? null,
    });

    await dataFetchLogRepository.complete({
      logId: log.id,
      status: 'success',
      rowsInserted: upsert.action === 'inserted' ? 1 : 0,
      rowsUpdated: upsert.action === 'revised' ? 1 : 0,
      rowsSkipped: upsert.action === 'skipped' ? 1 : 0,
    });

    // ── Audit trail for an acknowledged revision ────────────────────────────
    // A confirmed previous↔stored-actual mismatch leaves a standalone
    // data_fetch_log row tagged `manual_revision_confirmed`, so a diverging
    // previous-value can later be traced from the audit trail. This records
    // ONLY that the discrepancy was acknowledged — no history is mutated and
    // nothing is re-scored.
    if (confirmedRevision) {
      const revisionLog = await dataFetchLogRepository.start({
        jobName: 'manual_revision_confirmed',
        triggerType: 'manual',
        triggeredBy: input.triggeredBy ?? null,
        metadata: {
          indicatorCode: indicator.code,
          storedActual: confirmedRevision.storedActual,
          storedActualDate: confirmedRevision.storedActualDate,
          submittedPrevious: input.previous,
          submittedActual: input.actual,
          timestamp: enteredAt,
          user: input.triggeredBy ?? null,
        },
      });
      await dataFetchLogRepository.complete({
        logId: revisionLog.id,
        status: 'success',
      });

      logger.info(
        {
          indicatorCode: indicator.code,
          storedActual: confirmedRevision.storedActual,
          storedActualDate: confirmedRevision.storedActualDate,
          submittedPrevious: input.previous,
          submittedActual: input.actual,
          triggeredBy: input.triggeredBy,
        },
        'Manual revision confirmed',
      );
    }

    logger.info(
      {
        indicatorCode: indicator.code,
        observationDate: input.observationDate.toISOString(),
        value: input.actual,
        forecast: input.forecast,
        previous: input.previous,
        action: upsert.action,
      },
      'Manual data entry recorded',
    );

    return {
      dataPointId: upsert.dataPoint?.id ?? '',
      action: upsert.action,
      indicator: { code: indicator.code, name: indicator.name },
      observationDate: input.observationDate,
      value: input.actual,
      isRateDecision: false,
      forecastValue: input.forecast,
      previousValue: input.previous,
      notes: input.notes,
    };
  } catch (err) {
    await dataFetchLogRepository.complete({
      logId: log.id,
      status: 'failed',
      errors: {
        message: err instanceof Error ? err.message : String(err),
      } as Prisma.InputJsonValue,
    });
    throw err;
  }
}
