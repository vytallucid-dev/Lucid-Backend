import { describe, it, expect } from 'vitest';
import {
  evaluatePairRow,
  getEffectiveScore,
  type IndicatorScoreSnapshot,
} from '@modules/edgefinder/services/pair-score/pair-row-calculator';
import {
  PAIR_TEMPLATE,
  type Currency,
  type PairRowConfig,
} from '@modules/edgefinder/services/pair-score/pair-template.config';

function row(name: string): PairRowConfig {
  const r = PAIR_TEMPLATE.find((x) => x.rowName === name);
  if (!r) throw new Error(`Row not found in template: ${name}`);
  return r;
}

function snap(
  code: string,
  score: number,
  direction: string | null = null,
  outcome: IndicatorScoreSnapshot['outcome'] = 'scored',
): IndicatorScoreSnapshot {
  return { indicatorCode: code, score, direction, outcome };
}

describe('getEffectiveScore', () => {
  it('returns raw score when not inverted', () => {
    expect(getEffectiveScore(1, false)).toBe(1);
    expect(getEffectiveScore(-1, false)).toBe(-1);
  });
  it('negates when inverted', () => {
    expect(getEffectiveScore(1, true)).toBe(-1);
    expect(getEffectiveScore(-1, true)).toBe(1);
    // -0 === 0 in JS but Object.is differs; assert numeric equality
    expect(getEffectiveScore(0, true)).toEqual(-0);
    expect(getEffectiveScore(0, true) === 0).toBe(true);
  });
});

describe('evaluatePairRow — bilateral rows', () => {
  it('GDP both MISS → pair 0', () => {
    const r = evaluatePairRow({
      config: row('GDP'),
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      baseScore: snap('EU_GDP_QOQ', -1, 'MISS'),
      quoteScore: snap('US_GDP_QOQ', -1, 'MISS'),
    });
    expect(r.pairScore).toBe(0);
    expect(r.rowIncluded).toBe(true);
  });

  it('Services PMI EUR -1 vs USD +1 → -2 (EURUSD bearish)', () => {
    const r = evaluatePairRow({
      config: row('Services PMI'),
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      baseScore: snap('EU_SVC_PMI', -1, 'MISS'),
      quoteScore: snap('US_ISM_SVC', 1, 'BEAT'),
    });
    expect(r.pairScore).toBe(-2);
  });

  it('Retail Sales EUR -1 vs USD +1 → -2', () => {
    const r = evaluatePairRow({
      config: row('Retail Sales'),
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      baseScore: snap('EU_RETAIL_MOM', -1),
      quoteScore: snap('US_RETAIL_MOM', 1),
    });
    expect(r.pairScore).toBe(-2);
  });

  it('Unemployment EUR +1 vs USD -1 → +2 (engine handles inversion, no double-flip)', () => {
    const r = evaluatePairRow({
      config: row('Unemployment'),
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      baseScore: snap('EU_UNEMP', 1, 'BEAT'),
      quoteScore: snap('US_UNEMP', -1, 'MISS'),
    });
    expect(r.pairScore).toBe(2);
  });
});

