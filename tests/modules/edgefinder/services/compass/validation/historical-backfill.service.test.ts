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
vi.mock('@modules/edgefinder/services/compass/compass-classifier.service', () => ({
  runCompassClassifier: vi.fn(),
}));

import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import { ingestVixInput } from '@modules/edgefinder/services/compass/inputs/vix-input.service';
import { ingestHyOasInput } from '@modules/edgefinder/services/compass/inputs/hy-oas-input.service';
import { ingestYieldCurveInput } from '@modules/edgefinder/services/compass/inputs/yield-curve-input.service';
import { ingestDxyTrendInput } from '@modules/edgefinder/services/compass/inputs/dxy-trend-input.service';
import { ingestGoldDxyCorrInput } from '@modules/edgefinder/services/compass/inputs/gold-dxy-corr-input.service';
import { ingestUsDataStackInput } from '@modules/edgefinder/services/compass/inputs/us-data-stack-input.service';
import { runCompassClassifier } from '@modules/edgefinder/services/compass/compass-classifier.service';
import {
  backfillWindow,
  generateTradingDays,
} from '@modules/edgefinder/services/compass/validation/historical-backfill.service';

const mockedStart = dataFetchLogRepository.start as unknown as ReturnType<typeof vi.fn>;
const mockedComplete = dataFetchLogRepository.complete as unknown as ReturnType<typeof vi.fn>;
const mockedVix = ingestVixInput as unknown as ReturnType<typeof vi.fn>;
const mockedHy = ingestHyOasInput as unknown as ReturnType<typeof vi.fn>;
const mockedYc = ingestYieldCurveInput as unknown as ReturnType<typeof vi.fn>;
const mockedDxy = ingestDxyTrendInput as unknown as ReturnType<typeof vi.fn>;
const mockedCorr = ingestGoldDxyCorrInput as unknown as ReturnType<typeof vi.fn>;
const mockedStack = ingestUsDataStackInput as unknown as ReturnType<typeof vi.fn>;
const mockedClassifier = runCompassClassifier as unknown as ReturnType<typeof vi.fn>;

const inputMocks = [mockedVix, mockedHy, mockedYc, mockedDxy, mockedCorr, mockedStack];

function utc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

describe('generateTradingDays', () => {
  it('skips weekends', () => {
    // 2020-03-13 is a Friday, 2020-03-16 is a Monday
    const days = generateTradingDays(utc(2020, 3, 13), utc(2020, 3, 16));
    const labels = days.map((d) => d.toISOString().slice(0, 10));
    expect(labels).toEqual(['2020-03-13', '2020-03-16']);
  });

  it('handles single-day range on a weekday', () => {
    const days = generateTradingDays(utc(2020, 3, 16), utc(2020, 3, 16));
    expect(days).toHaveLength(1);
  });

  it('returns empty array for a weekend-only range', () => {
    const days = generateTradingDays(utc(2020, 3, 14), utc(2020, 3, 15));
    expect(days).toHaveLength(0);
  });

  it('returns ascending order', () => {
    const days = generateTradingDays(utc(2020, 3, 1), utc(2020, 3, 31));
    for (let i = 1; i < days.length; i += 1) {
      expect(days[i].getTime()).toBeGreaterThan(days[i - 1].getTime());
    }
  });

  it('counts ~22 trading days in a typical month', () => {
    const days = generateTradingDays(utc(2020, 3, 1), utc(2020, 3, 31));
    // March 2020 has 22 weekdays
    expect(days).toHaveLength(22);
  });
});

