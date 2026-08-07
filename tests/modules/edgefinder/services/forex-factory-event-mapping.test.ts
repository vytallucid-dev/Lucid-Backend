import { describe, it, expect } from 'vitest';
import {
  mapEventToIndicator,
  resolveEvent,
} from '@modules/edgefinder/services/forex-factory-event-mapping';

describe('mapEventToIndicator', () => {
  it('returns indicator code for known (country, title)', () => {
    expect(mapEventToIndicator('USD', 'Unemployment Claims')).toBe('US_JOBLESS_CLAIMS');
    expect(mapEventToIndicator('EUR', 'Final CPI y/y')).toBe('EU_CPI_YOY');
    expect(mapEventToIndicator('GBP', 'CPI y/y')).toBe('UK_CPI_YOY');
    expect(mapEventToIndicator('JPY', 'National Core CPI y/y')).toBe('JP_CPI_YOY');
  });

  it('returns null for a country the feed never sends', () => {
    // AUD and CNY are now mapped (they were the gap). Use a country code that
    // genuinely has no map rather than asserting a gap is still open.
    expect(mapEventToIndicator('ZAR', 'CPI y/y')).toBeNull();
  });

  it('returns null for unmapped title in known country', () => {
    expect(mapEventToIndicator('USD', 'Definitely Not A Real Event')).toBeNull();
  });

  it('maps both Flash and Final PMI titles to the same indicator (EUR Manufacturing)', () => {
    const flash = mapEventToIndicator('EUR', 'Flash Manufacturing PMI');
    const final = mapEventToIndicator('EUR', 'Final Manufacturing PMI');
    expect(flash).toBe('EU_MFG_PMI');
    expect(final).toBe('EU_MFG_PMI');
  });

  it('maps both Flash and Final PMI titles to the same indicator (JPY Services)', () => {
    const flash = mapEventToIndicator('JPY', 'Flash Services PMI');
    const final = mapEventToIndicator('JPY', 'Final Services PMI');
    expect(flash).toBe('JP_SVC_PMI');
    expect(final).toBe('JP_SVC_PMI');
  });

  it('does NOT include the contradictory "Core CPI m/m" → US_CPI_YOY entry', () => {
    expect(mapEventToIndicator('USD', 'Core CPI m/m')).toBeNull();
  });

  it('verified USD entries match exactly', () => {
    expect(mapEventToIndicator('USD', 'ADP Weekly Employment Change')).toBe('US_ADP');
    expect(mapEventToIndicator('USD', 'Federal Funds Rate')).toBe('US_FED_RATE');
    expect(mapEventToIndicator('USD', 'Non-Farm Employment Change')).toBe('US_NFP');
  });

  it('verified GBP entries match exactly', () => {
    expect(mapEventToIndicator('GBP', 'GfK Consumer Confidence')).toBe('UK_GFK');
    expect(mapEventToIndicator('GBP', 'Unemployment Rate')).toBe('UK_UNEMP');
  });
});

describe('B4: the 13 previously-unmapped indicators', () => {
  it('maps the ten AUD indicators (feed sends AUD, database stores AU)', () => {
    expect(mapEventToIndicator('AUD', 'CPI y/y')).toBe('AU_CPI_YOY');
    expect(mapEventToIndicator('AUD', 'PPI q/q')).toBe('AU_PPI_YOY');
    expect(mapEventToIndicator('AUD', 'Employment Change')).toBe('AU_EMPLOYMENT_CHANGE');
    expect(mapEventToIndicator('AUD', 'Unemployment Rate')).toBe('AU_UNEMPLOYMENT');
    expect(mapEventToIndicator('AUD', 'GDP q/q')).toBe('AU_GDP_QOQ');
    expect(mapEventToIndicator('AUD', 'Westpac Consumer Sentiment')).toBe('AU_CONSCONF');
    expect(mapEventToIndicator('AUD', 'Cash Rate')).toBe('AU_RBA_RATE');
    // VERIFIED from the live feed — FF renamed AU retail sales to this.
    expect(mapEventToIndicator('AUD', 'Household Spending m/m')).toBe('AU_MHSI_MOM');
    expect(mapEventToIndicator('AUD', 'Flash Manufacturing PMI')).toBe('AU_PMI_MFG');
    expect(mapEventToIndicator('AUD', 'Flash Services PMI')).toBe('AU_PMI_SVC');
  });

  it('maps the China PMI under the key the FEED sends (CNY), not the DB code (CN)', () => {
    expect(mapEventToIndicator('CNY', 'RatingDog Manufacturing PMI')).toBe('CN_CAIXIN_PMI_MFG');
    // The DB stores country 'CN'; using that as the key would never match.
    expect(mapEventToIndicator('CN', 'RatingDog Manufacturing PMI')).toBeNull();
  });

  it('resolves both the RatingDog and the legacy Caixin title to one code', () => {
    expect(mapEventToIndicator('CNY', 'RatingDog Manufacturing PMI')).toBe('CN_CAIXIN_PMI_MFG');
    expect(mapEventToIndicator('CNY', 'Caixin Manufacturing PMI')).toBe('CN_CAIXIN_PMI_MFG');
  });

  it('maps the two JPY gap indicators', () => {
    expect(mapEventToIndicator('JPY', 'Tokyo Core CPI y/y')).toBe('JP_TOKYO_CPI_YOY');
    expect(mapEventToIndicator('JPY', 'Average Cash Earnings y/y')).toBe('JP_CASH_EARNINGS_YOY');
  });
});

