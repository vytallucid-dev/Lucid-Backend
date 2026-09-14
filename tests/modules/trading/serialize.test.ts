import { describe, it, expect } from 'vitest';
import { Prisma, type Execution } from '@prisma/client';
import { toTradeDto, toExecutionDto, type TradeWithExecutions } from '@modules/trading/services/serialize';

const D = (v: number | string): Prisma.Decimal => new Prisma.Decimal(v);

function execution(over: Partial<Execution> = {}): Execution {
  return {
    id: 'e1',
    tradeId: 't1',
    accountId: 'a1',
    isPrimary: false,
    riskPct: D(1),
    lotSize: D('0.5'),
    entryPrice: D('1.15865'),
    partialExitPrice: null,
    partialExitLotPct: null,
    mainExitPrice: D('1.16635'),
    exitType: 'TP',
    dateClosed: new Date('2026-08-19T10:00:00Z'),
    totalPips: D(77),
    blendedPnl: D(95),
    blendedRr: D('1.86'),
    oracleScoreAtExit: null,
    oracleScoreExitDate: null,
    oracleScoreExitCapturedAt: null,
    createdAt: new Date('2026-08-17T00:00:00Z'),
    updatedAt: new Date('2026-08-19T10:00:00Z'),
    ...over,
  } as Execution;
}

function trade(executions: Execution[]): TradeWithExecutions {
  return {
    id: 't1',
    userId: '00000000-0000-0000-0000-000000000000',
    model: 'Breakout',
    pair: 'EURUSD',
    direction: 'Buy',
    plannedEntry: D('1.15865'),
    plannedSl: D('1.1545'),
    plannedFirstTp: null,
    plannedMainTp: D('1.16635'),
    conviction: 'High',
    dateOpened: new Date('2026-08-17T02:00:00Z'),
    session: 'Asian',
    screenshots: [],
    psychology: null,
    notes: null,
    oracleScoreAtEntry: 4,
    oracleScoreEntryDate: new Date('2026-08-17T00:00:00Z'),
    oracleScoreEntryCapturedAt: new Date('2026-08-17T02:00:05Z'),
    oracleScoreEntrySource: 'snapshot',
    createdAt: new Date('2026-08-17T02:00:05Z'),
    updatedAt: new Date('2026-08-19T10:00:00Z'),
    executions,
  } as TradeWithExecutions;
}

describe('toTradeDto', () => {
  it('orders the primary execution first, then creation order', () => {
    const secondary = execution({ id: 'e-secondary', isPrimary: false, riskPct: D('1.5'), blendedPnl: D(275) });
    const primary = execution({ id: 'e-primary', isPrimary: true, riskPct: D('0.4') });
    const dto = toTradeDto(trade([secondary, primary]));
    expect(dto.executions.map((e) => e.id)).toEqual(['e-primary', 'e-secondary']);
  });

  it('derives expected R from the plan and keeps both fills at the same realised R', () => {
    const dto = toTradeDto(trade([execution({ isPrimary: true }), execution({ id: 'e2', riskPct: D('1.5'), blendedPnl: D(275) })]));
    expect(dto.expected_rr).toBe(1.86);
    expect(dto.executions.every((e) => e.blended_rr === 1.86)).toBe(true);
    // No idea-level dollar field exists on the wire — only per-execution P&L.
    expect(Object.keys(dto)).not.toContain('net_pnl');
    expect(Object.keys(dto)).not.toContain('blended_pnl');
  });

  it('flags an execution whose R contradicts its outcome via integrity', () => {
    const bad = execution({ isPrimary: true, exitType: 'BE', blendedPnl: D(0), mainExitPrice: D('1.16635') });
    const dto = toTradeDto(trade([bad]));
    expect(dto.integrity.ok).toBe(false);
    expect(dto.integrity.problems[0]).toMatchObject({ field: 'main_exit_price', severity: 'advisory', execution_id: 'e1' });
  });

  it('judges integrity on the full fill set even when the list is narrowed to one account', () => {
    const clean = execution({ id: 'clean', accountId: 'a1', isPrimary: true });
    const bad = execution({ id: 'bad', accountId: 'a2', exitType: 'SL', blendedPnl: D(-50) });
    const narrowed = trade([clean]);
    expect(toTradeDto(narrowed, [clean, bad]).integrity.ok).toBe(false);
  });
});

describe('toExecutionDto', () => {
  it('serialises an open fill with an empty close date and zero exit', () => {
    const dto = toExecutionDto(execution({ dateClosed: null, mainExitPrice: null, blendedPnl: D(0), blendedRr: D(0) }));
    expect(dto.date_closed).toBe('');
    expect(dto.main_exit_price).toBe(0);
  });
});

describe('capture fields', () => {
  it('derives MFE/MAE in R against the idea stop, and exit efficiency from the realised R', () => {
    // entry 1.15865, stop 1.1545 → risk 0.00415. MFE 1.168 → +2.25R; MAE 1.156 → −0.64R;
    // realised 1.86R ÷ 2.253R → 0.83.
    const dto = toTradeDto(
      trade([execution({ isPrimary: true, mfePrice: D('1.168'), maePrice: D('1.156'), returnedToEntryAfterMfe: false })]),
    );
    const e = dto.executions[0];
    expect(e.mfe_price).toBe(1.168);
    expect(e.mae_price).toBe(1.156);
    expect(e.mfe_r).toBe(2.25);
    expect(e.mae_r).toBe(-0.64);
    expect(e.exit_efficiency).toBe(0.83);
    expect(e.returned_to_entry_after_mfe).toBe(false);
  });

  it('reports unrecorded excursion as null, never zero', () => {
    const e = toTradeDto(trade([execution({ isPrimary: true })])).executions[0];
    expect([e.mfe_price, e.mae_price, e.mfe_r, e.mae_r, e.exit_efficiency, e.returned_to_entry_after_mfe]).toEqual([
      null, null, null, null, null, null,
    ]);
  });

  it('gives no exit efficiency while the fill is open or its MFE is not in profit', () => {
    const open = toTradeDto(trade([execution({ isPrimary: true, dateClosed: null, mfePrice: D('1.168') })])).executions[0];
    expect(open.exit_efficiency).toBeNull();
    const underwater = toTradeDto(trade([execution({ isPrimary: true, mfePrice: D('1.15865') })])).executions[0];
    expect(underwater.mfe_r).toBe(0);
    expect(underwater.exit_efficiency).toBeNull();
  });

  it('serialises the Compass regime snapshot and the rule breaks', () => {
    const t = {
      ...trade([execution({ isPrimary: true })]),
      compassRegimeAtEntry: 'Caution',
      compassRegimeEntryDate: new Date('2026-08-14T00:00:00Z'),
      compassRegimeEntrySource: 'snapshot',
      ruleBreaks: ['moved-stop', 'early-exit'],
    } as TradeWithExecutions;
    const dto = toTradeDto(t);
    expect(dto.compass_regime_at_entry).toBe('Caution');
    expect(dto.compass_regime_entry_date).toBe('2026-08-14');
    expect(dto.compass_regime_entry_source).toBe('snapshot');
    expect(dto.rule_breaks).toEqual(['moved-stop', 'early-exit']);
  });

  it('reads a trade logged before capture existed as no regime and no rule breaks', () => {
    const dto = toTradeDto(trade([execution({ isPrimary: true })]));
    expect(dto.compass_regime_at_entry).toBeNull();
    expect(dto.compass_regime_entry_date).toBeNull();
    expect(dto.compass_regime_entry_source).toBeNull();
    expect(dto.rule_breaks).toEqual([]);
  });
});
