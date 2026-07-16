/* eslint-disable no-console */
/**
 * Compass v2 Phase 5 verification — read-only, writes nothing.
 *
 * For each live (isValidation=false) compass_inputs date on or after v2
 * activation, reports per series: latest observation date, staleness in
 * trading days, whether the row was forward-filled/flagged stale at ingest
 * time, plus the existing per-input bands, weights (8.0), trigger
 * evaluations, and final regime (same shape as verify-compass-phase4.ts).
 *
 * Read-only: does not call runCompassClassifier, does not write to
 * compass_classifications / compass_shock_state / compass_inputs. It only
 * reads what is already persisted and recomputes in-memory using the live
 * code path (compass-classifier-logic.ts / compass-shock-layer.ts /
 * compass-staleness.ts).
 */
import { prisma } from '@core/db/prisma';
import { compassConfigRepository } from '@core/repositories/compass-config.repository';
import {
  determineCandidateRegime,
  resolveActiveRegime,
  sumVoteWeights,
  type Regime,
} from '@modules/edgefinder/services/compass/compass-classifier-logic';
import {
  evaluateTriggerA,
  evaluateTriggerB,
  type ShockObservation,
} from '@modules/edgefinder/services/compass/compass-shock-layer';
import { buildCleanSeries, type DatedValue } from '@modules/edgefinder/services/compass/compass-staleness';
import { generateTradingDays } from '@modules/edgefinder/services/compass/validation/historical-backfill.service';
import type { ColorBand } from '@modules/edgefinder/services/compass/compass-bands';

const DAYS_TO_CHECK = Number(process.argv[2] ?? 10);

const V2_ACTIVATION_DATE = new Date('2026-07-16');
const SHOCK_HISTORY_DAYS_BACK = 30;

const EXPECTED_INPUT_CODES = [
  'VIX_5D_AVG',
  'HY_OAS',
  'YIELD_2S10S',
  'DXY_TREND',
  'VIX_TERM_STRUCTURE',
  'US_DATA_STACK',
] as const;

function decimalToNumber(d: unknown): number | null {
  if (d === null || d === undefined) return null;
  return Number((d as { toString(): string }).toString());
}

