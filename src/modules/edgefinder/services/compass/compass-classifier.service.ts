import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import {
  compassClassificationsRepository,
  type PriorClassificationSnapshot,
} from '@core/repositories/compass-classifications.repository';
import { compassConfigRepository } from '@core/repositories/compass-config.repository';
import { compassShockStateRepository } from '@core/repositories/compass-shock-state.repository';
import type { ColorBand } from './compass-bands';
import {
  determineCandidateRegime,
  resolveActiveRegime,
  sumVoteWeights,
  type Regime,
} from './compass-classifier-logic';
import {
  evaluateTriggerA,
  evaluateTriggerB,
  advanceShockState,
  type ShockObservation,
  type ShockTriggerState,
} from './compass-shock-layer';
import { buildCleanSeries, type DatedValue } from './compass-staleness';
import { generateTradingDays } from './validation/historical-backfill.service';
import {
  isRegimePathRiskOff,
  computeRateGateHawkish,
  computeUs02ySma,
  evaluateRateGate,
  evaluateFedConstraintGate,
} from './compass-override-gates';
import { resolveFedConstraint } from './fed-constraint.resolver';

const JOB_NAME = 'compass_classifier_daily_run';

/** The six inputs that VOTE. USDJPY_PRICE is Shock Layer plumbing, never in this list. */
const EXPECTED_INPUT_CODES = [
  'VIX_5D_AVG',
  'HY_OAS',
  'YIELD_2S10S',
  'DXY_TREND',
  'VIX_TERM_STRUCTURE',
  'US_DATA_STACK',
] as const;

// History window for Shock Layer trigger/expiry evaluation: comfortably
// covers Trigger A/B's 5-observation lookbacks plus a 10-trading-day expiry
// window with margin for weekends/holidays already absent from the series.
const SHOCK_HISTORY_DAYS_BACK = 30;

// Phase 6: the rate gate's 21-observation SMA needs ≥21 business days of
// US02Y_CLOSE behind t. 45 calendar days back yields ~31 weekdays — margin
// above 21 plus the Phase 5 forward-fill window.
const US02Y_HISTORY_DAYS_BACK = 45;

export interface RunClassifierResult {
  logId: string;
  status: 'success' | 'skipped_no_inputs' | 'failed';
  classificationDate: Date | null;
  candidateRegime?: Regime;
  activeRegime?: Regime;
  persistenceDaysCount?: number;
  crisisOverrideFired?: boolean;
  finalRegime?: Regime;
  shockAActive?: boolean;
  shockBActive?: boolean;
  action?: 'inserted' | 'revised' | 'skipped';
  reason?: string;
}

