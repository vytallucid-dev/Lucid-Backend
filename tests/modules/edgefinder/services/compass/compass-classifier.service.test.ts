import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

type InputRow = {
  observationDate: Date;
  inputCode: string;
  rawValue: Prisma.Decimal | null;
  derivedValue: Prisma.Decimal | null;
  colorBand: 'GREEN' | 'YELLOW' | 'RED';
};

const state: { inputs: InputRow[] } = { inputs: [] };

vi.mock('@core/db/prisma', () => ({
  prisma: {
    compassInput: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { observationDate: Date; isValidation?: boolean };
        }) => {
          void where.isValidation;
          return state.inputs.filter(
            (r) =>
              (r.observationDate as Date).getTime() ===
              (where.observationDate as Date).getTime(),
          );
        },
      ),
    },
  },
}));

import { prisma } from '@core/db/prisma';
const prismaFindMany = prisma.compassInput.findMany as unknown as ReturnType<typeof vi.fn>;

vi.mock('@core/repositories/data-fetch-log.repository', () => ({
  dataFetchLogRepository: {
    start: vi.fn(),
    complete: vi.fn(),
  },
}));

vi.mock('@core/repositories/compass-classifications.repository', () => ({
  compassClassificationsRepository: {
    upsert: vi.fn(),
    getMostRecentBefore: vi.fn(),
  },
}));

import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { compassClassificationsRepository } from '@core/repositories/compass-classifications.repository';
import { runCompassClassifier } from '@modules/edgefinder/services/compass/compass-classifier.service';

const mockedStart = dataFetchLogRepository.start as unknown as ReturnType<typeof vi.fn>;
const mockedComplete = dataFetchLogRepository.complete as unknown as ReturnType<typeof vi.fn>;
const mockedUpsert = compassClassificationsRepository.upsert as unknown as ReturnType<typeof vi.fn>;
const mockedGetMostRecent =
  compassClassificationsRepository.getMostRecentBefore as unknown as ReturnType<typeof vi.fn>;

const DATE = new Date(Date.UTC(2026, 4, 19));

function inputRow(
  code: string,
  colorBand: 'GREEN' | 'YELLOW' | 'RED',
  opts: { rawValue?: number | null; derivedValue?: number | null } = {},
): InputRow {
  return {
    observationDate: DATE,
    inputCode: code,
    rawValue:
      opts.rawValue === undefined || opts.rawValue === null
        ? null
        : new Prisma.Decimal(opts.rawValue),
    derivedValue:
      opts.derivedValue === undefined || opts.derivedValue === null
        ? null
        : new Prisma.Decimal(opts.derivedValue),
    colorBand,
  };
}

function setAllSixInputs(rows: InputRow[]): void {
  state.inputs = rows;
}

function defaultGreenInputs(): InputRow[] {
  return [
    inputRow('VIX_5D_AVG', 'GREEN', { rawValue: 15, derivedValue: 17.5 }),
    inputRow('HY_OAS', 'GREEN', { rawValue: 2.8, derivedValue: -0.1 }),
    inputRow('YIELD_2S10S', 'GREEN', { rawValue: 0.3, derivedValue: 0.2 }),
    inputRow('DXY_TREND', 'GREEN', { rawValue: 100, derivedValue: 2.5 }),
    inputRow('GOLD_DXY_CORR', 'GREEN', { rawValue: -0.7, derivedValue: null }),
    inputRow('US_DATA_STACK', 'GREEN'),
  ];
}

function defaultYellowInputs(): InputRow[] {
  return [
    inputRow('VIX_5D_AVG', 'YELLOW', { rawValue: 20, derivedValue: 21 }),
    inputRow('HY_OAS', 'YELLOW', { rawValue: 5.0, derivedValue: 0 }),
    inputRow('YIELD_2S10S', 'YELLOW', { rawValue: 0.1, derivedValue: 0 }),
    inputRow('DXY_TREND', 'YELLOW', { rawValue: 100, derivedValue: 0.5 }),
    inputRow('GOLD_DXY_CORR', 'YELLOW', { rawValue: -0.3, derivedValue: null }),
    inputRow('US_DATA_STACK', 'YELLOW'),
  ];
}

