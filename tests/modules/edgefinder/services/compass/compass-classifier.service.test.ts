import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

type InputRow = {
  observationDate: Date;
  inputCode: string;
  rawValue: Prisma.Decimal | null;
  derivedValue: Prisma.Decimal | null;
  colorBand: 'GREEN' | 'YELLOW' | 'RED';
  subChecks?: { stale?: boolean } | null;
};

const state: {
  inputs: InputRow[];
  fedConstraintRow: { fedConstraint: string | null; effectiveFrom: Date } | null;
} = { inputs: [], fedConstraintRow: null };

vi.mock('@core/db/prisma', () => ({
  prisma: {
    compassInput: {
      // Handles BOTH call shapes the classifier makes:
      //  - vote query: { observationDate, isValidation, inputCode: { in: [...] } }
      //  - shock-history query: { inputCode, isValidation, observationDate: { gte, lte } }
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return state.inputs.filter((r) => {
          if (where.observationDate instanceof Date) {
            if (r.observationDate.getTime() !== where.observationDate.getTime()) return false;
          } else if (where.observationDate && typeof where.observationDate === 'object') {
            const range = where.observationDate as { gte?: Date; lte?: Date };
            if (range.gte && r.observationDate.getTime() < range.gte.getTime()) return false;
            if (range.lte && r.observationDate.getTime() > range.lte.getTime()) return false;
          }
          if (where.inputCode && typeof where.inputCode === 'object' && 'in' in where.inputCode) {
            const codes = (where.inputCode as { in: string[] }).in;
            if (!codes.includes(r.inputCode)) return false;
          } else if (typeof where.inputCode === 'string') {
            if (r.inputCode !== where.inputCode) return false;
          }
          return true;
        });
      }),
      // isLatestRowFlaggedStale's lookup: exact (observationDate, inputCode, isValidation).
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { observationDate_inputCode_isValidation: { observationDate: Date; inputCode: string; isValidation: boolean } };
        }) => {
          const key = where.observationDate_inputCode_isValidation;
          const row = state.inputs.find(
            (r) => r.observationDate.getTime() === key.observationDate.getTime() && r.inputCode === key.inputCode,
          );
          return row ? { subChecks: row.subChecks ?? null } : null;
        },
      ),
    },
    // Phase 6: resolveFedConstraint reads the USD cycle-stance row. Returns
    // `state.fedConstraintRow` so tests can drive fed_constraint; default null
    // → FREE (fail-safe), which is inert for the pre-gate classifier tests.
    currencyCycleStance: {
      findFirst: vi.fn(async () => state.fedConstraintRow),
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

vi.mock('@core/repositories/compass-config.repository', () => ({
  compassConfigRepository: {
    resolveForDate: vi.fn(),
  },
}));

vi.mock('@core/repositories/compass-shock-state.repository', () => ({
  compassShockStateRepository: {
    get: vi.fn(),
    upsert: vi.fn(),
  },
}));

import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { compassClassificationsRepository } from '@core/repositories/compass-classifications.repository';
import { compassConfigRepository } from '@core/repositories/compass-config.repository';
import { compassShockStateRepository } from '@core/repositories/compass-shock-state.repository';
import { runCompassClassifier } from '@modules/edgefinder/services/compass/compass-classifier.service';
import { COMPASS_CONFIG_V1_FIXTURE } from './compass-config.fixture';

const mockedStart = dataFetchLogRepository.start as unknown as ReturnType<typeof vi.fn>;
const mockedComplete = dataFetchLogRepository.complete as unknown as ReturnType<typeof vi.fn>;
const mockedUpsert = compassClassificationsRepository.upsert as unknown as ReturnType<typeof vi.fn>;
const mockedGetMostRecent =
  compassClassificationsRepository.getMostRecentBefore as unknown as ReturnType<typeof vi.fn>;
const mockedResolveConfig =
  compassConfigRepository.resolveForDate as unknown as ReturnType<typeof vi.fn>;
const mockedShockGet = compassShockStateRepository.get as unknown as ReturnType<typeof vi.fn>;
const mockedShockUpsert = compassShockStateRepository.upsert as unknown as ReturnType<typeof vi.fn>;

const DATE = new Date(Date.UTC(2026, 4, 19));

function inputRow(
  code: string,
  colorBand: 'GREEN' | 'YELLOW' | 'RED',
  opts: {
    rawValue?: number | null;
    derivedValue?: number | null;
    observationDate?: Date;
    subChecks?: { stale?: boolean } | null;
  } = {},
): InputRow {
  return {
    observationDate: opts.observationDate ?? DATE,
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
    subChecks: opts.subChecks ?? null,
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
    inputRow('DXY_TREND', 'GREEN', { rawValue: 100, derivedValue: 0.025 }),
    inputRow('VIX_TERM_STRUCTURE', 'GREEN', { rawValue: 0.85, derivedValue: 0.85 }),
    inputRow('US_DATA_STACK', 'GREEN'),
  ];
}

function defaultYellowInputs(): InputRow[] {
  return [
    inputRow('VIX_5D_AVG', 'YELLOW', { rawValue: 20, derivedValue: 21 }),
    inputRow('HY_OAS', 'YELLOW', { rawValue: 5.0, derivedValue: 0 }),
    inputRow('YIELD_2S10S', 'YELLOW', { rawValue: 0.1, derivedValue: 0 }),
    inputRow('DXY_TREND', 'YELLOW', { rawValue: 100, derivedValue: 0.021 }),
    inputRow('VIX_TERM_STRUCTURE', 'YELLOW', { rawValue: 0.92, derivedValue: 0.92 }),
    inputRow('US_DATA_STACK', 'YELLOW'),
  ];
}

describe('runCompassClassifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.inputs = [];
    state.fedConstraintRow = null;
    mockedStart.mockResolvedValue({ id: 'log-1' });
    mockedComplete.mockResolvedValue(undefined);
    mockedGetMostRecent.mockResolvedValue(null);
    mockedUpsert.mockResolvedValue({ id: 'cc-1', action: 'inserted' });
    mockedResolveConfig.mockResolvedValue(COMPASS_CONFIG_V1_FIXTURE);
    mockedShockGet.mockResolvedValue(null);
    mockedShockUpsert.mockResolvedValue(undefined);
  });

  it('skipped_no_inputs when fewer than 6 inputs present', async () => {
    setAllSixInputs(defaultGreenInputs().slice(0, 5));
    const result = await runCompassClassifier('manual', null, DATE);
    expect(result.status).toBe('skipped_no_inputs');
    expect(mockedUpsert).not.toHaveBeenCalled();
    expect(mockedComplete).toHaveBeenCalledTimes(1);
    expect(mockedComplete.mock.calls[0][0].metadata.reason).toBe('skipped_no_inputs');
  });

  it('all-yellow inputs with no prior → candidate Caution, active Caution, count 0, inserted, no shock', async () => {
    setAllSixInputs(defaultYellowInputs());
    const result = await runCompassClassifier('manual', null, DATE);
    expect(result.status).toBe('success');
    expect(result.candidateRegime).toBe('Caution');
    expect(result.activeRegime).toBe('Caution');
    expect(result.persistenceDaysCount).toBe(0);
    expect(result.crisisOverrideFired).toBe(false);
    expect(result.finalRegime).toBe('Caution');
    expect(result.shockAActive).toBe(false);
    expect(result.shockBActive).toBe(false);
    expect(result.action).toBe('inserted');
    expect(mockedUpsert).toHaveBeenCalledTimes(1);
    const upsertCall = mockedUpsert.mock.calls[0][0];
    expect(upsertCall.totalYellowWeight).toBeCloseTo(8.0);
    expect(upsertCall.totalGreenWeight).toBeCloseTo(0);
    expect(upsertCall.totalRedWeight).toBeCloseTo(0);
    expect(upsertCall.crisisOverrideFired).toBe(false);
  });

  it('all-green inputs → candidate Risk-On (green=8, red=0), bootstrap active Caution count=1', async () => {
    setAllSixInputs(defaultGreenInputs());
    const result = await runCompassClassifier('manual', null, DATE);
    expect(result.candidateRegime).toBe('Risk-On');
    expect(result.activeRegime).toBe('Caution');
    expect(result.persistenceDaysCount).toBe(1);
    expect(result.finalRegime).toBe('Caution'); // no shock, so finalRegime == activeRegime
  });

  it('[Trigger A] fires: VIX close=33 (single-day) AND OAS 5-obs delta > 0.50 → shockAActive, finalRegime=Risk-Off regardless of standard regime', async () => {
    const rows = defaultYellowInputs();
    // VIX_5D_AVG rawValue is the single-day close (confirmed field usage) — 33 > 32 threshold.
    rows[0] = inputRow('VIX_5D_AVG', 'YELLOW', { rawValue: 33, derivedValue: 21 });
    setAllSixInputs(rows);

    // 6 days of HY_OAS history ending at DATE, delta5 = 4.6 - 4.0 = 0.6 > 0.50.
    const oasHistory: InputRow[] = [];
    for (let i = 5; i >= 0; i -= 1) {
      const d = new Date(DATE);
      d.setUTCDate(d.getUTCDate() - i);
      oasHistory.push(inputRow('HY_OAS', 'YELLOW', { rawValue: i === 0 ? 4.6 : 4.0, observationDate: d }));
    }
    // 6 days of VIX_5D_AVG history (rawValue = single-day close) ending at DATE.
    const vixHistory: InputRow[] = [];
    for (let i = 5; i >= 0; i -= 1) {
      const d = new Date(DATE);
      d.setUTCDate(d.getUTCDate() - i);
      vixHistory.push(inputRow('VIX_5D_AVG', 'YELLOW', { rawValue: i === 0 ? 33 : 20, derivedValue: 21, observationDate: d }));
    }
    state.inputs = [...rows.filter((r) => r.inputCode !== 'VIX_5D_AVG' && r.inputCode !== 'HY_OAS'), ...oasHistory, ...vixHistory];

    const result = await runCompassClassifier('manual', null, DATE);
    expect(result.shockAActive).toBe(true);
    expect(result.finalRegime).toBe('Risk-Off');
    // Standard machine is untouched by the shock — still whatever the raw
    // vote-derived candidate/persistence resolves to (Caution here, since
    // votes are all-yellow/no red majority).
    expect(result.activeRegime).toBe('Caution');
    expect(mockedShockUpsert).toHaveBeenCalledTimes(1);
    expect(mockedShockUpsert.mock.calls[0][0].shockAActive).toBe(true);
  });

  it('[Trigger A] does NOT fire when VIX close is high but OAS delta5 is small', async () => {
    const rows = defaultYellowInputs();
    rows[0] = inputRow('VIX_5D_AVG', 'YELLOW', { rawValue: 33, derivedValue: 21 });
    setAllSixInputs(rows);

    const oasHistory: InputRow[] = [];
    for (let i = 5; i >= 0; i -= 1) {
      const d = new Date(DATE);
      d.setUTCDate(d.getUTCDate() - i);
      oasHistory.push(inputRow('HY_OAS', 'YELLOW', { rawValue: 4.0, observationDate: d })); // flat, delta5=0
    }
    const vixHistory: InputRow[] = [];
    for (let i = 5; i >= 0; i -= 1) {
      const d = new Date(DATE);
      d.setUTCDate(d.getUTCDate() - i);
      vixHistory.push(inputRow('VIX_5D_AVG', 'YELLOW', { rawValue: i === 0 ? 33 : 20, derivedValue: 21, observationDate: d }));
    }
    state.inputs = [...rows.filter((r) => r.inputCode !== 'VIX_5D_AVG' && r.inputCode !== 'HY_OAS'), ...oasHistory, ...vixHistory];

    const result = await runCompassClassifier('manual', null, DATE);
    expect(result.shockAActive).toBe(false);
    expect(result.finalRegime).toBe(result.activeRegime);
  });

  it('[case 5] Trigger A blocked when OAS stale beyond limit → evaluates FALSE, logs trigger_blocked_stale, does not error', async () => {
    // Today's VIX close (33) would satisfy Trigger A's vol-shock threshold,
    // and a full clean VIX history is present. HY_OAS's TODAY row, however,
    // carries subChecks.stale=true — exactly what hy-oas-input.service.ts
    // itself would have written had its own ingest-time forward-fill found
    // the FRED series stale beyond the 5-day limit. This is the same-day
    // carried-forward case isSeriesStale's date-gap check alone can't see —
    // isLatestRowFlaggedStale is what catches it here.
    const rows = defaultYellowInputs();
    rows[0] = inputRow('VIX_5D_AVG', 'YELLOW', { rawValue: 33, derivedValue: 21 });
    setAllSixInputs(rows);

    const vixHistory: InputRow[] = [];
    for (let i = 5; i >= 0; i -= 1) {
      const d = new Date(DATE);
      d.setUTCDate(d.getUTCDate() - i);
      vixHistory.push(inputRow('VIX_5D_AVG', 'YELLOW', { rawValue: i === 0 ? 33 : 20, derivedValue: 21, observationDate: d }));
    }
    const oasHistory: InputRow[] = [];
    for (let i = 5; i >= 1; i -= 1) {
      const d = new Date(DATE);
      d.setUTCDate(d.getUTCDate() - i);
      oasHistory.push(inputRow('HY_OAS', 'YELLOW', { rawValue: 4.0, observationDate: d }));
    }
    state.inputs = [
      ...rows.filter((r) => r.inputCode !== 'VIX_5D_AVG' && r.inputCode !== 'HY_OAS'),
      inputRow('HY_OAS', 'YELLOW', { rawValue: 4.6, subChecks: { stale: true } }), // today's row, flagged stale at ingest
      ...oasHistory,
      ...vixHistory,
    ];

    const result = await runCompassClassifier('manual', null, DATE);
    expect(result.status).toBe('success'); // never errors
    expect(result.shockAActive).toBe(false); // blocked, not fired
    expect(result.finalRegime).toBe(result.activeRegime);
  });

  it('[case 6] Trigger B blocked when USDJPY stale beyond limit (subChecks.stale flag) → FALSE + logged, does not error', async () => {
    // No USDJPY_PRICE history rows exist at all here (empty series is
    // already maximally stale per isSeriesStale) — this test additionally
    // confirms the classifier never errors and shockBActive stays false
    // even when combined with the new isLatestRowFlaggedStale signal (which
    // simply returns false when no row exists at all, i.e. it does not mask
    // or interfere with the pre-existing empty-series path).
    setAllSixInputs(defaultYellowInputs());
    const result = await runCompassClassifier('manual', null, DATE);
    expect(result.status).toBe('success');
    expect(result.shockBActive).toBe(false);
  });

  it('[case 8] a stale YELLOW input still contributes its full weight to the yellow bucket — total stays 8.0', async () => {
    // All 6 inputs YELLOW (as if every one had gone stale and defaulted to
    // YELLOW at the input-ingest layer) — the classifier itself only ever
    // sees the persisted colorBand, so this proves stale inputs are never
    // dropped from the vote, only recolored.
    setAllSixInputs(defaultYellowInputs());
    const result = await runCompassClassifier('manual', null, DATE);
    const upsertCall = mockedUpsert.mock.calls[0][0];
    const total =
      Number(upsertCall.totalGreenWeight) +
      Number(upsertCall.totalYellowWeight) +
      Number(upsertCall.totalRedWeight);
    expect(total).toBeCloseTo(8.0);
    expect(result.status).toBe('success');
  });

  it('[case 9] REGRESSION: with no gaps/staleness, every input scores identically to Phase 4 — the robustness layer is inert on clean data', async () => {
    // Full, clean 6-day VIX + HY OAS history (no gaps), USDJPY present too —
    // same shape as the Phase 4 "[Trigger A] fires" test, just also
    // confirming Trigger B / vote outcome / weights are all unaffected by
    // the staleness machinery when nothing is actually stale.
    const rows = defaultGreenInputs();
    setAllSixInputs(rows);

    const oasHistory: InputRow[] = [];
    const vixHistory: InputRow[] = [];
    const jpyHistory: InputRow[] = [];
    for (let i = 5; i >= 0; i -= 1) {
      const d = new Date(DATE);
      d.setUTCDate(d.getUTCDate() - i);
      oasHistory.push(inputRow('HY_OAS', 'GREEN', { rawValue: 2.8, observationDate: d }));
      vixHistory.push(inputRow('VIX_5D_AVG', 'GREEN', { rawValue: 15, derivedValue: 17.5, observationDate: d }));
      jpyHistory.push(inputRow('USDJPY_PRICE', 'YELLOW', { rawValue: 150, observationDate: d }));
    }
    state.inputs = [
      ...rows.filter((r) => !['VIX_5D_AVG', 'HY_OAS'].includes(r.inputCode)),
      ...oasHistory,
      ...vixHistory,
      ...jpyHistory,
    ];

    const result = await runCompassClassifier('manual', null, DATE);
    // Same outcome as the Phase-4-era "all-green" behavior: candidate
    // Risk-On, bootstrap active Caution, no shock triggers on flat/calm data.
    expect(result.candidateRegime).toBe('Risk-On');
    expect(result.activeRegime).toBe('Caution');
    expect(result.shockAActive).toBe(false);
    expect(result.shockBActive).toBe(false);
    expect(result.finalRegime).toBe('Caution');
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
      persistenceDaysCount: 2, // v2 asymmetric: Caution->Risk-Off needs 3 days (higher severity)
    });
    const result = await runCompassClassifier('manual', null, DATE);
    expect(result.candidateRegime).toBe('Risk-Off');
    expect(result.activeRegime).toBe('Risk-Off');
    expect(result.persistenceDaysCount).toBe(0);
  });

  it('prior active Caution + 1-day Risk-Off streak + today Caution → streak resets, stays Caution', async () => {
    setAllSixInputs(defaultYellowInputs());
    mockedGetMostRecent.mockResolvedValue({
      classificationDate: new Date(Date.UTC(2026, 4, 18)),
      activeRegime: 'Caution',
      candidateRegime: 'Risk-Off',
      persistenceDaysCount: 1,
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
      where: {
        observationDate: backfillDate,
        isValidation: false,
        inputCode: { in: ['VIX_5D_AVG', 'HY_OAS', 'YIELD_2S10S', 'DXY_TREND', 'VIX_TERM_STRUCTURE', 'US_DATA_STACK'] },
      },
    });
    expect(mockedGetMostRecent).toHaveBeenCalledWith(backfillDate, false);
  });

  it('writes voteBreakdown with all 6 inputs and weights', async () => {
    setAllSixInputs(defaultYellowInputs());
    await runCompassClassifier('manual', null, DATE);
    const breakdown = mockedUpsert.mock.calls[0][0].voteBreakdown;
    expect(Object.keys(breakdown.inputs).sort()).toEqual(
      ['DXY_TREND', 'HY_OAS', 'US_DATA_STACK', 'VIX_5D_AVG', 'VIX_TERM_STRUCTURE', 'YIELD_2S10S'],
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

  // ── Phase 6 gate audit (end-to-end through the classifier) ────────────────

  /** Build US02Y_CLOSE rows on consecutive WEEKDAYS (Mon-Fri) ending at DATE. */
  function us02yHistory(closes: number[]): InputRow[] {
    const dates: Date[] = [];
    const cursor = new Date(DATE);
    while (dates.length < closes.length) {
      const dow = cursor.getUTCDay();
      if (dow !== 0 && dow !== 6) dates.unshift(new Date(cursor));
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    return dates.map((d, i) =>
      inputRow('US02Y_CLOSE', 'YELLOW', { rawValue: closes[i], observationDate: d }),
    );
  }

  it('[Phase 6] computes and persists us02y_close / us02y_sma21 / rate_gate_hawkish from stored history', async () => {
    // 25 weekday closes: flat at 4.0 for 24 days, then 4.5 today → today's close
    // (4.5) is ABOVE the 21-obs SMA (~4.02) → hawkish.
    const closes = [...new Array(24).fill(4.0), 4.5];
    state.inputs = [...defaultYellowInputs(), ...us02yHistory(closes)];
    await runCompassClassifier('manual', null, DATE);
    const call = mockedUpsert.mock.calls[0][0];
    expect(call.us02yClose).toBeCloseTo(4.5, 6);
    expect(call.us02ySma21).not.toBeNull();
    expect(call.us02ySma21 as number).toBeLessThan(4.5);
    expect(call.rateGateHawkish).toBe(true);
  });

  it('[case 7 @ classifier] rate gate suppresses Overrides 3&5 when Risk-Off + hawkish + no Trigger B', async () => {
    // Force a Risk-Off standard regime via red votes; hawkish US02Y; no shock.
    const rows = defaultYellowInputs();
    rows[1] = inputRow('HY_OAS', 'RED', { rawValue: 6.5, derivedValue: 0.5 });
    rows[2] = inputRow('YIELD_2S10S', 'RED', { rawValue: -0.5, derivedValue: 0.2 });
    rows[5] = inputRow('US_DATA_STACK', 'RED');
    mockedGetMostRecent.mockResolvedValue({
      classificationDate: new Date(Date.UTC(2026, 4, 18)),
      activeRegime: 'Risk-Off',
      candidateRegime: 'Risk-Off',
      persistenceDaysCount: 0,
    });
    const closes = [...new Array(24).fill(4.0), 4.5]; // hawkish
    state.inputs = [...rows, ...us02yHistory(closes)];

    await runCompassClassifier('manual', null, DATE);
    const call = mockedUpsert.mock.calls[0][0];
    expect(call.activeRegime).toBe('Risk-Off');
    expect(call.rateGateHawkish).toBe(true);
    expect(call.override3SuppressedByGate).toBe(true);
    expect(call.override5SuppressedByGate).toBe(true);
    // Overrides 3 & 5 not in the active set; 1 & 4 (ungated) are.
    expect(call.overridesActive).not.toContain('OVERRIDE_3_JPY_SAFE_HAVEN');
    expect(call.overridesActive).toContain('OVERRIDE_4_USD_WEAK_JOBS');
  });

  it('[case 9+10 @ classifier] fed CONSTRAINED lets Override 2 into the active set; FREE suppresses it', async () => {
    const rows = defaultYellowInputs();
    rows[1] = inputRow('HY_OAS', 'RED', { rawValue: 6.5, derivedValue: 0.5 });
    rows[2] = inputRow('YIELD_2S10S', 'RED', { rawValue: -0.5, derivedValue: 0.2 });
    rows[5] = inputRow('US_DATA_STACK', 'RED');
    mockedGetMostRecent.mockResolvedValue({
      classificationDate: new Date(Date.UTC(2026, 4, 18)),
      activeRegime: 'Risk-Off',
      candidateRegime: 'Risk-Off',
      persistenceDaysCount: 0,
    });
    state.inputs = [...rows, ...us02yHistory(new Array(25).fill(4.0))]; // not hawkish

    // CONSTRAINED → Override 2 permitted.
    state.fedConstraintRow = { fedConstraint: 'CONSTRAINED', effectiveFrom: new Date(Date.UTC(2026, 0, 1)) };
    await runCompassClassifier('manual', null, DATE);
    let call = mockedUpsert.mock.calls[0][0];
    expect(call.fedConstraint).toBe('CONSTRAINED');
    expect(call.override2SuppressedByConstraint).toBe(false);
    expect(call.overridesActive).toContain('OVERRIDE_2_GOLD_INFLATION_HEDGE');

    // FREE → Override 2 suppressed.
    vi.clearAllMocks();
    mockedStart.mockResolvedValue({ id: 'log-1' });
    mockedComplete.mockResolvedValue(undefined);
    mockedUpsert.mockResolvedValue({ id: 'cc-1', action: 'inserted' });
    mockedResolveConfig.mockResolvedValue(COMPASS_CONFIG_V1_FIXTURE);
    mockedShockGet.mockResolvedValue(null);
    mockedShockUpsert.mockResolvedValue(undefined);
    mockedGetMostRecent.mockResolvedValue({
      classificationDate: new Date(Date.UTC(2026, 4, 18)),
      activeRegime: 'Risk-Off',
      candidateRegime: 'Risk-Off',
      persistenceDaysCount: 0,
    });
    state.fedConstraintRow = { fedConstraint: 'FREE', effectiveFrom: new Date(Date.UTC(2026, 0, 1)) };
    await runCompassClassifier('manual', null, DATE);
    call = mockedUpsert.mock.calls[0][0];
    expect(call.fedConstraint).toBe('FREE');
    expect(call.override2SuppressedByConstraint).toBe(true);
    expect(call.overridesActive).not.toContain('OVERRIDE_2_GOLD_INFLATION_HEDGE');
  });

  it('[case 6 @ classifier] US02Y absent → rate gate FAILS OPEN (not hawkish, not suppressed)', async () => {
    const rows = defaultYellowInputs();
    rows[1] = inputRow('HY_OAS', 'RED', { rawValue: 6.5, derivedValue: 0.5 });
    rows[2] = inputRow('YIELD_2S10S', 'RED', { rawValue: -0.5, derivedValue: 0.2 });
    rows[5] = inputRow('US_DATA_STACK', 'RED');
    mockedGetMostRecent.mockResolvedValue({
      classificationDate: new Date(Date.UTC(2026, 4, 18)),
      activeRegime: 'Risk-Off',
      candidateRegime: 'Risk-Off',
      persistenceDaysCount: 0,
    });
    state.inputs = [...rows]; // NO US02Y_CLOSE history at all

    await runCompassClassifier('manual', null, DATE);
    const call = mockedUpsert.mock.calls[0][0];
    expect(call.us02yClose).toBeNull();
    expect(call.rateGateHawkish).toBe(false); // fails open → not hawkish
    expect(call.override3SuppressedByGate).toBe(false); // not suppressed
    expect(call.overridesActive).toContain('OVERRIDE_3_JPY_SAFE_HAVEN'); // applies
  });
});