function todayUtcDateOnly(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

function decimalToNumber(d: Prisma.Decimal | null): number | null {
  if (d === null) return null;
  return Number(d.toString());
}

/** Read a compass_inputs series (one inputCode) as an ascending {date,value} array from a Decimal column. */
async function readInputSeries(
  inputCode: string,
  field: 'rawValue' | 'derivedValue',
  fromDate: Date,
  toDate: Date,
  isValidation: boolean,
): Promise<ShockObservation[]> {
  const rows = await prisma.compassInput.findMany({
    where: {
      inputCode,
      isValidation,
      observationDate: { gte: fromDate, lte: toDate },
    },
    orderBy: { observationDate: 'asc' },
    select: { observationDate: true, rawValue: true, derivedValue: true },
  });

  const out: ShockObservation[] = [];
  for (const r of rows) {
    const raw = field === 'rawValue' ? r.rawValue : r.derivedValue;
    const value = decimalToNumber(raw);
    if (value !== null) out.push({ date: r.observationDate, value });
  }
  return out;
}

/**
 * Is `series` stale beyond `staleLimitTradingDays` as of `asOfDate`? Reuses
 * compass-staleness.ts's reference-calendar logic (weekday range over the
 * series' own window) purely to answer the yes/no staleness question for
 * Shock Layer trigger-blocking (Phase 5, Task 4) — this does NOT change
 * what values the triggers evaluate against (still the raw stored series),
 * only whether they're allowed to fire at all.
 *
 * KNOWN LIMITATION: compass_inputs rows are always stamped with the INGEST
 * date, even when the ingested value itself was carried forward from a
 * stale source (see each input service's own forward-fill/stale branch in
 * Phase 5). That means this date-gap check alone can only detect a day
 * where ingest was skipped ENTIRELY (an outage) — it cannot see "ingest ran
 * today but the value it wrote was itself stale." That second case is
 * covered separately below by isLatestRowFlaggedStale, which reads the
 * input's own subChecks.stale flag. Neither check attempts to reconstruct
 * the true source-observation date from subChecks — doing so would require
 * threading subChecks.latestRealDate/staleTradingDays back out of every
 * input service into a common shape, which is a larger refactor left for a
 * future phase.
 */
function isSeriesStale(
  series: ShockObservation[],
  asOfDate: Date,
  staleLimitTradingDays: number,
): boolean {
  if (series.length === 0) return true;
  const raw: DatedValue[] = series;
  const referenceCalendar = generateTradingDays(series[0].date, asOfDate);
  const clean = buildCleanSeries(raw, referenceCalendar, asOfDate, staleLimitTradingDays);
  return clean.isStale || clean.latestRealDate === null;
}

/**
 * Does the MOST RECENT compass_inputs row for `inputCode` on `asOfDate`
 * carry its own `subChecks.stale === true` flag? This catches the same-day
 * case isSeriesStale's date-gap check cannot: an input that ran today but
 * whose ingest-time forward-fill logic determined its underlying value was
 * already stale beyond ITS OWN limit (see hy-oas-input.service.ts /
 * vix-input.service.ts / usdjpy-price-input.service.ts's stale branches).
 * USDJPY_PRICE never writes a stale flag (Phase 5 only added history
 * persistence to it, not staleness handling, since it's shock-layer
 * plumbing rather than a voting input with its own band) — for USDJPY this
 * always returns false, leaving isSeriesStale's date-gap check as the only
 * signal for that series.
 */
async function isLatestRowFlaggedStale(
  inputCode: string,
  asOfDate: Date,
  isValidation: boolean,
): Promise<boolean> {
  const row = await prisma.compassInput.findUnique({
    where: {
      observationDate_inputCode_isValidation: {
        observationDate: asOfDate,
        inputCode,
        isValidation,
      },
    },
    select: { subChecks: true },
  });
  const subChecks = row?.subChecks as { stale?: unknown } | null | undefined;
  return subChecks?.stale === true;
}

/**
 * Run the Compass classifier for a given date (defaults to today UTC).
 *
 * Exact daily order (Phase 4):
 *   1. Fetch the 6 voting compass_inputs for the date → compute vote weights → raw candidate.
 *   2. Update the persistence machine → standard_active_regime (crisis-clause-free,
 *      unaware of shocks).
 *   3. Evaluate Trigger A and Trigger B against VIX/OAS/USDJPY history; update
 *      shock states/expiries in compass_shock_state.
 *   4. final_regime = Risk-Off if shockAActive else standard_active_regime.
 *   5. (override assembly — Phase 6; not this phase.)
 *   6. Persist the daily record.
 */
export async function runCompassClassifier(
  triggerType: 'cron' | 'manual',
  triggeredBy?: string | null,
  forDate?: Date,
  isValidation: boolean = false,
): Promise<RunClassifierResult> {
  const classificationDate = forDate ?? todayUtcDateOnly();
  const dateLabel = classificationDate.toISOString().slice(0, 10);

  const log = await dataFetchLogRepository.start({
    jobName: JOB_NAME,
    triggerType,
    triggeredBy: triggeredBy ?? null,
    metadata: { classificationDate: dateLabel, isValidation },
  });

  try {
    const config = await compassConfigRepository.resolveForDate(classificationDate);

    const inputs = await prisma.compassInput.findMany({
      where: {
        observationDate: classificationDate,
        isValidation,
        inputCode: { in: [...EXPECTED_INPUT_CODES] },
      },
    });

    if (inputs.length < EXPECTED_INPUT_CODES.length) {
      const presentCodes = inputs.map((r) => r.inputCode).sort();
      logger.info(
        { jobName: JOB_NAME, classificationDate: dateLabel, presentCodes },
        'Compass classifier: not all 6 inputs present — skipping (non-trading day or ingest gap)',
      );
      await dataFetchLogRepository.complete({
        logId: log.id,
        status: 'success',
        rowsInserted: 0,
        rowsUpdated: 0,
        rowsSkipped: 1,
        metadata: {
          classificationDate: dateLabel,
          reason: 'skipped_no_inputs',
          inputsFound: inputs.length,
          inputsExpected: EXPECTED_INPUT_CODES.length,
        },
      });
      return {
        logId: log.id,
        status: 'skipped_no_inputs',
        classificationDate,
        reason: `Only ${inputs.length}/${EXPECTED_INPUT_CODES.length} inputs present for ${dateLabel}`,
      };
    }

    // --- Step 1: vote weights → raw candidate ---
    const inputsWithBand = inputs.map((r) => ({
      inputCode: r.inputCode,
      colorBand: r.colorBand as ColorBand,
    }));
    const voteWeights = sumVoteWeights(inputsWithBand, config);
    const candidateRegime = determineCandidateRegime({ voteWeights }, config);

    // --- Step 2: persistence machine (crisis-clause-free, shock-unaware) ---
    const prior: PriorClassificationSnapshot | null =
      await compassClassificationsRepository.getMostRecentBefore(
        classificationDate,
        isValidation,
      );

    const { activeRegime, persistenceDaysCount } = resolveActiveRegime(
      { candidateRegime, prior },
      config,
    );

    // --- Step 3: Shock Layer — Trigger A / Trigger B ---
    const historyFrom = new Date(classificationDate);
    historyFrom.setUTCDate(historyFrom.getUTCDate() - SHOCK_HISTORY_DAYS_BACK);

    // US02Y needs a longer window than the shock lookback: the rate gate's
    // 21-observation SMA requires ≥21 business days behind t.
    const us02yHistoryFrom = new Date(classificationDate);
    us02yHistoryFrom.setUTCDate(us02yHistoryFrom.getUTCDate() - US02Y_HISTORY_DAYS_BACK);

    const [vixCloses, vix5dAvgs, oasLevels, usdJpyCloses, us02yCloses] = await Promise.all([
      readInputSeries('VIX_5D_AVG', 'rawValue', historyFrom, classificationDate, isValidation),
      readInputSeries('VIX_5D_AVG', 'derivedValue', historyFrom, classificationDate, isValidation),
      readInputSeries('HY_OAS', 'rawValue', historyFrom, classificationDate, isValidation),
      readInputSeries('USDJPY_PRICE', 'rawValue', historyFrom, classificationDate, isValidation),
      readInputSeries('US02Y_CLOSE', 'rawValue', us02yHistoryFrom, classificationDate, isValidation),
    ]);

    // --- Task 4: trigger-blocked-stale — a trigger evaluates FALSE (never
    // "unknown", never an error) if a series it needs is stale beyond its
    // configured limit. Trigger A needs VIX + HY OAS; Trigger B needs
    // USDJPY + VIX. Forward-filled-but-within-limit data is fine — only
    // beyond-limit staleness blocks. Two independent signals, combined:
    //  1. isSeriesStale: a date-gap in the ingest history itself (an outage
    //     skipped one or more days entirely).
    //  2. isLatestRowFlaggedStale: today's OWN row was flagged stale at
    //     ingest time (a same-day carried-forward value beyond ITS OWN
    //     staleness limit) — see that function's doc comment for why this
    //     is needed in addition to (1).
    const [vixRowStale, oasRowStale, usdJpyRowStale] = await Promise.all([
      isLatestRowFlaggedStale('VIX_5D_AVG', classificationDate, isValidation),
      isLatestRowFlaggedStale('HY_OAS', classificationDate, isValidation),
      isLatestRowFlaggedStale('USDJPY_PRICE', classificationDate, isValidation),
    ]);

    const vixStaleForA =
      isSeriesStale(vixCloses, classificationDate, config.staleness.stale_limit_market_data_days) || vixRowStale;
    const oasStale =
      isSeriesStale(oasLevels, classificationDate, config.staleness.stale_limit_fred_rates_days) || oasRowStale;
    const usdJpyStale =
      isSeriesStale(usdJpyCloses, classificationDate, config.staleness.stale_limit_market_data_days) ||
      usdJpyRowStale;
    const vixStaleForB = vixStaleForA; // same VIX series/limit, evaluated once

    const triggerABlocked = vixStaleForA || oasStale;
    const triggerBBlocked = usdJpyStale || vixStaleForB;

    if (triggerABlocked) {
      logger.warn(
        { jobName: JOB_NAME, classificationDate: dateLabel, vixStale: vixStaleForA, oasStale, event: 'trigger_blocked_stale', trigger: 'A' },
        'Compass Shock Layer: Trigger A blocked — a required series is stale beyond its limit',
      );
    }
    if (triggerBBlocked) {
      logger.warn(
        { jobName: JOB_NAME, classificationDate: dateLabel, usdJpyStale, vixStale: vixStaleForB, event: 'trigger_blocked_stale', trigger: 'B' },
        'Compass Shock Layer: Trigger B blocked — a required series is stale beyond its limit',
      );
    }

    const triggerA = triggerABlocked
      ? { fired: false, asOfDate: classificationDate }
      : evaluateTriggerA(classificationDate, {
          vixCloses,
          oasLevels,
          vixThreshold: config.shockLayer.shock_a_vix_threshold,
          oasDelta5Threshold: config.shockLayer.shock_a_oas_delta5,
        });
    const triggerB = triggerBBlocked
      ? { fired: false, asOfDate: classificationDate }
      : evaluateTriggerB(classificationDate, {
          usdJpyCloses,
          vix5dAvgs,
          usdJpyMove5Threshold: config.shockLayer.shock_b_usdjpy_move5,
        });

    const priorShockState = await compassShockStateRepository.get(isValidation);
    const priorA: ShockTriggerState | null = priorShockState
      ? { active: priorShockState.shockAActive, expiry: priorShockState.shockAExpiry }
      : null;
    const priorB: ShockTriggerState | null = priorShockState
      ? { active: priorShockState.shockBActive, expiry: priorShockState.shockBExpiry }
      : null;

    const nextA = advanceShockState(
      priorA,
      triggerA.fired,
      classificationDate,
      vixCloses,
      config.shockLayer.shock_expiry_trading_days,
    );
    const nextB = advanceShockState(
      priorB,
      triggerB.fired,
      classificationDate,
      usdJpyCloses,
      config.shockLayer.shock_expiry_trading_days,
    );

    await compassShockStateRepository.upsert({
      computedForDate: classificationDate,
      shockAActive: nextA.active,
      shockAExpiry: nextA.expiry,
      shockBActive: nextB.active,
      shockBExpiry: nextB.expiry,
      isValidation,
    });

    // --- Step 4: final regime resolution ---
    const finalRegime: Regime = nextA.active ? 'Risk-Off' : activeRegime;

    // --- Step 5: Phase 6 override gates (Addenda 8A / 8B) ---
    // Computed here (once per date, globally) and persisted for the override
    // assembly path to consume. The gate INPUTS — regime path, rate gate,
    // fed constraint — are all per-date, not per-asset, so the classifier is
    // the single source of truth. Actual per-asset application (which assets
    // the overrides touch) happens in the asset/pair assembly services.
    const regimePathRiskOff = isRegimePathRiskOff({
      finalRegime,
      standardActiveRegime: activeRegime,
      shockAActive: nextA.active,
    });

    // Rate gate (8A): us02y_close(t) vs a 21-obs SMA over the cleaned US02Y
    // series (Phase 5 forward-fill; FRED 5-day staleness limit). If the series
    // is stale beyond limit or too short, the gate FAILS OPEN (hawkish=null →
    // treated NOT hawkish → overrides apply) and records a stale flag.
    const us02yReferenceCalendar =
      us02yCloses.length > 0 ? generateTradingDays(us02yCloses[0].date, classificationDate) : [];
    const us02yClean = buildCleanSeries(
      us02yCloses,
      us02yReferenceCalendar,
      classificationDate,
      config.staleness.stale_limit_fred_rates_days,
    );
    const us02yCleanValues = us02yClean.series.map((o) => o.value);
    const us02yClose =
      us02yClean.isStale || us02yClean.series.length === 0
        ? null
        : us02yClean.series[us02yClean.series.length - 1].value;
    const us02ySma21 =
      us02yClean.isStale
        ? null
        : computeUs02ySma(us02yCleanValues, config.rateGate.rate_gate_sma_window);
    const rateGateHawkish = computeRateGateHawkish(us02yClose, us02ySma21);

    const rateGate = evaluateRateGate({
      enabled: config.rateGate.rate_gate_enabled,
      regimePathRiskOff,
      rateGateHawkish,
      shockBActive: nextB.active,
    });

    // Fed constraint gate (8B): resolve fedConstraint from currency_cycle_stance.
    const fedConstraintResolution = await resolveFedConstraint(classificationDate);
    const fedGate = evaluateFedConstraintGate({
      regimePathRiskOff,
      fedConstraint: fedConstraintResolution.value,
    });

    if (rateGate.staleFailedOpen) {
      logger.warn(
        { jobName: JOB_NAME, classificationDate: dateLabel, staleFlag: 'us02y_gate', event: 'rate_gate_failed_open' },
        'Compass rate gate: US02Y unavailable/stale — failing OPEN (overrides apply)',
      );
    }

    // Post-gate override set (audit): which override codes actually fire given
    // the regime path + gates. This is the GLOBAL set — per-asset applicability
    // (XAUUSD for O2, JPY-quotes for O3/O5) is still resolved in assembly, but
    // this records which overrides were gate-permitted today.
    const overridesActive: string[] = [];
    if (regimePathRiskOff) {
      // Override 1 (bad-news-good-news) & 4 (USD weak jobs) are ungated.
      overridesActive.push('OVERRIDE_1_BAD_NEWS_GOOD_NEWS', 'OVERRIDE_4_USD_WEAK_JOBS');
      if (fedGate.overrideActive) overridesActive.push('OVERRIDE_2_GOLD_INFLATION_HEDGE');
      if (rateGate.overridesActive) {
        overridesActive.push('OVERRIDE_3_JPY_SAFE_HAVEN', 'OVERRIDE_5_CARRY_UNWIND');
      }
    } else if (nextB.active && rateGate.overridesActive) {
      // Trigger B forces Overrides 3 & 5 even when the standard regime path
      // isn't Risk-Off (final_regime is unchanged by Trigger B).
      overridesActive.push('OVERRIDE_3_JPY_SAFE_HAVEN', 'OVERRIDE_5_CARRY_UNWIND');
    }

    const voteBreakdown = {
      inputs: Object.fromEntries(
        inputs.map((r) => [
          r.inputCode,
          {
            colorBand: r.colorBand,
            weight: config.weights[r.inputCode],
          },
        ]),
      ),
      shock: {
        triggerAFired: triggerA.fired,
        triggerBFired: triggerB.fired,
        triggerABlocked,
        triggerBBlocked,
        shockAActive: nextA.active,
        shockAExpiry: nextA.expiry,
        shockBActive: nextB.active,
        shockBExpiry: nextB.expiry,
      },
      gates: {
        regimePathRiskOff,
        us02yClose,
        us02ySma21,
        rateGateHawkish: rateGate.hawkishResolved,
        rateGateStaleFailedOpen: rateGate.staleFailedOpen,
        override3SuppressedByGate: rateGate.suppressedByGate,
        override5SuppressedByGate: rateGate.suppressedByGate,
        fedConstraint: fedConstraintResolution.value,
        fedConstraintEffectiveFrom: fedConstraintResolution.effectiveFrom,
        override2SuppressedByConstraint: fedGate.suppressedByConstraint,
        overridesActive,
      },
    };

    // --- Step 6: persist ---
    const upsertResult = await compassClassificationsRepository.upsert({
      classificationDate,
      candidateRegime,
      activeRegime,
      persistenceDaysCount,
      crisisOverrideFired: false,
      finalRegime,
      shockAActive: nextA.active,
      shockBActive: nextB.active,
      us02yClose,
      us02ySma21,
      rateGateHawkish: rateGate.hawkishResolved,
      override3SuppressedByGate: rateGate.suppressedByGate,
      override5SuppressedByGate: rateGate.suppressedByGate,
      fedConstraint: fedConstraintResolution.value,
      override2SuppressedByConstraint: fedGate.suppressedByConstraint,
      overridesActive,
      totalGreenWeight: voteWeights.green,
      totalYellowWeight: voteWeights.yellow,
      totalRedWeight: voteWeights.red,
      voteBreakdown,
      isValidation,
    });

    await dataFetchLogRepository.complete({
      logId: log.id,
      status: 'success',
      rowsInserted: upsertResult.action === 'inserted' ? 1 : 0,
      rowsUpdated: upsertResult.action === 'revised' ? 1 : 0,
      rowsSkipped: upsertResult.action === 'skipped' ? 1 : 0,
      metadata: {
        classificationDate: dateLabel,
        candidateRegime,
        activeRegime,
        persistenceDaysCount,
        finalRegime,
        shockAActive: nextA.active,
        shockBActive: nextB.active,
        action: upsertResult.action,
      },
    });

    logger.info(
      {
        jobName: JOB_NAME,
        classificationDate: dateLabel,
        candidateRegime,
        activeRegime,
        persistenceDaysCount,
        finalRegime,
        shockAActive: nextA.active,
        shockBActive: nextB.active,
        action: upsertResult.action,
      },
      'Compass classifier run complete',
    );

    return {
      logId: log.id,
      status: 'success',
      classificationDate,
      candidateRegime,
      activeRegime,
      persistenceDaysCount,
      crisisOverrideFired: false,
      finalRegime,
      shockAActive: nextA.active,
      shockBActive: nextB.active,
      action: upsertResult.action,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { jobName: JOB_NAME, classificationDate: dateLabel, message },
      'Compass classifier run failed',
    );
    await dataFetchLogRepository.complete({
      logId: log.id,
      status: 'failed',
      rowsInserted: 0,
      rowsUpdated: 0,
      rowsSkipped: 0,
      errors: { message },
      metadata: { classificationDate: dateLabel },
    });
    return {
      logId: log.id,
      status: 'failed',
      classificationDate,
      reason: message,
    };
  }
}