describe('backfillWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedStart.mockResolvedValue({ id: 'log-1' });
    mockedComplete.mockResolvedValue(undefined);
    inputMocks.forEach((m) => m.mockResolvedValue(undefined));
    mockedClassifier.mockResolvedValue({
      logId: 'cls-log',
      status: 'success',
      classificationDate: new Date(),
      action: 'inserted',
    });
  });

  const tinyWindow = {
    windowName: 'TEST_WINDOW',
    startDate: utc(2020, 3, 16), // Mon
    endDate: utc(2020, 3, 18), // Wed → 3 trading days
  };

  it('calls each of 6 input services with each trading day and isValidation=true', async () => {
    const result = await backfillWindow(tinyWindow, 'admin-user');
    expect(result.totalTradingDays).toBe(3);

    for (const m of inputMocks) {
      expect(m).toHaveBeenCalledTimes(3);
      // Every call has 2 args: (date, true)
      m.mock.calls.forEach((call) => {
        expect(call[1]).toBe(true);
      });
    }
  });

  it('runs classifier with forDate and isValidation=true after each day', async () => {
    await backfillWindow(tinyWindow);
    expect(mockedClassifier).toHaveBeenCalledTimes(3);
    mockedClassifier.mock.calls.forEach((call) => {
      expect(call[0]).toBe('manual');
      expect(call[3]).toBe(true);
    });
  });

  it('runs days in ascending order', async () => {
    const seen: string[] = [];
    mockedClassifier.mockImplementation(async (...args: unknown[]) => {
      const d = args[2] as Date;
      seen.push(d.toISOString().slice(0, 10));
      return { logId: 'x', status: 'success', classificationDate: d };
    });
    await backfillWindow(tinyWindow);
    expect(seen).toEqual(['2020-03-16', '2020-03-17', '2020-03-18']);
  });

  it('skips classifier for a day if any input fails, continues to next day', async () => {
    // Fail VIX on the second day
    let call = 0;
    mockedVix.mockImplementation(async () => {
      call += 1;
      if (call === 2) throw new Error('Yahoo 502');
    });

    const result = await backfillWindow(tinyWindow);

    // Classifier called only for days 1 and 3
    expect(mockedClassifier).toHaveBeenCalledTimes(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].date).toBe('2020-03-17');
    expect(result.errors[0].error).toContain('VIX_5D_AVG');
    expect(result.classificationsRun).toBe(2);
  });

  it('returns partial status in fetch_log when any errors occurred', async () => {
    mockedHy.mockRejectedValueOnce(new Error('FRED rate limit'));
    await backfillWindow(tinyWindow);
    expect(mockedComplete).toHaveBeenCalledTimes(1);
    expect(mockedComplete.mock.calls[0][0].status).toBe('partial');
  });

  it('returns success status when all days complete without error', async () => {
    await backfillWindow(tinyWindow);
    expect(mockedComplete.mock.calls[0][0].status).toBe('success');
  });

  it('runs the 6 inputs in parallel within a single day', async () => {
    const startTimes: Record<string, number> = {};
    const slowMock = (code: string) =>
      async (): Promise<void> => {
        startTimes[code] = Date.now();
        await new Promise((r) => setTimeout(r, 20));
      };
    mockedVix.mockImplementation(slowMock('VIX'));
    mockedHy.mockImplementation(slowMock('HY'));
    mockedYc.mockImplementation(slowMock('YC'));
    mockedDxy.mockImplementation(slowMock('DXY'));
    mockedCorr.mockImplementation(slowMock('CORR'));
    mockedStack.mockImplementation(slowMock('STACK'));

    const singleDay = { ...tinyWindow, endDate: tinyWindow.startDate };
    await backfillWindow(singleDay);

    // All 6 inputs started within 10ms of each other = parallel
    const values = Object.values(startTimes);
    const min = Math.min(...values);
    const max = Math.max(...values);
    expect(max - min).toBeLessThan(15);
  });

  it('writes fetch_log start with windowName and trigger=backfill', async () => {
    await backfillWindow(tinyWindow, 'admin-user');
    expect(mockedStart).toHaveBeenCalledTimes(1);
    const startArg = mockedStart.mock.calls[0][0];
    expect(startArg.triggerType).toBe('backfill');
    expect(startArg.triggeredBy).toBe('admin-user');
    expect(startArg.metadata.windowName).toBe('TEST_WINDOW');
  });

  it('handles a window that contains only weekends (no trading days)', async () => {
    const weekendOnly = {
      windowName: 'WEEKEND',
      startDate: utc(2020, 3, 14),
      endDate: utc(2020, 3, 15),
    };
    const result = await backfillWindow(weekendOnly);
    expect(result.totalTradingDays).toBe(0);
    expect(mockedClassifier).not.toHaveBeenCalled();
    inputMocks.forEach((m) => expect(m).not.toHaveBeenCalled());
  });

  it('still completes fetch_log if classifier throws', async () => {
    mockedClassifier.mockRejectedValueOnce(new Error('db connection lost'));
    const result = await backfillWindow(tinyWindow);
    expect(result.errors[0].error).toContain('classifier');
    expect(mockedComplete).toHaveBeenCalledTimes(1);
  });
});
