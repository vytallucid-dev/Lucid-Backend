import { describe, it, expect } from 'vitest';
import {
  PAIR_TEMPLATE,
  PAIR_DEFINITIONS,
  getPairDefinition,
} from '@modules/edgefinder/services/pair-score/pair-template.config';

describe('PAIR_TEMPLATE', () => {
  it('has 15 rows (the full template incl. JPY-only Household Spending)', () => {
    expect(PAIR_TEMPLATE).toHaveLength(15);
  });

  it('GDP row has codes for all four currencies', () => {
    const gdp = PAIR_TEMPLATE.find((r) => r.rowName === 'GDP');
    expect(gdp).toBeDefined();
    expect(gdp?.indicators.USD).toBe('US_GDP_QOQ');
    expect(gdp?.indicators.EUR).toBe('EU_GDP_QOQ');
    expect(gdp?.indicators.GBP).toBe('UK_GDP_MOM');
    expect(gdp?.indicators.JPY).toBe('JP_GDP_QOQ');
  });

  it('PPI is inverted for EUR and requires EUR in the pair', () => {
    const ppi = PAIR_TEMPLATE.find((r) => r.rowName === 'PPI');
    expect(ppi?.inverted?.EUR).toBe(true);
    expect(ppi?.requiresCurrency).toEqual(['EUR']);
  });

  it('PCE/NFP/JOLTS/ADP/Jobless are USD-only and require USD', () => {
    for (const name of ['PCE', 'NFP / Employment', 'JOLTS', 'ADP', 'Jobless Claims']) {
      const row = PAIR_TEMPLATE.find((r) => r.rowName === name);
      expect(row, `row ${name}`).toBeDefined();
      expect(row?.requiresCurrency, `requiresCurrency for ${name}`).toEqual(['USD']);
      expect(Object.keys(row?.indicators ?? {})).toEqual(['USD']);
    }
  });

  it('Household Spending is JPY-only and requires JPY', () => {
    const hs = PAIR_TEMPLATE.find((r) => r.rowName === 'Household Spending');
    expect(hs?.requiresCurrency).toEqual(['JPY']);
    expect(hs?.indicators.JPY).toBe('JP_HSHLD_SPEND');
    expect(hs?.indicators.USD).toBeUndefined();
  });

  it('Consumer Confidence covers all four currencies', () => {
    const cc = PAIR_TEMPLATE.find((r) => r.rowName === 'Consumer Confidence');
    expect(cc?.indicators.USD).toBe('US_CB_CONSCONF');
    expect(cc?.indicators.EUR).toBe('EU_CCI');
    expect(cc?.indicators.GBP).toBe('UK_GFK');
    expect(cc?.indicators.JPY).toBe('JP_CONSCONF');
  });

  it('Unemployment is bilateral and NOT marked inverted (engine handles it)', () => {
    const u = PAIR_TEMPLATE.find((r) => r.rowName === 'Unemployment');
    expect(u?.indicators.USD).toBe('US_UNEMP');
    expect(u?.indicators.EUR).toBe('EU_UNEMP');
    expect(u?.indicators.GBP).toBe('UK_UNEMP');
    expect(u?.indicators.JPY).toBe('JP_UNEMP');
    expect(u?.inverted).toBeUndefined();
    expect(u?.requiresCurrency).toBeUndefined();
  });

  it('Interest Rate row uses each central bank code', () => {
    const ir = PAIR_TEMPLATE.find((r) => r.rowName === 'Interest Rate');
    expect(ir?.indicators.USD).toBe('US_FED_RATE');
    expect(ir?.indicators.EUR).toBe('EU_ECB_RATE');
    expect(ir?.indicators.GBP).toBe('UK_BOE_RATE');
    expect(ir?.indicators.JPY).toBe('JP_BOJ_RATE');
  });
});

describe('PAIR_DEFINITIONS', () => {
  it('declares exactly 5 FX pairs in spec order', () => {
    expect(PAIR_DEFINITIONS.map((p) => p.code)).toEqual([
      'EURUSD',
      'GBPUSD',
      'USDJPY',
      'EURJPY',
      'GBPJPY',
    ]);
  });

  it('declares base/quote correctly for each pair', () => {
    expect(PAIR_DEFINITIONS).toContainEqual({ code: 'EURUSD', base: 'EUR', quote: 'USD' });
    expect(PAIR_DEFINITIONS).toContainEqual({ code: 'USDJPY', base: 'USD', quote: 'JPY' });
    expect(PAIR_DEFINITIONS).toContainEqual({ code: 'GBPJPY', base: 'GBP', quote: 'JPY' });
  });
});

describe('getPairDefinition', () => {
  it('returns the matching pair', () => {
    expect(getPairDefinition('EURJPY')).toEqual({ code: 'EURJPY', base: 'EUR', quote: 'JPY' });
  });
  it('returns null for unknown code', () => {
    expect(getPairDefinition('XAUUSD')).toBeNull();
    expect(getPairDefinition('NZDUSD')).toBeNull();
  });
});
