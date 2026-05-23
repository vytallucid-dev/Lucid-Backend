import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@core/repositories/data-fetch-log.repository', () => ({
  dataFetchLogRepository: {
    start: vi.fn(),
    complete: vi.fn(),
  },
}));
vi.mock('@modules/edgefinder/services/compass/inputs/vix-input.service', () => ({
  ingestVixInput: vi.fn(),
}));
vi.mock('@modules/edgefinder/services/compass/inputs/hy-oas-input.service', () => ({
  ingestHyOasInput: vi.fn(),
}));
vi.mock('@modules/edgefinder/services/compass/inputs/yield-curve-input.service', () => ({
  ingestYieldCurveInput: vi.fn(),
}));
vi.mock('@modules/edgefinder/services/compass/inputs/dxy-trend-input.service', () => ({
  ingestDxyTrendInput: vi.fn(),
}));
vi.mock('@modules/edgefinder/services/compass/inputs/gold-dxy-corr-input.service', () => ({
  ingestGoldDxyCorrInput: vi.fn(),
}));
vi.mock('@modules/edgefinder/services/compass/inputs/us-data-stack-input.service', () => ({
  ingestUsDataStackInput: vi.fn(),
}));

import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { ingestVixInput } from '@modules/edgefinder/services/compass/inputs/vix-input.service';
import { ingestHyOasInput } from '@modules/edgefinder/services/compass/inputs/hy-oas-input.service';
import { ingestYieldCurveInput } from '@modules/edgefinder/services/compass/inputs/yield-curve-input.service';
import { ingestDxyTrendInput } from '@modules/edgefinder/services/compass/inputs/dxy-trend-input.service';
import { ingestGoldDxyCorrInput } from '@modules/edgefinder/services/compass/inputs/gold-dxy-corr-input.service';
import { ingestUsDataStackInput } from '@modules/edgefinder/services/compass/inputs/us-data-stack-input.service';
import { runAllCompassInputs } from '@modules/edgefinder/services/compass/compass-input-orchestrator.service';

const mockedStart = dataFetchLogRepository.start as unknown as ReturnType<typeof vi.fn>;
const mockedComplete = dataFetchLogRepository.complete as unknown as ReturnType<typeof vi.fn>;
const mockedVix = ingestVixInput as unknown as ReturnType<typeof vi.fn>;
const mockedHy = ingestHyOasInput as unknown as ReturnType<typeof vi.fn>;
const mockedYc = ingestYieldCurveInput as unknown as ReturnType<typeof vi.fn>;
const mockedDxy = ingestDxyTrendInput as unknown as ReturnType<typeof vi.fn>;
const mockedCorr = ingestGoldDxyCorrInput as unknown as ReturnType<typeof vi.fn>;
const mockedStack = ingestUsDataStackInput as unknown as ReturnType<typeof vi.fn>;

describe('runAllCompassInputs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedStart.mockResolvedValue({ id: 'log-1' });
    mockedComplete.mockResolvedValue(undefined);
    [mockedVix, mockedHy, mockedYc, mockedDxy, mockedCorr, mockedStack].forEach(
      (m) => m.mockResolvedValue(undefined),
    );
  });

  it('returns status=success when all 6 inputs succeed', async () => {
    const result = await runAllCompassInputs('manual', null);
    expect(result.status).toBe('success');
    expect(result.inputsSucceeded).toHaveLength(6);
    expect(result.inputsFailed).toHaveLength(0);
    expect(mockedComplete).toHaveBeenCalledTimes(1);
    expect(mockedComplete.mock.calls[0][0].status).toBe('success');
  });

  it('returns status=partial when some inputs fail', async () => {
    mockedHy.mockRejectedValue(new Error('FRED 500'));
    mockedCorr.mockRejectedValue(new Error('Yahoo down'));
    const result = await runAllCompassInputs('cron', null);
    expect(result.status).toBe('partial');
    expect(result.inputsSucceeded).toEqual(
      expect.arrayContaining(['VIX_5D_AVG', 'YIELD_2S10S', 'DXY_TREND', 'US_DATA_STACK']),
    );
    expect(result.inputsFailed.map((f) => f.code)).toEqual(
      expect.arrayContaining(['HY_OAS', 'GOLD_DXY_CORR']),
    );
    expect(mockedComplete.mock.calls[0][0].status).toBe('partial');
  });

  it('returns status=failed when ALL inputs fail', async () => {
    [mockedVix, mockedHy, mockedYc, mockedDxy, mockedCorr, mockedStack].forEach(
      (m) => m.mockRejectedValue(new Error('boom')),
    );
    const result = await runAllCompassInputs('cron', null);
    expect(result.status).toBe('failed');
    expect(result.inputsSucceeded).toHaveLength(0);
    expect(result.inputsFailed).toHaveLength(6);
  });

  it('runs inputs sequentially (not in parallel)', async () => {
    const callOrder: string[] = [];
    mockedVix.mockImplementation(async () => {
      callOrder.push('VIX_START');
      await new Promise((r) => setTimeout(r, 10));
      callOrder.push('VIX_END');
    });
    mockedHy.mockImplementation(async () => {
      callOrder.push('HY_START');
      await new Promise((r) => setTimeout(r, 10));
      callOrder.push('HY_END');
    });

    await runAllCompassInputs('manual', null);
    expect(callOrder.slice(0, 4)).toEqual([
      'VIX_START',
      'VIX_END',
      'HY_START',
      'HY_END',
    ]);
  });

  it('always writes a data_fetch_log row (start + complete)', async () => {
    await runAllCompassInputs('manual', 'admin-user');
    expect(mockedStart).toHaveBeenCalledTimes(1);
    expect(mockedStart.mock.calls[0][0].jobName).toBe('compass_inputs_daily_fetch');
    expect(mockedStart.mock.calls[0][0].triggerType).toBe('manual');
    expect(mockedStart.mock.calls[0][0].triggeredBy).toBe('admin-user');
    expect(mockedComplete).toHaveBeenCalledTimes(1);
  });
});
