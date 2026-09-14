import { describe, it, expect } from 'vitest';
import {
  pipMultiplier,
  computeTradeMetrics,
  computeExpectedRr,
  sessionFromDate,
} from '@modules/trading/services/trade-metrics';

describe('pipMultiplier', () => {
  it('uses 10000 for forex, 100 for JPY-quoted forex, 1 for everything else', () => {
    expect(pipMultiplier('EURUSD', true)).toBe(10000);
    expect(pipMultiplier('USDJPY', true)).toBe(100);
    expect(pipMultiplier('eurjpy', true)).toBe(100);
    expect(pipMultiplier('XAUUSD', false)).toBe(1);
    expect(pipMultiplier('NAS100', false)).toBe(1);
  });
});

describe('computeTradeMetrics', () => {
  it('matches the hand-computed R of EURUSD Buy 2026-08-17 (+1.86R)', () => {
    const m = computeTradeMetrics({
      direction: 'Buy', symbol: 'EURUSD', isForexPair: true,
      entryPrice: 1.15865, slPrice: 1.1545, mainExitPrice: 1.16635,
      partialExitPrice: null, partialExitLotPct: null,
    });
    // (1.16635 − 1.15865) / (1.15865 − 1.1545) = 0.00770 / 0.00415 = 1.855
    expect(m.blendedRr).toBe(1.86);
    expect(m.totalPips).toBe(77);
  });

  it('signs a Sell correctly and returns −1R at the stop', () => {
    const m = computeTradeMetrics({
      direction: 'Sell', symbol: 'XAUUSD', isForexPair: false,
      entryPrice: 4500.296, slPrice: 4591, mainExitPrice: 4591,
      partialExitPrice: null, partialExitLotPct: null,
    });
    expect(m.blendedRr).toBe(-1);
  });

  it('is independent of the pip multiplier (JPY vs non-JPY scale cancels)', () => {
    const jpy = computeTradeMetrics({
      direction: 'Buy', symbol: 'USDJPY', isForexPair: true,
      entryPrice: 155.167, slPrice: 154.78, mainExitPrice: 156.733,
      partialExitPrice: null, partialExitLotPct: null,
    });
    expect(jpy.blendedRr).toBe(4.05);
  });

  it('lot-weights a partial exit', () => {
    const m = computeTradeMetrics({
      direction: 'Buy', symbol: 'EURUSD', isForexPair: true,
      entryPrice: 1.1, slPrice: 1.09, mainExitPrice: 1.12,
      partialExitPrice: 1.11, partialExitLotPct: 50,
    });
    // 0.5 × 1R + 0.5 × 2R
    expect(m.blendedRr).toBe(1.5);
  });

  it('returns zeros while the fill is open', () => {
    expect(
      computeTradeMetrics({
        direction: 'Buy', symbol: 'EURUSD', isForexPair: true,
        entryPrice: 1.1, slPrice: 1.09, mainExitPrice: null,
        partialExitPrice: null, partialExitLotPct: null,
      }),
    ).toEqual({ totalPips: 0, blendedRr: 0 });
  });
});

describe('computeExpectedRr', () => {
  it('is reward over risk, signed by direction; null with no target or zero risk', () => {
    expect(computeExpectedRr({ direction: 'Buy', entryPrice: 1.1, slPrice: 1.09, targetPrice: 1.13 })).toBe(3);
    expect(computeExpectedRr({ direction: 'Sell', entryPrice: 1.1, slPrice: 1.11, targetPrice: 1.08 })).toBe(2);
    expect(computeExpectedRr({ direction: 'Buy', entryPrice: 1.1, slPrice: 1.09, targetPrice: null })).toBeNull();
    expect(computeExpectedRr({ direction: 'Buy', entryPrice: 1.1, slPrice: 1.1, targetPrice: 1.2 })).toBeNull();
  });
});

describe('sessionFromDate (IST windows)', () => {
  // IST = UTC + 5:30
  const at = (utcHour: number, utcMinute = 0): Date => new Date(Date.UTC(2026, 0, 5, utcHour, utcMinute));

  it('tags the four windows', () => {
    expect(sessionFromDate(at(0, 0))).toBe('Asian'); //  05:30 IST
    expect(sessionFromDate(at(5, 59))).toBe('Asian'); // 11:29 IST
    expect(sessionFromDate(at(8, 0))).toBe('London'); // 13:30 IST
    expect(sessionFromDate(at(12, 0))).toBe('London-NY Overlap'); // 17:30 IST
    expect(sessionFromDate(at(15, 59))).toBe('London-NY Overlap'); // 21:29 IST
    expect(sessionFromDate(at(16, 0))).toBe('New York'); // 21:30 IST
  });

  it('assigns the 11:30–13:30 IST window to London (it used to fall through to New York)', () => {
    expect(sessionFromDate(at(6, 0))).toBe('London'); //  11:30 IST
    expect(sessionFromDate(at(7, 15))).toBe('London'); // 12:45 IST
    expect(sessionFromDate(at(7, 59))).toBe('London'); // 13:29 IST
  });

  it('wraps New York across IST midnight', () => {
    expect(sessionFromDate(at(18, 30))).toBe('New York'); // 00:00 IST
    expect(sessionFromDate(at(23, 59))).toBe('New York'); // 05:29 IST — one minute before Asian opens
  });
});
