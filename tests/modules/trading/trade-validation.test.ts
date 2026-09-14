import { describe, it, expect } from 'vitest';
import {
  checkStopSide,
  checkTargetSide,
  checkFirstTpOrder,
  checkExitPricePresent,
  checkExitAfterEntry,
  checkRiskBand,
  checkPartialCoherence,
  checkOutcomeCoherence,
  checkExcursion,
  checkExecution,
  checkTradeIntegrity,
  blocksWrite,
} from '@modules/trading/services/trade-validation';

describe('severity of the existing rules', () => {
  it('a stop on entry is blocking; a stop on the wrong side is advisory', () => {
    expect(checkStopSide('Buy', 1.1, 1.1)?.severity).toBe('blocking');
    expect(checkStopSide('Buy', 1.1, 1.2)?.severity).toBe('advisory');
    expect(checkStopSide('Buy', 1.1, 1.09)).toBeNull();
    expect(checkStopSide('Sell', 1.1, 1.11)).toBeNull();
  });

  it('target and first-TP rules are advisory', () => {
    expect(checkTargetSide('Buy', 1.1, 1.05, 'planned_main_tp', 'Main TP')?.severity).toBe('advisory');
    expect(checkFirstTpOrder('Buy', 1.2, 1.15)?.severity).toBe('advisory');
  });

  it('a closed fill without an exit price is blocking', () => {
    expect(checkExitPricePresent(true, null)?.severity).toBe('blocking');
    expect(checkExitPricePresent(false, null)).toBeNull();
  });

  it('exit before entry, risk band and partial coherence are advisory', () => {
    expect(checkExitAfterEntry(new Date('2026-02-01'), new Date('2026-01-01'))?.severity).toBe('advisory');
    expect(checkRiskBand(25)?.severity).toBe('advisory');
    expect(checkPartialCoherence(1.1, null)?.severity).toBe('advisory');
  });

  it('advisory blocks a create but not an edit or import; blocking blocks everything', () => {
    const adv = { field: 'x', message: 'm', severity: 'advisory' as const };
    const blk = { field: 'x', message: 'm', severity: 'blocking' as const };
    expect(blocksWrite(adv, 'create')).toBe(true);
    expect(blocksWrite(adv, 'edit')).toBe(false);
    expect(blocksWrite(adv, 'import')).toBe(false);
    expect(blocksWrite(blk, 'edit')).toBe(true);
  });
});

// The four shapes below are the four real trades that were found carrying an
// R that contradicted their outcome (they have since been corrected by hand).
describe('checkOutcomeCoherence', () => {
  const base = {
    isClosed: true,
    partialExitPrice: null,
    partialExitLotPct: null,
  };

  it('flags a profitable TP exit whose exit price gives negative R (wrong big figure)', () => {
    const p = checkOutcomeCoherence({
      ...base, direction: 'Buy', plannedSl: 154.78, entryPrice: 155.167, mainExitPrice: 153.733, exitType: 'TP', netPnl: 136,
    });
    expect(p?.field).toBe('main_exit_price');
    expect(p?.severity).toBe('advisory');
    expect(p?.message).toContain('-3.71R');
  });

  it('flags a profitable TP exit that stored the stop price as its exit', () => {
    const p = checkOutcomeCoherence({
      ...base, direction: 'Buy', plannedSl: 154.812, entryPrice: 155.73, mainExitPrice: 154.812, exitType: 'TP', netPnl: 92.58,
    });
    expect(p?.field).toBe('main_exit_price');
  });

  it('flags a breakeven exit that carries the target price', () => {
    const p = checkOutcomeCoherence({
      ...base, direction: 'Buy', plannedSl: 25260, entryPrice: 25499, mainExitPrice: 26214, exitType: 'BE', netPnl: 0,
    });
    expect(p?.field).toBe('main_exit_price');
    expect(p?.message).toContain('breakeven');
  });

  it('flags TP with non-positive R and SL with non-negative R when P&L is silent', () => {
    expect(
      checkOutcomeCoherence({ ...base, direction: 'Sell', plannedSl: 1.11, entryPrice: 1.1, mainExitPrice: 1.105, exitType: 'TP', netPnl: 0 })?.field,
    ).toBe('exit_type');
    expect(
      checkOutcomeCoherence({ ...base, direction: 'Buy', plannedSl: 1.09, entryPrice: 1.1, mainExitPrice: 1.11, exitType: 'SL', netPnl: null })?.field,
    ).toBe('exit_type');
  });

  it('passes the corrected versions of those trades', () => {
    expect(checkOutcomeCoherence({ ...base, direction: 'Buy', plannedSl: 154.78, entryPrice: 155.167, mainExitPrice: 156.733, exitType: 'TP', netPnl: 136 })).toBeNull();
    expect(checkOutcomeCoherence({ ...base, direction: 'Buy', plannedSl: 25260, entryPrice: 25499, mainExitPrice: 25499, exitType: 'BE', netPnl: 0 })).toBeNull();
    expect(checkOutcomeCoherence({ ...base, direction: 'Sell', plannedSl: 4591, entryPrice: 4500.296, mainExitPrice: 4591, exitType: 'SL', netPnl: -100 })).toBeNull();
  });

  it('allows a manual exit anywhere as long as R and P&L agree', () => {
    expect(checkOutcomeCoherence({ ...base, direction: 'Buy', plannedSl: 1.1817, entryPrice: 1.1867, mainExitPrice: 1.18369, exitType: 'Manual', netPnl: -30 })).toBeNull();
  });

  it('skips open fills and zero-risk plans', () => {
    expect(checkOutcomeCoherence({ ...base, isClosed: false, direction: 'Buy', plannedSl: 1, entryPrice: 2, mainExitPrice: null, exitType: 'TP', netPnl: null })).toBeNull();
    expect(checkOutcomeCoherence({ ...base, direction: 'Buy', plannedSl: 2, entryPrice: 2, mainExitPrice: 3, exitType: 'TP', netPnl: -5 })).toBeNull();
  });

  it('uses lot-weighted R across a partial exit', () => {
    // 50% at +1R, 50% at −0.5R → +0.25R overall; P&L positive → coherent.
    expect(
      checkOutcomeCoherence({ isClosed: true, direction: 'Buy', plannedSl: 1.09, entryPrice: 1.1, mainExitPrice: 1.095, partialExitPrice: 1.11, partialExitLotPct: 50, exitType: 'Partial+SL', netPnl: 12 }),
    ).toBeNull();
  });
});

