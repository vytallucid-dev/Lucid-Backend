import { logger } from '@core/utils/logger';
import { eodhdClient } from '@core/clients/eodhd/eodhd.client';
import { compassInputsRepository } from '@core/repositories/compass-inputs.repository';
import { evaluateVixTermStructure } from '../compass-bands';
import type { CompassConfigDefinition } from '../compass-config.types';
import { addDays, toIsoDate } from './_input-helpers';
import { buildCleanSeries, type DatedValue } from '../compass-staleness';
import { generateTradingDays } from '../validation/historical-backfill.service';

const INPUT_CODE = 'VIX_TERM_STRUCTURE';
const VIX_SYMBOL = 'VIX.INDX';
const VIX3M_SYMBOL = 'VIX3M.INDX';
const DAYS_BACK = 15;

/**
 * ts_ratio = VIX close / VIX3M close, same observation date, single-day
 * closes (NOT the 5-day average — VIX_5D_AVG is a separate, unchanged input).
 *
 * Phase 5: each side is independently forward-filled up to
 * stale_limit_market_data_days via compass-staleness.ts before the ratio is
 * taken — per the task's explicit rationale, a stale VIX3M against a fresh
 * VIX is a fair, safely-erring approximation (a spot spike against an
 * unchanged 3-month inflates the ratio toward RED, which is correct
 * backwardation-forming behavior). Beyond either side's staleness limit, or
 * with insufficient history to establish a reference calendar, this evaluates
 * YELLOW rather than throwing — never substitute another series for VIX3M.
 */
export async function ingestVixTermStructureInput(
  observationDate: Date,
  config: CompassConfigDefinition,
  isValidation: boolean = false,
): Promise<void> {
  const fromIso = toIsoDate(
    isValidation ? addDays(observationDate, -DAYS_BACK) : addDays(new Date(), -DAYS_BACK),
  );

  const [vixRows, vix3mRows] = await Promise.all([
    eodhdClient.fetchEodSeries(VIX_SYMBOL, fromIso),
    eodhdClient.fetchEodSeries(VIX3M_SYMBOL, fromIso),
  ]);

  const obsIso = toIsoDate(observationDate);
  const vixFiltered = isValidation ? vixRows.filter((p) => p.date <= obsIso) : vixRows;
  const vix3mFiltered = isValidation ? vix3mRows.filter((p) => p.date <= obsIso) : vix3mRows;

  const vixSeries: DatedValue[] = vixFiltered.map((p) => ({
    date: new Date(`${p.date}T00:00:00.000Z`),
    value: p.value,
  }));
  const vix3mSeries: DatedValue[] = vix3mFiltered.map((p) => ({
    date: new Date(`${p.date}T00:00:00.000Z`),
    value: p.value,
  }));

  if (vixSeries.length === 0 || vix3mSeries.length === 0) {
    await compassInputsRepository.upsert({
      observationDate,
      inputCode: INPUT_CODE,
      rawValue: null,
      derivedValue: null,
      colorBand: 'YELLOW',
      subChecks: {
        insufficientHistory: true,
        symbols: { vix: VIX_SYMBOL, vix3m: VIX3M_SYMBOL },
      },
      source: 'derived',
      isValidation,
    });
    logger.warn(
      { inputCode: INPUT_CODE, isValidation },
      'Compass: VIX term structure has zero rows on one side — YELLOW + flagged',
    );
    return;
  }

  const referenceCalendar = generateTradingDays(
    vixSeries[0].date.getTime() <= vix3mSeries[0].date.getTime() ? vixSeries[0].date : vix3mSeries[0].date,
    observationDate,
  );

  const vixClean = buildCleanSeries(
    vixSeries,
    referenceCalendar,
    observationDate,
    config.staleness.stale_limit_market_data_days,
  );
  const vix3mClean = buildCleanSeries(
    vix3mSeries,
    referenceCalendar,
    observationDate,
    config.staleness.stale_limit_market_data_days,
  );

  const vixToday = vixClean.series.at(-1);
  const vix3mToday = vix3mClean.series.at(-1);
  const bothPresent =
    vixToday !== undefined &&
    vix3mToday !== undefined &&
    vixToday.date.getTime() === observationDate.getTime() &&
    vix3mToday.date.getTime() === observationDate.getTime();

  const eitherStale = vixClean.isStale || vix3mClean.isStale;

  let tsRatio: number | null = null;
  if (bothPresent && !eitherStale && vix3mToday.value !== 0) {
    tsRatio = vixToday.value / vix3mToday.value;
  }

  const colorBand = tsRatio === null ? 'YELLOW' : evaluateVixTermStructure(tsRatio, config);

  await compassInputsRepository.upsert({
    observationDate,
    inputCode: INPUT_CODE,
    rawValue: tsRatio,
    derivedValue: tsRatio,
    colorBand,
    subChecks: {
      vix3mAvailable: bothPresent,
      symbols: { vix: VIX_SYMBOL, vix3m: VIX3M_SYMBOL },
      vixStale: vixClean.isStale,
      vix3mStale: vix3mClean.isStale,
      staleLimitDays: config.staleness.stale_limit_market_data_days,
    },
    source: 'derived',
    isValidation,
  });

  logger.info(
    {
      inputCode: INPUT_CODE,
      tsRatio,
      colorBand,
      vix3mAvailable: bothPresent,
      eitherStale,
      isValidation,
    },
    'Compass: VIX term structure input ingested',
  );
}