describe('evaluatePairRow — PPI inversion (Rule A)', () => {
  it('EURUSD PPI: EUR +1 raw (inverted to -1) vs USD +1 → -2', () => {
    const r = evaluatePairRow({
      config: row('PPI'),
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      baseScore: snap('EU_PPI_MOM', 1, 'BEAT'),
      quoteScore: snap('US_PPI_MOM', 1, 'BEAT'),
    });
    expect(r.pairScore).toBe(-2);
    expect(r.indicatorA.inverted).toBe(true);
    expect(r.indicatorB.inverted).toBe(false);
    expect(r.notes).toContain('EUR PPI inverted');
  });

  it('EURJPY PPI: EUR +1 (inverted to -1) vs JPY 0 → -1', () => {
    const r = evaluatePairRow({
      config: row('PPI'),
      baseCurrency: 'EUR',
      quoteCurrency: 'JPY',
      baseScore: snap('EU_PPI_MOM', 1, 'BEAT'),
      quoteScore: snap('JP_PPI_YOY', 0, 'MET'),
    });
    expect(r.pairScore).toBe(-1);
  });

  it('GBPUSD PPI: row stays in template, pairScore forced to 0 with note (Rule B)', () => {
    const r = evaluatePairRow({
      config: row('PPI'),
      baseCurrency: 'GBP',
      quoteCurrency: 'USD',
      baseScore: snap('UK_PPI_MOM', 1, 'BEAT'),
      quoteScore: snap('US_PPI_MOM', -1, 'MISS'),
    });
    expect(r.rowIncluded).toBe(true);
    expect(r.pairScore).toBe(0);
    expect(r.indicatorA.code).toBe('UK_PPI_MOM');
    expect(r.indicatorB.code).toBe('US_PPI_MOM');
    expect(r.notes).toContain('PPI excluded from non-EUR');
  });

  it('USDJPY PPI: row stays in template, pairScore 0', () => {
    const r = evaluatePairRow({
      config: row('PPI'),
      baseCurrency: 'USD',
      quoteCurrency: 'JPY',
      baseScore: snap('US_PPI_MOM', 1),
      quoteScore: snap('JP_PPI_YOY', -1),
    });
    expect(r.rowIncluded).toBe(true);
    expect(r.pairScore).toBe(0);
    expect(r.notes).toContain('PPI excluded from non-EUR');
  });

  it('GBPJPY PPI: row stays in template, pairScore 0 (Rule B)', () => {
    const r = evaluatePairRow({
      config: row('PPI'),
      baseCurrency: 'GBP',
      quoteCurrency: 'JPY',
      baseScore: snap('UK_PPI_MOM', 1),
      quoteScore: snap('JP_PPI_YOY', 1),
    });
    expect(r.rowIncluded).toBe(true);
    expect(r.pairScore).toBe(0);
  });
});

describe('evaluatePairRow — USD-only rows', () => {
  it('PCE in EURUSD: only USD has the indicator → EUR side absent, score = -USD_score', () => {
    const r = evaluatePairRow({
      config: row('PCE'),
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      baseScore: null,
      quoteScore: snap('US_PCE_YOY', 1, 'BEAT'),
    });
    expect(r.rowIncluded).toBe(true);
    expect(r.indicatorA.code).toBeNull();
    expect(r.indicatorA.outcome).toBe('absent');
    expect(r.indicatorA.score).toBe(0);
    expect(r.pairScore).toBe(-1);
  });

  it('PCE in EURJPY: row stays in template, pairScore 0 (USD not in pair)', () => {
    const r = evaluatePairRow({
      config: row('PCE'),
      baseCurrency: 'EUR',
      quoteCurrency: 'JPY',
      baseScore: null,
      quoteScore: null,
    });
    expect(r.rowIncluded).toBe(true);
    expect(r.pairScore).toBe(0);
    expect(r.notes).toContain('PCE excluded from non-USD');
  });

  it('NFP in GBPUSD: only USD scores → USD on quote side contributes negatively', () => {
    const r = evaluatePairRow({
      config: row('NFP / Employment'),
      baseCurrency: 'GBP',
      quoteCurrency: 'USD',
      baseScore: null,
      quoteScore: snap('US_NFP', -1, 'MISS'),
    });
    expect(r.pairScore).toBe(1); // 0 - (-1) = +1 → bullish GBP vs weak US NFP
  });

  it('USD-only rows in GBPJPY: row stays in template with pairScore 0 (Rule clarification)', () => {
    for (const name of ['Jobless Claims', 'JOLTS', 'ADP', 'NFP / Employment']) {
      const r = evaluatePairRow({
        config: row(name),
        baseCurrency: 'GBP',
        quoteCurrency: 'JPY',
        baseScore: null,
        quoteScore: null,
      });
      expect(r.rowIncluded, `${name} stays included in GBPJPY`).toBe(true);
      expect(r.pairScore, `${name} pairScore 0 in GBPJPY`).toBe(0);
      expect(r.notes, `${name} note`).toContain('excluded from non-USD');
    }
  });
});