describe('B4: euro-area national sub-PMIs are excluded deliberately', () => {
  // The most tempting false positive in the feed. Mapping any of these to
  // EU_MFG_PMI / EU_SVC_PMI would silently overwrite the euro-area aggregate
  // with one member state's data — a wrong number that looks plausible.
  const SUB_PMIS = [
    'Spanish Manufacturing PMI',
    'Italian Manufacturing PMI',
    'French Final Manufacturing PMI',
    'German Final Manufacturing PMI',
    'Spanish Services PMI',
    'Italian Services PMI',
    'French Final Services PMI',
    'German Final Services PMI',
  ];

  it.each(SUB_PMIS)('does not map EUR :: "%s"', (title) => {
    expect(mapEventToIndicator('EUR', title)).toBeNull();
  });

  it('DOES map the unprefixed euro-area aggregate', () => {
    expect(mapEventToIndicator('EUR', 'Final Manufacturing PMI')).toBe('EU_MFG_PMI');
    expect(mapEventToIndicator('EUR', 'Final Services PMI')).toBe('EU_SVC_PMI');
  });
});

describe('B4: exact-string matching only', () => {
  it('does not substring-match — title alone is ambiguous across countries', () => {
    // "Final Manufacturing PMI" arrives under JPY, EUR, GBP and USD in a
    // single week. Country must disambiguate; any includes()-style matching
    // collides (this is what caused the JP_CPI_YOY duplicate-key collision).
    expect(mapEventToIndicator('JPY', 'Final Manufacturing PMI')).toBe('JP_MFG_PMI');
    expect(mapEventToIndicator('EUR', 'Final Manufacturing PMI')).toBe('EU_MFG_PMI');
    expect(mapEventToIndicator('GBP', 'Final Manufacturing PMI')).toBe('UK_MFG_PMI');
  });

  it('rejects near-misses rather than fuzzy-matching them', () => {
    expect(mapEventToIndicator('USD', 'Unemployment Claim')).toBeNull();
    expect(mapEventToIndicator('USD', 'unemployment claims')).toBeNull();
    expect(mapEventToIndicator('USD', ' Unemployment Claims')).toBeNull();
  });
});

describe('B4: variant resolution', () => {
  it('returns null variant for single-release indicators', () => {
    expect(resolveEvent('USD', 'Non-Farm Employment Change')).toEqual({
      code: 'US_NFP',
      variant: null,
    });
    expect(resolveEvent('CNY', 'RatingDog Manufacturing PMI')?.variant).toBeNull();
  });

  it('resolves Flash and Final PMIs to distinct rungs of one indicator', () => {
    expect(resolveEvent('EUR', 'Flash Manufacturing PMI')).toEqual({
      code: 'EU_MFG_PMI',
      variant: 'flash',
    });
    expect(resolveEvent('EUR', 'Final Manufacturing PMI')).toEqual({
      code: 'EU_MFG_PMI',
      variant: 'final',
    });
  });

  it('maps the EU GDP ladder with prelim BEFORE flash (FF naming reads backwards)', () => {
    // FF's "Prelim Flash GDP q/q" is the FIRST print (~30 days); their
    // "Flash GDP q/q" is the SECOND (~45 days). Ordinals live in
    // indicator_variants (prelim=1, flash=2, final=3) — this asserts the
    // string→variant half of that correction.
    expect(resolveEvent('EUR', 'Prelim Flash GDP q/q')).toEqual({
      code: 'EU_GDP_QOQ',
      variant: 'prelim',
    });
    expect(resolveEvent('EUR', 'Flash GDP q/q')).toEqual({
      code: 'EU_GDP_QOQ',
      variant: 'flash',
    });
    expect(resolveEvent('EUR', 'Final GDP q/q')).toEqual({
      code: 'EU_GDP_QOQ',
      variant: 'final',
    });
  });

  it('maps the US GDP ladder to BEA terminology', () => {
    expect(resolveEvent('USD', 'Advance GDP q/q')?.variant).toBe('advance');
    expect(resolveEvent('USD', 'Prelim GDP q/q')?.variant).toBe('second');
    expect(resolveEvent('USD', 'Final GDP q/q')?.variant).toBe('third');
  });
});
