import { logger } from '@core/utils/logger';
import { compassFredClient } from '@core/clients/fred/compass-fred.client';
import { compassInputsRepository } from '@core/repositories/compass-inputs.repository';
import {
  computeYoYSequence,
  computeQoQSequence,
  computeSahmRule,
  computeRecentNFPChanges,
  detectTrajectory,
} from '../compass-calculations';
import {
  evaluateCpiTrajectory,
  evaluateGdpLevel,
  evaluateJobs,
  aggregateUsDataStack,
  type ColorBand,
} from '../compass-bands';
import { addDays } from './_input-helpers';

const INPUT_CODE = 'US_DATA_STACK';
const CPI_DAYS = 800;
const GDP_DAYS = 540;
const NFP_DAYS = 200;
const UNRATE_DAYS = 450;

export async function ingestUsDataStackInput(
  observationDate: Date,
  isValidation: boolean = false,
): Promise<void> {
  // Sequential (not Promise.all) to keep concurrent FRED requests low — the
  // public CDN starts returning 403 when many requests hit in rapid bursts,
  // so we trade a small amount of latency for stability across both live
  // and backfill flows.
  const cpiObs = isValidation
    ? await compassFredClient.fetchSeriesByDateRange(
        compassFredClient.SERIES.CPI,
        addDays(observationDate, -CPI_DAYS),
        observationDate,
      )
    : await compassFredClient.fetchSeries(compassFredClient.SERIES.CPI, CPI_DAYS);
  const gdpObs = isValidation
    ? await compassFredClient.fetchSeriesByDateRange(
        compassFredClient.SERIES.GDP,
        addDays(observationDate, -GDP_DAYS),
        observationDate,
      )
    : await compassFredClient.fetchSeries(compassFredClient.SERIES.GDP, GDP_DAYS);
  const payemsObs = isValidation
    ? await compassFredClient.fetchSeriesByDateRange(
        compassFredClient.SERIES.NFP,
        addDays(observationDate, -NFP_DAYS),
        observationDate,
      )
    : await compassFredClient.fetchSeries(compassFredClient.SERIES.NFP, NFP_DAYS);
  const unrateObs = isValidation
    ? await compassFredClient.fetchSeriesByDateRange(
        compassFredClient.SERIES.UNRATE,
        addDays(observationDate, -UNRATE_DAYS),
        observationDate,
      )
    : await compassFredClient.fetchSeries(compassFredClient.SERIES.UNRATE, UNRATE_DAYS);

  const cutoff = observationDate.getTime();
  const filterBefore = <T extends { date: Date; value: number | null }>(arr: T[]): T[] =>
    isValidation ? arr.filter((o) => o.date.getTime() <= cutoff) : arr;

  const cpiLevels = filterBefore(cpiObs).map((o) => o.value).filter((v): v is number => v !== null);
  const gdpLevels = filterBefore(gdpObs).map((o) => o.value).filter((v): v is number => v !== null);
  const payemsLevels = filterBefore(payemsObs).map((o) => o.value).filter((v): v is number => v !== null);
  const unrateLevels = filterBefore(unrateObs).map((o) => o.value).filter((v): v is number => v !== null);

  const yoy = computeYoYSequence(cpiLevels).filter(
    (v): v is number => v !== null,
  );
  const cpiBand: ColorBand =
    yoy.length >= 3
      ? evaluateCpiTrajectory(detectTrajectory(yoy.slice(-3)))
      : 'YELLOW';

  const qoq = computeQoQSequence(gdpLevels).filter(
    (v): v is number => v !== null,
  );
  const gdpBand: ColorBand = evaluateGdpLevel(qoq);

  const sahm = computeSahmRule(unrateLevels);
  const nfpDeltas = computeRecentNFPChanges(payemsLevels);
  const jobsBand: ColorBand = evaluateJobs(
    sahm?.triggered ?? false,
    nfpDeltas,
  );

  const overall = aggregateUsDataStack(cpiBand, gdpBand, jobsBand);

  await compassInputsRepository.upsert({
    observationDate,
    inputCode: INPUT_CODE,
    rawValue: null,
    derivedValue: null,
    colorBand: overall,
    subChecks: {
      cpi: {
        band: cpiBand,
        recentYoY: yoy.slice(-3),
      },
      gdp: {
        band: gdpBand,
        recentQoQ: qoq.slice(-2),
      },
      jobs: {
        band: jobsBand,
        sahm: sahm
          ? {
              threeMonthAvg: sahm.threeMonthAvg,
              twelveMonthLow: sahm.twelveMonthLow,
              delta: sahm.delta,
              triggered: sahm.triggered,
            }
          : null,
        recentNfpChanges: nfpDeltas,
      },
    },
    source: 'fred',
    isValidation,
  });

  logger.info(
    {
      inputCode: INPUT_CODE,
      cpiBand,
      gdpBand,
      jobsBand,
      overall,
      isValidation,
    },
    'Compass: US data stack input ingested',
  );
}
