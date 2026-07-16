import { logger } from '@core/utils/logger';
import { compassFredClient } from '@core/clients/fred/compass-fred.client';
import { compassInputsRepository } from '@core/repositories/compass-inputs.repository';
import { addDays } from './_input-helpers';

/**
 * US 2-year Treasury raw daily close (FRED DGS2) — Phase 6 Addendum 8A rate
 * gate plumbing ONLY. This is NOT one of the six voting Compass inputs: it
 * carries no colorBand semantics (stored as 'YELLOW' placeholder, never read)
 * and is deliberately excluded from EXPECTED_INPUT_CODES / config.weights /
 * sumVoteWeights in compass-classifier.service.ts.
 *
 * Task 0.1 recon (Phase 6) confirmed the raw DGS2 daily close is stored
 * nowhere Compass can read — the EdgeFinder `US_02Y_SMA` indicator persists
 * only the already-computed 21d SMA in data_points and discards the raw daily
 * yield. The rate gate (`us02y_close(t) > us02y_sma21(t)`) needs BOTH the raw
 * close and a 21-observation SMA, so Compass fetches DGS2 itself, mirroring
 * usdjpy-price-input.service.ts (Phase 4/5): fetch a window, persist EVERY
 * observation as its own compass_inputs row, so the gate's 21-obs SMA can be
 * computed from stored history from day one.
 *
 * FRED rate-limits parallel bursts (see us-data-stack-input.service.ts) — this
 * is a single sequential fetch, no Promise.all.
 */
const INPUT_CODE = 'US02Y_CLOSE';
// 40 calendar days back yields ~28 business days — comfortably above the 21
// observations the SMA needs, with margin for the Phase 5 forward-fill window.
const DAYS_BACK = 40;

export async function ingestUs02yCloseInput(
  observationDate: Date,
  isValidation: boolean = false,
): Promise<void> {
  const obs = isValidation
    ? await compassFredClient.fetchSeriesByDateRange(
        compassFredClient.SERIES.US_02Y,
        addDays(observationDate, -DAYS_BACK),
        observationDate,
      )
    : await compassFredClient.fetchSeries(compassFredClient.SERIES.US_02Y, DAYS_BACK);

  const windowed = isValidation
    ? obs.filter((o) => o.date.getTime() <= observationDate.getTime())
    : obs;

  const usable = windowed.filter(
    (o): o is { date: Date; value: number } => o.value !== null,
  );

  if (usable.length === 0) {
    throw new Error('US02Y_CLOSE: FRED returned zero usable values');
  }

  for (const point of usable) {
    await compassInputsRepository.upsert({
      observationDate: point.date,
      inputCode: INPUT_CODE,
      rawValue: point.value,
      derivedValue: null,
      colorBand: 'YELLOW',
      subChecks: { lastDate: point.date.toISOString().slice(0, 10) },
      source: 'fred',
      isValidation,
    });
  }

  const todayClose = usable[usable.length - 1].value;

  logger.info(
    { inputCode: INPUT_CODE, todayClose, observationsPersisted: usable.length, isValidation },
    'Compass: US02Y close input ingested (rate-gate plumbing, non-voting)',
  );
}