describe('runCompassClassifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.inputs = [];
    mockedStart.mockResolvedValue({ id: 'log-1' });
    mockedComplete.mockResolvedValue(undefined);
    mockedGetMostRecent.mockResolvedValue(null);
    mockedUpsert.mockResolvedValue({ id: 'cc-1', action: 'inserted' });
  });

  it('skipped_no_inputs when fewer than 6 inputs present', async () => {
    setAllSixInputs(defaultGreenInputs().slice(0, 5));
    const result = await runCompassClassifier('manual', null, DATE);
    expect(result.status).toBe('skipped_no_inputs');
    expect(mockedUpsert).not.toHaveBeenCalled();
    expect(mockedComplete).toHaveBeenCalledTimes(1);
    expect(mockedComplete.mock.calls[0][0].metadata.reason).toBe('skipped_no_inputs');
  });

  it('all-yellow inputs with no prior → candidate Caution, active Caution, count 0, inserted', async () => {
    setAllSixInputs(defaultYellowInputs());
    const result = await runCompassClassifier('manual', null, DATE);
    expect(result.status).toBe('success');
    expect(result.candidateRegime).toBe('Caution');
    expect(result.activeRegime).toBe('Caution');
    expect(result.persistenceDaysCount).toBe(0);
    expect(result.crisisOverrideFired).toBe(false);
    expect(result.action).toBe('inserted');
    expect(mockedUpsert).toHaveBeenCalledTimes(1);
    const upsertCall = mockedUpsert.mock.calls[0][0];
    expect(upsertCall.totalYellowWeight).toBeCloseTo(8.0);
    expect(upsertCall.totalGreenWeight).toBeCloseTo(0);
    expect(upsertCall.totalRedWeight).toBeCloseTo(0);
  });

  it('all-green inputs → candidate Risk-On (green=8, red=0), bootstrap active Caution count=1', async () => {
    setAllSixInputs(defaultGreenInputs());
    const result = await runCompassClassifier('manual', null, DATE);
    expect(result.candidateRegime).toBe('Risk-On');
    expect(result.activeRegime).toBe('Caution');
    expect(result.persistenceDaysCount).toBe(1);
  });

  it('crisis fires: VIX derived=35, HY raw=8 → active Risk-Off, crisisOverrideFired=true', async () => {
    const rows = defaultYellowInputs();
    rows[0] = inputRow('VIX_5D_AVG', 'RED', { rawValue: 33, derivedValue: 35 });
    rows[1] = inputRow('HY_OAS', 'RED', { rawValue: 8.0, derivedValue: 0.5 });
    setAllSixInputs(rows);
    const result = await runCompassClassifier('manual', null, DATE);
    expect(result.crisisOverrideFired).toBe(true);
    expect(result.candidateRegime).toBe('Risk-Off');
    expect(result.activeRegime).toBe('Risk-Off');
    expect(result.persistenceDaysCount).toBe(0);
    const breakdown = mockedUpsert.mock.calls[0][0].voteBreakdown;
    expect(breakdown.crisis.fired).toBe(true);
    expect(breakdown.crisis.vixFiveDayAvg).toBe(35);
    expect(breakdown.crisis.hyOasLevel).toBe(8.0);
  });

  it('crisis does NOT fire when HY exactly 7.0 (strict >)', async () => {
    const rows = defaultYellowInputs();
    rows[0] = inputRow('VIX_5D_AVG', 'RED', { rawValue: 33, derivedValue: 35 });
    rows[1] = inputRow('HY_OAS', 'YELLOW', { rawValue: 7.0, derivedValue: 0 });
    setAllSixInputs(rows);
    const result = await runCompassClassifier('manual', null, DATE);
    expect(result.crisisOverrideFired).toBe(false);
  });

  it('prior active Caution + 4-day Risk-Off streak + today Risk-Off → flips to Risk-Off', async () => {
    const rows = defaultYellowInputs();
    rows[1] = inputRow('HY_OAS', 'RED', { rawValue: 6.5, derivedValue: 0.5 });
    rows[2] = inputRow('YIELD_2S10S', 'RED', { rawValue: -0.5, derivedValue: 0.2 });
    rows[5] = inputRow('US_DATA_STACK', 'RED');
    setAllSixInputs(rows);
    mockedGetMostRecent.mockResolvedValue({
      classificationDate: new Date(Date.UTC(2026, 4, 18)),
      activeRegime: 'Caution',
      candidateRegime: 'Risk-Off',
      persistenceDaysCount: 4,
    });
    const result = await runCompassClassifier('manual', null, DATE);
    expect(result.candidateRegime).toBe('Risk-Off');
    expect(result.activeRegime).toBe('Risk-Off');
    expect(result.persistenceDaysCount).toBe(0);
  });

  it('prior active Caution + 3-day Risk-Off streak + today Caution → streak resets, stays Caution', async () => {
    setAllSixInputs(defaultYellowInputs());
    mockedGetMostRecent.mockResolvedValue({
      classificationDate: new Date(Date.UTC(2026, 4, 18)),
      activeRegime: 'Caution',
      candidateRegime: 'Risk-Off',
      persistenceDaysCount: 3,
    });
    const result = await runCompassClassifier('manual', null, DATE);
    expect(result.candidateRegime).toBe('Caution');
    expect(result.activeRegime).toBe('Caution');
    expect(result.persistenceDaysCount).toBe(0);
  });

  it('idempotent: action propagates skipped from repository', async () => {
    setAllSixInputs(defaultYellowInputs());
    mockedUpsert.mockResolvedValue({ id: 'cc-1', action: 'skipped' });
    const result = await runCompassClassifier('manual', null, DATE);
    expect(result.action).toBe('skipped');
    expect(mockedComplete.mock.calls[0][0].rowsSkipped).toBe(1);
    expect(mockedComplete.mock.calls[0][0].rowsInserted).toBe(0);
  });

  it('uses forDate for both input lookup and prior lookup', async () => {
    const backfillDate = new Date(Date.UTC(2026, 3, 10));
    state.inputs = defaultYellowInputs().map((r) => ({ ...r, observationDate: backfillDate }));
    await runCompassClassifier('manual', null, backfillDate);
    expect(prismaFindMany).toHaveBeenCalledWith({
      where: { observationDate: backfillDate, isValidation: false },
    });
    expect(mockedGetMostRecent).toHaveBeenCalledWith(backfillDate, false);
  });

  it('writes voteBreakdown with all 6 inputs and weights', async () => {
    setAllSixInputs(defaultYellowInputs());
    await runCompassClassifier('manual', null, DATE);
    const breakdown = mockedUpsert.mock.calls[0][0].voteBreakdown;
    expect(Object.keys(breakdown.inputs).sort()).toEqual(
      ['DXY_TREND', 'GOLD_DXY_CORR', 'HY_OAS', 'US_DATA_STACK', 'VIX_5D_AVG', 'YIELD_2S10S'],
    );
    expect(breakdown.inputs.VIX_5D_AVG.weight).toBe(1.0);
    expect(breakdown.inputs.US_DATA_STACK.weight).toBe(2.0);
    expect(breakdown.inputs.HY_OAS.colorBand).toBe('YELLOW');
  });

  it('writes a data_fetch_log row (start + complete) with classifier job name', async () => {
    setAllSixInputs(defaultYellowInputs());
    await runCompassClassifier('cron', null, DATE);
    expect(mockedStart).toHaveBeenCalledTimes(1);
    expect(mockedStart.mock.calls[0][0].jobName).toBe('compass_classifier_daily_run');
    expect(mockedStart.mock.calls[0][0].triggerType).toBe('cron');
    expect(mockedComplete).toHaveBeenCalledTimes(1);
    expect(mockedComplete.mock.calls[0][0].status).toBe('success');
  });

  it('returns failed status and writes failed log when upsert throws', async () => {
    setAllSixInputs(defaultYellowInputs());
    mockedUpsert.mockRejectedValue(new Error('db down'));
    const result = await runCompassClassifier('manual', null, DATE);
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('db down');
    expect(mockedComplete.mock.calls[0][0].status).toBe('failed');
  });
});
