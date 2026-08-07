import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { AppError } from '@core/middleware/error-handler';
import { logger } from '@core/utils/logger';
import { dataPointsRepository } from '@core/repositories/data-points.repository';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { calendarEventDeferralsRepository } from '@core/repositories/calendar-event-deferrals.repository';
import { getPriorRateLevel, levelToBpsChange } from './rate-decision.helpers';

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
  // Release variant (Flash/Final, Advance/Second/Third, ...). Required by the
  // admin UI only where the indicator has more than one release type
  // (IndicatorVariant has rows for it) — the frontend derives when to show
  // the selector from that registry, never a hardcoded indicator list.
  // Omitted/null for every single-release indicator, which is the common
  // case and must stay clean. Threaded through to dataPointsRepository.upsert
  // so Flash and Final never collide or get compared against each other.
  variant?: string | null;
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
//
// Same-variant only (B4): comparing a new Flash print's `previous` against
// the last stored FINAL actual (or vice versa) would manufacture a spurious
// revision-confirmation prompt every time, since Flash and Final routinely
// differ from each other by design — that is not a revision, it's two
// different releases. `variant` here is the release being entered now, and
// this looks up the last row with that SAME variant. For a single-release
// indicator (variant null on every row), this is exactly the old behaviour
// (variant: null filters to variant: null, which is everything).
async function getLastStoredActual(
  indicatorId: string,
  variant: string | null,
): Promise<{ value: number; observationDate: Date } | null> {
  const latest = await prisma.dataPoint.findFirst({
    where: { indicatorId, isCurrent: true, variant },
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
  variant: string | null;
  value: number;
  isRateDecision: boolean;
  rateLevel?: number;
  // Change 2 (rate decision scores surprise) — Step 1. Only set for rate
  // decisions when a forecast was submitted: the EXPECTED absolute rate
  // level as entered (same unit as `rateLevel`/`actual`), for display. The
  // stored/scored `forecastValue` below is the bps-change conversion of
  // this value — see levelToBpsChange.
  rateExpectedLevel?: number;
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

  // ── Variant validation ────────────────────────────────────────────────
  // Allowed variants are data (IndicatorVariant), never a hardcoded list —
  // a new release type is a row insert there, never a code change here.
  // Absence of any IndicatorVariant row for this indicator means it is
  // single-release: variant must be omitted/null. Presence of rows means
  // variant is required and must be one of the registered values, so a
  // print can never be silently written without its release type recorded.
  const registeredVariants = await prisma.indicatorVariant.findMany({
    where: { indicatorId: indicator.id },
    select: { variant: true },
  });
  const isMultiVariant = registeredVariants.length > 0;
  const submittedVariant = input.variant ?? null;

  if (isMultiVariant && submittedVariant === null) {
    throw new AppError(
      400,
      `Indicator ${input.indicatorCode} has multiple release types (${registeredVariants
        .map((v) => v.variant)
        .join('/')}); a variant must be selected.`,
      'VARIANT_REQUIRED',
      { indicatorCode: input.indicatorCode, allowedVariants: registeredVariants.map((v) => v.variant) },
    );
  }
  if (
    !isMultiVariant &&
    submittedVariant !== null
  ) {
    throw new AppError(
      400,
      `Indicator ${input.indicatorCode} is single-release; it does not accept a variant.`,
      'VARIANT_NOT_ALLOWED',
      { indicatorCode: input.indicatorCode },
    );
  }
  if (
    isMultiVariant &&
    submittedVariant !== null &&
    !registeredVariants.some((v) => v.variant === submittedVariant)
  ) {
    throw new AppError(
      400,
      `"${submittedVariant}" is not a registered variant for ${input.indicatorCode}.`,
      'VARIANT_UNKNOWN',
      { indicatorCode: input.indicatorCode, allowedVariants: registeredVariants.map((v) => v.variant) },
    );
  }

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
    const lastActual = await getLastStoredActual(indicator.id, submittedVariant);
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

      // Change 2 (rate decision scores surprise) — Step 1. `input.forecast` is
      // the expected absolute rate level, entered the same way `actual` is.
      // Converted to a bps-change delta against the SAME priorRate as `value`
      // uses, so the two land in the same unit and the handler can diff them
      // directly. No prior rate (first release) → no baseline to convert
      // against → forecastBpsChange stays null, same as omitting a forecast.
      const forecastBpsChange = levelToBpsChange(input.forecast, priorRate);

      const sourceMetadata: Prisma.InputJsonObject = {
        manualEntry: true,
        rate_level: input.actual,
        ...(input.forecast !== null ? { expected_rate_level: input.forecast } : {}),
        ...(firstRelease ? { first_release: true } : {}),
        notes: input.notes ?? null,
        enteredAt,
        ...(input.triggeredBy ? { enteredBy: input.triggeredBy } : {}),
      };

      const upsert = await dataPointsRepository.upsert({
        indicatorId: indicator.id,
        observationDate: input.observationDate,
        variant: submittedVariant,
        value: bpsChange,
        forecastValue: forecastBpsChange,
        previousValue: null,
        source: 'manual',
        sourceMetadata,
        fetchedVia: log.id,
        notes: input.notes ?? null,
      });

      // B2 — deferral is a snooze, never a suppression. Entering data always
      // clears the flag regardless of deferral state (indefinite or
      // to-a-date), regardless of whether this indicator was even overdue —
      // the rule is unconditional on the write path, not conditional on the
      // read path finding a match first.
      await calendarEventDeferralsRepository.clearForEntry(indicator.id, submittedVariant);

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
          expectedRateLevel: input.forecast,
          forecastBpsChange,
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
        variant: submittedVariant,
        value: bpsChange,
        isRateDecision: true,
        rateLevel: input.actual,
        ...(input.forecast !== null ? { rateExpectedLevel: input.forecast } : {}),
        forecastValue: forecastBpsChange,
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
      variant: submittedVariant,
      value: input.actual,
      forecastValue: input.forecast,
      previousValue: input.previous,
      source: 'manual',
      sourceMetadata,
      fetchedVia: log.id,
      notes: input.notes ?? null,
    });

    // B2 — deferral is a snooze, never a suppression. See the matching
    // comment on the rate-decision write path above.
    await calendarEventDeferralsRepository.clearForEntry(indicator.id, submittedVariant);

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
      variant: submittedVariant,
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
