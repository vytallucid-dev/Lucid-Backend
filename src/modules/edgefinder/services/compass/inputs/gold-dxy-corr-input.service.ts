import { logger } from '@core/utils/logger';
import { eodhdClient } from '@core/clients/eodhd/eodhd.client';
import { compassInputsRepository } from '@core/repositories/compass-inputs.repository';
import {
  alignByDate,
  computePearsonCorrelation,
} from '../compass-calculations';
import { evaluateGoldDxyCorrelation } from '../compass-bands';
import { addDays, toIsoDate } from './_input-helpers';

const INPUT_CODE = 'GOLD_DXY_CORR';
const ROLLING_WINDOW = 60;
const DAYS_BACK = 100;

export async function ingestGoldDxyCorrInput(
  observationDate: Date,
  isValidation: boolean = false,
): Promise<void> {
  // Both symbols share one `from`; EODHD's EOD endpoint has no end date, so the
  // validation upper bound is enforced by the post-fetch filter below.
  const fromIso = toIsoDate(
    isValidation ? addDays(observationDate, -DAYS_BACK) : addDays(new Date(), -DAYS_BACK),
  );

  const [goldRows, dxyRows] = await Promise.all([
    eodhdClient.fetchEodSeries('XAUUSD.FOREX', fromIso),
    eodhdClient.fetchEodSeries('DXY.INDX', fromIso),
  ]);

  const obsIso = toIsoDate(observationDate);
  const goldFiltered = isValidation ? goldRows.filter((p) => p.date <= obsIso) : goldRows;
  const dxyFiltered = isValidation ? dxyRows.filter((p) => p.date <= obsIso) : dxyRows;

  // EODHD returns date as a "YYYY-MM-DD" string; alignByDate keys on Date objects,
  // so convert to UTC-midnight Dates (round-trips through its toISOString slice).
  const goldSeries = goldFiltered.map((p) => ({
    date: new Date(`${p.date}T00:00:00.000Z`),
    value: p.value,
  }));
  const dxySeries = dxyFiltered.map((p) => ({
    date: new Date(`${p.date}T00:00:00.000Z`),
    value: p.value,
  }));

  const aligned = alignByDate(goldSeries, dxySeries);

  if (aligned.xs.length < ROLLING_WINDOW) {
    throw new Error(
      `GOLD_DXY_CORR: insufficient aligned history (got ${aligned.xs.length}, need ${ROLLING_WINDOW})`,
    );
  }

  const xWindow = aligned.xs.slice(-ROLLING_WINDOW);
  const yWindow = aligned.ys.slice(-ROLLING_WINDOW);
  const correlation = computePearsonCorrelation(xWindow, yWindow);

  if (correlation === null) {
    throw new Error('GOLD_DXY_CORR: correlation undefined (zero variance)');
  }

  const colorBand = evaluateGoldDxyCorrelation(correlation);

  await compassInputsRepository.upsert({
    observationDate,
    inputCode: INPUT_CODE,
    rawValue: correlation,
    derivedValue: correlation,
    colorBand,
    subChecks: {
      windowDays: ROLLING_WINDOW,
      alignedRowCount: aligned.xs.length,
      symbols: { gold: 'XAUUSD.FOREX', dxy: 'DXY.INDX' },
    },
    source: 'derived',
    isValidation,
  });

  logger.info(
    {
      inputCode: INPUT_CODE,
      correlation,
      colorBand,
      alignedRowCount: aligned.xs.length,
      isValidation,
    },
    'Compass: Gold/DXY correlation input ingested',
  );
}
