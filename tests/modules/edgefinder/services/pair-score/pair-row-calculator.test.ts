import { describe, it, expect } from 'vitest';
import {
  evaluatePairRow,
  getEffectiveScore,
  type IndicatorScoreSnapshot,
} from '@modules/edgefinder/services/pair-score/pair-row-calculator';
import {
  dbRowToPairRowConfig,
  type Currency,
  type PairRowConfig,
} from '@modules/edgefinder/services/pair-score/pair-template.config';

/**
 * Phase 2: the static PAIR_TEMPLATE array is gone — the template is DB-driven.
 * This fixture mirrors the seeded `pair_template_rows` +
 * `pair_template_row_currencies` shape and is converted through the real
 * `dbRowToPairRowConfig`, so these tests exercise the production conversion
 * (including how `requiresCurrency` and `softExcludeWhenUnsupported` are
 * derived) rather than a hand-written config object.
 */
const TEMPLATE_FIXTURE: Array<{
  displayName: string;
  uiGroup: string;
  treatment: string;
  currencies: Array<{ currencyCode: string; indicatorCode: string | null }>;
}> = [
  { displayName: 'GDP', uiGroup: 'Growth', treatment: 'BILATERAL', currencies: [
    { currencyCode: 'AUD', indicatorCode: 'AU_GDP_QOQ' }, { currencyCode: 'EUR', indicatorCode: 'EU_GDP_QOQ' },
    { currencyCode: 'GBP', indicatorCode: 'UK_GDP_MOM' }, { currencyCode: 'JPY', indicatorCode: 'JP_GDP_QOQ' },
    { currencyCode: 'USD', indicatorCode: 'US_GDP_QOQ' } ] },
  { displayName: 'Services PMI', uiGroup: 'Growth', treatment: 'BILATERAL', currencies: [
    { currencyCode: 'EUR', indicatorCode: 'EU_SVC_PMI' }, { currencyCode: 'GBP', indicatorCode: 'UK_SVC_PMI' },
    { currencyCode: 'JPY', indicatorCode: 'JP_SVC_PMI' }, { currencyCode: 'USD', indicatorCode: 'US_ISM_SVC' } ] },
  // Phase 7: AUD restored (AU_MHSI_MOM, renamed from the retired, never-
  // populated AU_RETAIL_MOM) — this fixture mirrors the current, fully
  // bilateral 5-currency shape again. See 'Synthetic Partial Coverage' below
  // for the partial-coverage (AND-vs-OR) test case this row used to serve.
  { displayName: 'Retail Sales', uiGroup: 'Growth', treatment: 'BILATERAL', currencies: [
    { currencyCode: 'AUD', indicatorCode: 'AU_MHSI_MOM' }, { currencyCode: 'EUR', indicatorCode: 'EU_RETAIL_MOM' },
    { currencyCode: 'GBP', indicatorCode: 'UK_RETAIL_MOM' }, { currencyCode: 'JPY', indicatorCode: 'JP_RETAIL_YOY' },
    { currencyCode: 'USD', indicatorCode: 'US_RETAIL_MOM' } ] },
  // Synthetic — not a real seeded row. Exists purely to keep exercising the
  // AND-vs-OR distinction in `requirementSatisfied` for a bilateral row with
  // partial (4-of-5) currency coverage, now that Retail Sales (the real case
  // that originally motivated this fix, in Phase 6) has AUD restored.
  { displayName: 'Synthetic Partial Coverage', uiGroup: 'Growth', treatment: 'BILATERAL', currencies: [
    { currencyCode: 'EUR', indicatorCode: 'EU_RETAIL_MOM' }, { currencyCode: 'GBP', indicatorCode: 'UK_RETAIL_MOM' },
    { currencyCode: 'JPY', indicatorCode: 'JP_RETAIL_YOY' }, { currencyCode: 'USD', indicatorCode: 'US_RETAIL_MOM' } ] },
  { displayName: 'CPI', uiGroup: 'Inflation', treatment: 'BILATERAL', currencies: [
    { currencyCode: 'EUR', indicatorCode: 'EU_CPI_YOY' }, { currencyCode: 'GBP', indicatorCode: 'UK_CPI_YOY' },
    { currencyCode: 'JPY', indicatorCode: 'JP_CPI_YOY' }, { currencyCode: 'USD', indicatorCode: 'US_CPI_YOY' } ] },
  { displayName: 'PPI', uiGroup: 'Inflation', treatment: 'BILATERAL', currencies: [
    { currencyCode: 'EUR', indicatorCode: 'EU_PPI_MOM' }, { currencyCode: 'GBP', indicatorCode: 'UK_PPI_MOM' },
    { currencyCode: 'JPY', indicatorCode: 'JP_PPI_YOY' }, { currencyCode: 'USD', indicatorCode: 'US_PPI_MOM' } ] },
  { displayName: 'Unemployment', uiGroup: 'Jobs', treatment: 'BILATERAL', currencies: [
    { currencyCode: 'EUR', indicatorCode: 'EU_UNEMP' }, { currencyCode: 'GBP', indicatorCode: 'UK_UNEMP' },
    { currencyCode: 'JPY', indicatorCode: 'JP_UNEMP' }, { currencyCode: 'USD', indicatorCode: 'US_UNEMP' } ] },
  { displayName: 'PCE', uiGroup: 'Inflation', treatment: 'USD_ONLY', currencies: [
    { currencyCode: 'USD', indicatorCode: 'US_PCE_YOY' } ] },
  { displayName: 'NFP / Employment', uiGroup: 'Jobs', treatment: 'USD_ONLY', currencies: [
    { currencyCode: 'USD', indicatorCode: 'US_NFP' } ] },
  { displayName: 'Jobless Claims', uiGroup: 'Jobs', treatment: 'USD_ONLY', currencies: [
    { currencyCode: 'USD', indicatorCode: 'US_JOBLESS_CLAIMS' } ] },
  { displayName: 'JOLTS', uiGroup: 'Jobs', treatment: 'USD_ONLY', currencies: [
    { currencyCode: 'USD', indicatorCode: 'US_JOLTS' } ] },
  { displayName: 'ADP', uiGroup: 'Jobs', treatment: 'USD_ONLY', currencies: [
    { currencyCode: 'USD', indicatorCode: 'US_ADP' } ] },
  { displayName: 'Household Spending', uiGroup: 'Inflation', treatment: 'JPY_ONLY', currencies: [
    { currencyCode: 'JPY', indicatorCode: 'JP_HSHLD_SPEND' } ] },
  { displayName: 'AU Employment Change', uiGroup: 'Jobs', treatment: 'AUD_ONLY', currencies: [
    { currencyCode: 'AUD', indicatorCode: 'AU_EMPLOYMENT_CHANGE' } ] },
];

