import { logger } from '@core/utils/logger';
import { eodhdClient } from '@core/clients/eodhd/eodhd.client';
import { compassInputsRepository } from '@core/repositories/compass-inputs.repository';
import { addDays, toIsoDate } from './_input-helpers';

/**
 * USDJPY daily close price — Shock Layer plumbing ONLY (Trigger B / Carry
 * Shock needs the signed 5-observation move). This is NOT one of the six
 * voting Compass inputs: it carries no colorBand semantics (stored as
 * 'YELLOW' placeholder, never read) and is deliberately excluded from
 * EXPECTED_INPUT_CODES / config.weights / sumVoteWeights in
 * compass-classifier.service.ts.
 *
 * No USDJPY price series existed anywhere in the codebase prior to this
 * (Task 0 investigation, Phase 4) — EdgeFinder's USDJPY entity is a scoring
 * Asset/Indicator reference, not a price feed. This mirrors vix-input.service.ts's
 * EODHD fetch pattern exactly, stored as its own compass_inputs row
 * (inputCode='USDJPY_PRICE') for the same audit/re-read consistency as every
 * other Compass series, rather than a fetch-on-demand call inside the shock
 * evaluator.
 *
 * Phase 5 fix: the shock layer reads USDJPY history from STORED
 * compass_inputs rows (readInputSeries in compass-classifier.service.ts), so
 * persisting only today's close left every day but the most recent one
 * missing — Trigger B's 5-observation lookback could never resolve past
 * "n/a". This now persists EVERY observation in the fetched window as its
 * own row (one upsert per date), the same shape a day-by-day backfill would
 * produce. Idempotent: compassInputsRepository.upsert is itself idempotent
 * per (observationDate, inputCode, isValidation), so re-running over an
 * already-ingested window updates in place rather than duplicating.
 */
const INPUT_CODE = 'USDJPY_PRICE';
const SYMBOL = 'USDJPY.FOREX';
const DAYS_BACK = 15;

export async function ingestUsdJpyPriceInput(
  observationDate: Date,
  isValidation: boolean = false,
): Promise<void> {
  const fromIso = toIsoDate(
    isValidation ? addDays(observationDate, -DAYS_BACK) : addDays(new Date(), -DAYS_BACK),
  );

  const rows = await eodhdClient.fetchEodSeries(SYMBOL, fromIso);

  const obsIso = toIsoDate(observationDate);
  const windowed = isValidation ? rows.filter((p) => p.date <= obsIso) : rows;

  if (windowed.length === 0) {
    throw new Error('USDJPY_PRICE: EODHD returned zero rows');
  }

  for (const point of windowed) {
    await compassInputsRepository.upsert({
      observationDate: new Date(`${point.date}T00:00:00.000Z`),
      inputCode: INPUT_CODE,
      rawValue: point.value,
      derivedValue: null,
      colorBand: 'YELLOW',
      subChecks: { lastDate: point.date },
      source: 'eodhd',
      isValidation,
    });
  }

  const todayClose = windowed[windowed.length - 1].value;

  logger.info(
    { inputCode: INPUT_CODE, todayClose, observationsPersisted: windowed.length, isValidation },
    'Compass: USDJPY price input ingested (shock-layer plumbing, non-voting)',
  );
}