describe('evaluatePairRow — JPY-only Household Spending', () => {
  it('USDJPY: JPY side scores, USD side absent → pair = 0 - JPY_score', () => {
    const r = evaluatePairRow({
      config: row('Household Spending'),
      baseCurrency: 'USD',
      quoteCurrency: 'JPY',
      baseScore: null,
      quoteScore: snap('JP_HSHLD_SPEND', 1, 'BEAT'),
    });
    expect(r.rowIncluded).toBe(true);
    expect(r.pairScore).toBe(-1);
  });

  it('EURJPY: JPY base or quote → included; here JPY is quote, EUR side absent', () => {
    const r = evaluatePairRow({
      config: row('Household Spending'),
      baseCurrency: 'EUR',
      quoteCurrency: 'JPY',
      baseScore: null,
      quoteScore: snap('JP_HSHLD_SPEND', -1),
    });
    expect(r.rowIncluded).toBe(true);
    expect(r.pairScore).toBe(1);
  });

  it('EURUSD: no JPY → row removed from template (rowIncluded=false)', () => {
    const r = evaluatePairRow({
      config: row('Household Spending'),
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      baseScore: null,
      quoteScore: null,
    });
    expect(r.rowIncluded).toBe(false);
    expect(r.notes).toContain("not in this pair's template");
  });
});

describe('evaluatePairRow — outcome handling', () => {
  it('insufficient_data on one side → that side counts as 0 in math', () => {
    const r = evaluatePairRow({
      config: row('CPI'),
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      baseScore: snap('EU_CPI_YOY', 0, null, 'insufficient_data'),
      quoteScore: snap('US_CPI_YOY', 1, 'BEAT'),
    });
    expect(r.pairScore).toBe(-1); // 0 - 1
    expect(r.indicatorA.outcome).toBe('insufficient_data');
    expect(r.notes).toContain('insufficient_data');
  });

  it('both sides null → pair score 0 but row remains included', () => {
    const r = evaluatePairRow({
      config: row('GDP'),
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      baseScore: null,
      quoteScore: null,
    });
    expect(r.rowIncluded).toBe(true);
    expect(r.pairScore).toBe(0);
  });

  it('carry_forward outcome is honored in math', () => {
    const r = evaluatePairRow({
      config: row('GDP'),
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      baseScore: snap('EU_GDP_QOQ', 1, 'BEAT', 'carry_forward'),
      quoteScore: snap('US_GDP_QOQ', 0, 'MET'),
    });
    expect(r.pairScore).toBe(1);
    expect(r.indicatorA.outcome).toBe('carry_forward');
  });
});

describe('evaluatePairRow — clamping (defensive)', () => {
  it('clamps to +2 if math would exceed', () => {
    // Synthetic: feed +2 vs -1 → +3 → clamped to +2.
    const r = evaluatePairRow({
      config: row('CPI'),
      baseCurrency: 'EUR' as Currency,
      quoteCurrency: 'USD' as Currency,
      baseScore: snap('EU_CPI_YOY', 2),
      quoteScore: snap('US_CPI_YOY', -1),
    });
    expect(r.pairScore).toBe(2);
  });

  it('clamps to -2 if math would fall below', () => {
    const r = evaluatePairRow({
      config: row('CPI'),
      baseCurrency: 'EUR' as Currency,
      quoteCurrency: 'USD' as Currency,
      baseScore: snap('EU_CPI_YOY', -2),
      quoteScore: snap('US_CPI_YOY', 1),
    });
    expect(r.pairScore).toBe(-2);
  });
});