describe('checkExecution / checkTradeIntegrity wiring', () => {
  it('runs outcome coherence only when outcome context is supplied', () => {
    const fill = { riskPct: 1, isClosed: true, mainExitPrice: 153.733, partialExitPrice: null, partialExitLotPct: null, dateClosed: new Date('2025-11-19'), dateOpened: new Date('2025-11-18') };
    expect(checkExecution(fill, new Date('2026-09-12'))).toEqual([]);
    const withOutcome = checkExecution({ ...fill, outcome: { direction: 'Buy', plannedSl: 154.78, entryPrice: 155.167, exitType: 'TP', netPnl: 136 } }, new Date('2026-09-12'));
    expect(withOutcome.map((p) => p.field)).toEqual(['main_exit_price']);
  });

  it('flags a stored trade whose fill is incoherent, anchored to that execution', () => {
    const r = checkTradeIntegrity(
      { direction: 'Buy', plannedEntry: 5124, plannedSl: 5018, plannedFirstTp: null, plannedMainTp: 5556, dateOpened: new Date('2026-02-23') },
      [{ id: 'e1', riskPct: 1, mainExitPrice: 5556, partialExitPrice: null, partialExitLotPct: null, dateClosed: new Date('2026-03-03'), entryPrice: 5124, exitType: 'BE', blendedPnl: 0 }],
      new Date('2026-09-12'),
    );
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0].executionId).toBe('e1');
  });

  it('keeps a coherent stored trade clean', () => {
    const r = checkTradeIntegrity(
      { direction: 'Buy', plannedEntry: 1.15865, plannedSl: 1.1545, plannedFirstTp: null, plannedMainTp: 1.16635, dateOpened: new Date('2026-08-17') },
      [{ id: 'e1', riskPct: 0.4, mainExitPrice: 1.16635, partialExitPrice: null, partialExitLotPct: null, dateClosed: new Date('2026-08-19'), entryPrice: 1.15865, exitType: 'TP', blendedPnl: 95 }],
      new Date('2026-09-12'),
    );
    expect(r).toEqual({ ok: true, problems: [] });
  });
});

describe('checkExcursion', () => {
  it('accepts excursion on the right side of the entry, and nothing recorded', () => {
    expect(checkExcursion({ direction: 'Buy', entryPrice: 1.1, mfePrice: 1.12, maePrice: 1.09 })).toEqual([]);
    expect(checkExcursion({ direction: 'Sell', entryPrice: 1.1, mfePrice: 1.08, maePrice: 1.11 })).toEqual([]);
    expect(checkExcursion({ direction: 'Buy', entryPrice: 1.1, mfePrice: 1.1, maePrice: 1.1 })).toEqual([]);
    expect(checkExcursion({ direction: 'Buy', entryPrice: 1.1, mfePrice: null, maePrice: null })).toEqual([]);
  });

  it('flags an MFE worse than the entry and an MAE better than it, as advisory', () => {
    const buy = checkExcursion({ direction: 'Buy', entryPrice: 1.1, mfePrice: 1.09, maePrice: 1.11 });
    expect(buy.map((p) => [p.field, p.severity])).toEqual([
      ['mfe_price', 'advisory'],
      ['mae_price', 'advisory'],
    ]);
    const sell = checkExcursion({ direction: 'Sell', entryPrice: 1.1, mfePrice: 1.11, maePrice: 1.09 });
    expect(sell.map((p) => p.field)).toEqual(['mfe_price', 'mae_price']);
  });

  it('flags a stored fill whose excursion is on the wrong side, through integrity', () => {
    const r = checkTradeIntegrity(
      { direction: 'Buy', plannedEntry: 1.15865, plannedSl: 1.1545, plannedFirstTp: null, plannedMainTp: 1.16635, dateOpened: new Date('2026-08-17') },
      [{ id: 'e1', riskPct: 0.4, mainExitPrice: 1.16635, partialExitPrice: null, partialExitLotPct: null, dateClosed: new Date('2026-08-19'), entryPrice: 1.15865, exitType: 'TP', blendedPnl: 95, mfePrice: 1.15, maePrice: null }],
      new Date('2026-09-12'),
    );
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => [p.field, p.executionId])).toEqual([['mfe_price', 'e1']]);
  });
});