function row(name: string): PairRowConfig {
  const r = TEMPLATE_FIXTURE.find((x) => x.displayName === name);
  if (!r) throw new Error(`Row not found in template fixture: ${name}`);
  return dbRowToPairRowConfig(r);
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

/**
 * PPI is NORMAL for every currency, including EUR, and scores bilaterally in
 * every pair.
 *
 * The previous version of this block asserted the opposite — EUR-inverted, and
 * forced to 0 in non-EUR pairs. That behaviour only ever existed in the static
 * `PAIR_TEMPLATE` array, which the runtime stopped reading when pair scoring
 * moved to the DB; the seeded row has always been BILATERAL with no inversion.
 * Those tests were therefore green against dead config while production did
 * something different. Phase 2 deleted the array, so they are replaced here
 * with assertions against the behaviour that actually ships.
 */
describe('evaluatePairRow — PPI is bilateral for every currency', () => {
  it('EURUSD PPI: EUR +1 vs USD +1 → 0, and EUR is NOT inverted', () => {
    const r = evaluatePairRow({
      config: row('PPI'),
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      baseScore: snap('EU_PPI_MOM', 1, 'BEAT'),
      quoteScore: snap('US_PPI_MOM', 1, 'BEAT'),
    });
    expect(r.pairScore).toBe(0);
    expect(r.indicatorA.inverted).toBe(false);
    expect(r.indicatorB.inverted).toBe(false);
    expect(r.notes).toBeNull();
  });

  it('EURJPY PPI: EUR +1 vs JPY 0 → +1', () => {
    const r = evaluatePairRow({
      config: row('PPI'),
      baseCurrency: 'EUR',
      quoteCurrency: 'JPY',
      baseScore: snap('EU_PPI_MOM', 1, 'BEAT'),
      quoteScore: snap('JP_PPI_YOY', 0, 'MET'),
    });
    expect(r.pairScore).toBe(1);
  });

  it('GBPUSD PPI: scores normally in a pair with no EUR', () => {
    const r = evaluatePairRow({
      config: row('PPI'),
      baseCurrency: 'GBP',
      quoteCurrency: 'USD',
      baseScore: snap('UK_PPI_MOM', 1, 'BEAT'),
      quoteScore: snap('US_PPI_MOM', -1, 'MISS'),
    });
    expect(r.rowIncluded).toBe(true);
    expect(r.pairScore).toBe(2);
    expect(r.notes).toBeNull();
  });

  it('GBPJPY PPI: scores normally, no EUR requirement', () => {
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

describe('evaluatePairRow — Phase 3 exclusion asymmetry', () => {
  it('AUD-only row is HARD-excluded from a pair with no AUD', () => {
    const r = evaluatePairRow({
      config: row('AU Employment Change'),
      baseCurrency: 'USD',
      quoteCurrency: 'JPY',
      baseScore: null,
      quoteScore: null,
    });
    expect(r.rowIncluded).toBe(false);
    expect(r.notes).toContain("not in this pair's template");
  });

  it('USD-only row is SOFT-excluded (stays visible, scores 0) in a pair with no USD', () => {
    const r = evaluatePairRow({
      config: row('PCE'),
      baseCurrency: 'EUR',
      quoteCurrency: 'JPY',
      baseScore: null,
      quoteScore: null,
    });
    expect(r.rowIncluded).toBe(true);
    expect(r.pairScore).toBe(0);
    expect(r.notes).toContain('excluded from non-USD pair scoring per spec');
  });

  it('the soft/hard decision is a property of the row, not its name', () => {
    expect(row('PCE').softExcludeWhenUnsupported).toBe(true); // USD_ONLY
    expect(row('NFP / Employment').softExcludeWhenUnsupported).toBe(true); // USD_ONLY
    expect(row('Household Spending').softExcludeWhenUnsupported).toBe(false); // JPY_ONLY
    expect(row('AU Employment Change').softExcludeWhenUnsupported).toBe(false); // AUD_ONLY
    expect(row('GDP').softExcludeWhenUnsupported).toBe(false); // BILATERAL
  });

  it('AUD-only row inverts sign with base/quote position', () => {
    const s = snap('AU_EMPLOYMENT_CHANGE', 1, 'BEAT');
    const asBase = evaluatePairRow({
      config: row('AU Employment Change'),
      baseCurrency: 'AUD',
      quoteCurrency: 'JPY',
      baseScore: s,
      quoteScore: null,
    });
    const asQuote = evaluatePairRow({
      config: row('AU Employment Change'),
      baseCurrency: 'EUR',
      quoteCurrency: 'AUD',
      baseScore: null,
      quoteScore: s,
    });
    expect(asBase.pairScore).toBe(1);
    expect(asQuote.pairScore).toBe(-1);
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

/**
 * Phase 6 introduced the AND-vs-OR distinction in `requirementSatisfied` when
 * AU_RETAIL_MOM was retired and Retail Sales briefly had only 4 of 5
 * currencies mapped. Phase 7 reversed that retirement (AU_MHSI_MOM restores
 * AUD to Retail Sales), so this suite now exercises the mechanism against the
 * synthetic 'Synthetic Partial Coverage' fixture row instead — the general
 * capability (a bilateral row losing a currency must hard-exclude the pairs
 * that currency would've been on, not silently degrade into a one-sided
 * score) still needs coverage even with no real row currently in that state.
 */
describe('evaluatePairRow — partial-coverage bilateral row (synthetic, general AND-vs-OR coverage)', () => {
  it('AUDUSD: AUD side unmapped → row HARD-excluded, not a silent one-sided score', () => {
    const r = evaluatePairRow({
      config: row('Synthetic Partial Coverage'),
      baseCurrency: 'AUD' as Currency,
      quoteCurrency: 'USD',
      baseScore: null,
      quoteScore: snap('US_RETAIL_MOM', -1, 'MISS'),
    });
    expect(r.rowIncluded).toBe(false);
    expect(r.notes).toContain("not in this pair's template");
  });

  it('AUDJPY: AUD side unmapped → row HARD-excluded', () => {
    const r = evaluatePairRow({
      config: row('Synthetic Partial Coverage'),
      baseCurrency: 'AUD' as Currency,
      quoteCurrency: 'JPY',
      baseScore: null,
      quoteScore: snap('JP_RETAIL_YOY', 1, 'BEAT'),
    });
    expect(r.rowIncluded).toBe(false);
  });

  it('EURAUD / GBPAUD: AUD side unmapped → row HARD-excluded regardless of which side AUD is on', () => {
    const eurAud = evaluatePairRow({
      config: row('Synthetic Partial Coverage'),
      baseCurrency: 'EUR',
      quoteCurrency: 'AUD' as Currency,
      baseScore: snap('EU_RETAIL_MOM', 1, 'BEAT'),
      quoteScore: null,
    });
    const gbpAud = evaluatePairRow({
      config: row('Synthetic Partial Coverage'),
      baseCurrency: 'GBP',
      quoteCurrency: 'AUD' as Currency,
      baseScore: snap('UK_RETAIL_MOM', 1, 'BEAT'),
      quoteScore: null,
    });
    expect(eurAud.rowIncluded).toBe(false);
    expect(gbpAud.rowIncluded).toBe(false);
  });

  it('EURJPY: both sides fully covered → row still bilateral and included (no regression)', () => {
    const r = evaluatePairRow({
      config: row('Synthetic Partial Coverage'),
      baseCurrency: 'EUR',
      quoteCurrency: 'JPY',
      baseScore: snap('EU_RETAIL_MOM', 1, 'BEAT'),
      quoteScore: snap('JP_RETAIL_YOY', -1, 'MISS'),
    });
    expect(r.rowIncluded).toBe(true);
    expect(r.pairScore).toBe(2);
  });

  it('Phase 7: Retail Sales itself is fully restored — AUDUSD is bilateral again, not excluded', () => {
    const r = evaluatePairRow({
      config: row('Retail Sales'),
      baseCurrency: 'AUD' as Currency,
      quoteCurrency: 'USD',
      baseScore: snap('AU_MHSI_MOM', 1, 'BEAT'),
      quoteScore: snap('US_RETAIL_MOM', -1, 'MISS'),
    });
    expect(r.rowIncluded).toBe(true);
    expect(r.pairScore).toBe(2);
    expect(r.indicatorA.code).toBe('AU_MHSI_MOM');
  });

  it('single-currency (USD_ONLY) rows are unaffected: PCE still soft-included via OR in EURUSD', () => {
    const r = evaluatePairRow({
      config: row('PCE'),
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      baseScore: null,
      quoteScore: snap('US_PCE_YOY', 1, 'BEAT'),
    });
    expect(r.rowIncluded).toBe(true);
    expect(r.pairScore).toBe(-1);
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