async function readInputSeries(
  inputCode: string,
  field: 'rawValue' | 'derivedValue',
  fromDate: Date,
  toDate: Date,
): Promise<ShockObservation[]> {
  const rows = await prisma.compassInput.findMany({
    where: {
      inputCode,
      isValidation: false,
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

interface StalenessReport {
  latestObservationDate: string | null;
  staleTradingDays: number | null;
  forwardFilled: boolean;
  isStale: boolean;
}

async function reportStaleness(
  inputCode: string,
  field: 'rawValue' | 'derivedValue',
  asOfDate: Date,
  staleLimitTradingDays: number,
): Promise<StalenessReport> {
  const historyFrom = new Date(asOfDate);
  historyFrom.setUTCDate(historyFrom.getUTCDate() - SHOCK_HISTORY_DAYS_BACK);
  const series = await readInputSeries(inputCode, field, historyFrom, asOfDate);

  if (series.length === 0) {
    return { latestObservationDate: null, staleTradingDays: null, forwardFilled: false, isStale: true };
  }

  const raw: DatedValue[] = series;
  const referenceCalendar = generateTradingDays(series[0].date, asOfDate);
  const clean = buildCleanSeries(raw, referenceCalendar, asOfDate, staleLimitTradingDays);

  const todayIsReal = series.some((o) => o.date.getTime() === asOfDate.getTime());

  return {
    latestObservationDate: clean.latestRealDate?.toISOString().slice(0, 10) ?? null,
    staleTradingDays: clean.staleTradingDays,
    forwardFilled: !todayIsReal && clean.series.some((o) => o.date.getTime() === asOfDate.getTime()),
    isStale: clean.isStale,
  };
}

async function main(): Promise<void> {
  const recentClassifications = await prisma.compassClassification.findMany({
    where: {
      isCurrent: true,
      isValidation: false,
      classificationDate: { gte: V2_ACTIVATION_DATE },
    },
    orderBy: { classificationDate: 'desc' },
    take: DAYS_TO_CHECK,
  });

  if (recentClassifications.length === 0) {
    console.log(
      `No live compass_classifications rows on or after v2 activation (${V2_ACTIVATION_DATE.toISOString().slice(0, 10)}) — nothing to verify yet.`,
    );
    return;
  }

  const days = [...recentClassifications].reverse(); // ascending

  for (const day of days) {
    const dateLabel = day.classificationDate.toISOString().slice(0, 10);
    console.log(`\n=== ${dateLabel} ===`);

    const config = await compassConfigRepository.resolveForDate(day.classificationDate);
    const weightTotal = Object.values(config.weights).reduce((s, w) => s + w, 0);
    console.log(`  config weights sum: ${weightTotal} ${weightTotal === 8.0 ? '(OK)' : '(MISMATCH — STOP)'}`);

    if (!config.staleness) {
      console.log(
        '  staleness config: MISSING — the active compass_config row has not been reseeded yet. ' +
          'Run `npm run db:seed:compass-config` (see Phase 5 report) before this script can report staleness.',
      );
      continue;
    }
    console.log(
      `  staleness config: market_data_limit=${config.staleness.stale_limit_market_data_days}d fred_rates_limit=${config.staleness.stale_limit_fred_rates_days}d forward_fill_enabled=${config.staleness.forward_fill_enabled}`,
    );

    console.log('  --- per-series staleness ---');
    const marketDataLimit = config.staleness.stale_limit_market_data_days;
    const fredLimit = config.staleness.stale_limit_fred_rates_days;
    const [vixReport, dxyReport, oasReport, curveReport, usdJpyReport] = await Promise.all([
      reportStaleness('VIX_5D_AVG', 'rawValue', day.classificationDate, marketDataLimit),
      reportStaleness('DXY_TREND', 'rawValue', day.classificationDate, marketDataLimit),
      reportStaleness('HY_OAS', 'rawValue', day.classificationDate, fredLimit),
      reportStaleness('YIELD_2S10S', 'rawValue', day.classificationDate, fredLimit),
      reportStaleness('USDJPY_PRICE', 'rawValue', day.classificationDate, marketDataLimit),
    ]);
    for (const [label, r] of [
      ['VIX_5D_AVG', vixReport],
      ['DXY_TREND', dxyReport],
      ['HY_OAS', oasReport],
      ['YIELD_2S10S', curveReport],
      ['USDJPY_PRICE', usdJpyReport],
    ] as const) {
      console.log(
        `    ${label}: latest=${r.latestObservationDate ?? 'n/a'} staleTradingDays=${r.staleTradingDays ?? 'n/a'} forwardFilled=${r.forwardFilled} stale=${r.isStale}`,
      );
    }

    const inputs = await prisma.compassInput.findMany({
      where: {
        observationDate: day.classificationDate,
        isValidation: false,
        inputCode: { in: [...EXPECTED_INPUT_CODES] },
      },
    });

    if (inputs.length < EXPECTED_INPUT_CODES.length) {
      console.log(`  SKIP — only ${inputs.length}/${EXPECTED_INPUT_CODES.length} voting inputs present`);
      continue;
    }

    console.log('  --- per-input bands ---');
    for (const r of inputs) {
      const subChecks = r.subChecks as { stale?: boolean; insufficientHistory?: boolean } | null;
      console.log(
        `    ${r.inputCode}: band=${r.colorBand} weight=${config.weights[r.inputCode]} stale=${subChecks?.stale ?? false} insufficientHistory=${subChecks?.insufficientHistory ?? false}`,
      );
    }

    const inputsWithBand = inputs.map((r) => ({
      inputCode: r.inputCode,
      colorBand: r.colorBand as ColorBand,
    }));
    const voteWeights = sumVoteWeights(inputsWithBand, config);
    const rawLabel = determineCandidateRegime({ voteWeights }, config);

    const priorRow = await prisma.compassClassification.findFirst({
      where: {
        isCurrent: true,
        isValidation: false,
        classificationDate: { lt: day.classificationDate },
      },
      orderBy: { classificationDate: 'desc' },
    });
    const prior = priorRow
      ? {
          activeRegime: priorRow.activeRegime as Regime,
          candidateRegime: priorRow.candidateRegime as Regime,
          persistenceDaysCount: priorRow.persistenceDaysCount,
        }
      : null;

    const { activeRegime: standardActiveRegime, persistenceDaysCount } = resolveActiveRegime(
      { candidateRegime: rawLabel, prior },
      config,
    );

    const historyFrom = new Date(day.classificationDate);
    historyFrom.setUTCDate(historyFrom.getUTCDate() - SHOCK_HISTORY_DAYS_BACK);

    const [vixCloses, vix5dAvgs, oasLevels, usdJpyCloses] = await Promise.all([
      readInputSeries('VIX_5D_AVG', 'rawValue', historyFrom, day.classificationDate),
      readInputSeries('VIX_5D_AVG', 'derivedValue', historyFrom, day.classificationDate),
      readInputSeries('HY_OAS', 'rawValue', historyFrom, day.classificationDate),
      readInputSeries('USDJPY_PRICE', 'rawValue', historyFrom, day.classificationDate),
    ]);

    const triggerA = evaluateTriggerA(day.classificationDate, {
      vixCloses,
      oasLevels,
      vixThreshold: config.shockLayer.shock_a_vix_threshold,
      oasDelta5Threshold: config.shockLayer.shock_a_oas_delta5,
    });
    const triggerB = evaluateTriggerB(day.classificationDate, {
      usdJpyCloses,
      vix5dAvgs,
      usdJpyMove5Threshold: config.shockLayer.shock_b_usdjpy_move5,
    });

    console.log(
      `  Trigger A recomputed=${triggerA.fired} (blocked-if-stale is evaluated live in compass-classifier.service.ts, not recomputed here)`,
    );
    console.log(`  Trigger B recomputed=${triggerB.fired}`);

    console.log(`  standard_active_regime=${standardActiveRegime} (persistenceDaysCount=${persistenceDaysCount})`);
    console.log(
      `  persisted: shockAActive=${day.shockAActive} shockBActive=${day.shockBActive} finalRegime=${day.finalRegime || '(empty — pre-Phase-4 row)'}`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
