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
      isPrimary: true,
    });
    expect(resolveEvent('CNY', 'RatingDog Manufacturing PMI')?.variant).toBeNull();
  });

  it('resolves Flash and Final PMIs to distinct rungs of one indicator', () => {
    expect(resolveEvent('EUR', 'Flash Manufacturing PMI')).toEqual({
      code: 'EU_MFG_PMI',
      variant: 'flash',
      isPrimary: true,
    });
    expect(resolveEvent('EUR', 'Final Manufacturing PMI')).toEqual({
      code: 'EU_MFG_PMI',
      variant: 'final',
      isPrimary: true,
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
      isPrimary: true,
    });
    expect(resolveEvent('EUR', 'Flash GDP q/q')).toEqual({
      code: 'EU_GDP_QOQ',
      variant: 'flash',
      isPrimary: true,
    });
    expect(resolveEvent('EUR', 'Final GDP q/q')).toEqual({
      code: 'EU_GDP_QOQ',
      variant: 'final',
      isPrimary: true,
    });
  });

  it('maps the US GDP ladder to BEA terminology', () => {
    expect(resolveEvent('USD', 'Advance GDP q/q')?.variant).toBe('advance');
    expect(resolveEvent('USD', 'Prelim GDP q/q')?.variant).toBe('second');
    expect(resolveEvent('USD', 'Final GDP q/q')?.variant).toBe('third');
  });
});

describe('Companion events — primary/companion designation', () => {
  // Ladder rungs (rung()) are always primary — a variant already
  // distinguishes them, so there is never a companion relationship to encode
  // on top of it. Sanity check alongside the three real companion pairs.
  it('rung() registrations are always isPrimary: true', () => {
    expect(resolveEvent('EUR', 'Flash Manufacturing PMI')?.isPrimary).toBe(true);
    expect(resolveEvent('EUR', 'Final Manufacturing PMI')?.isPrimary).toBe(true);
    expect(resolveEvent('USD', 'Advance GDP q/q')?.isPrimary).toBe(true);
  });

  it('AU_RBA_RATE: "Cash Rate" primary, "RBA Rate Statement" companion', () => {
    expect(resolveEvent('AUD', 'Cash Rate')).toEqual({
      code: 'AU_RBA_RATE',
      variant: null,
      isPrimary: true,
    });
    expect(resolveEvent('AUD', 'RBA Rate Statement')).toEqual({
      code: 'AU_RBA_RATE',
      variant: null,
      isPrimary: false,
    });
  });

  it('UK_GDP_MOM: "GDP m/m" primary, "Prelim GDP q/q" companion', () => {
    expect(resolveEvent('GBP', 'GDP m/m')).toEqual({
      code: 'UK_GDP_MOM',
      variant: null,
      isPrimary: true,
    });
    expect(resolveEvent('GBP', 'Prelim GDP q/q')).toEqual({
      code: 'UK_GDP_MOM',
      variant: null,
      isPrimary: false,
    });
  });

  it('JP_BOJ_RATE: "BOJ Policy Rate" primary, "Monetary Policy Statement" companion', () => {
    expect(resolveEvent('JPY', 'BOJ Policy Rate')).toEqual({
      code: 'JP_BOJ_RATE',
      variant: null,
      isPrimary: true,
    });
    expect(resolveEvent('JPY', 'Monetary Policy Statement')).toEqual({
      code: 'JP_BOJ_RATE',
      variant: null,
      isPrimary: false,
    });
  });

  // GBP "Prelim GDP q/q" is a companion of UK_GDP_MOM; USD "Prelim GDP q/q"
  // (the SAME string) is rung 'second' of the US_GDP_QOQ ladder — same
  // title, opposite country, completely different role. Confirms country is
  // still the disambiguator even for isPrimary, not just for the code.
  it('the identical title string plays different roles under different countries', () => {
    expect(resolveEvent('GBP', 'Prelim GDP q/q')).toEqual({
      code: 'UK_GDP_MOM',
      variant: null,
      isPrimary: false,
    });
    expect(resolveEvent('USD', 'Prelim GDP q/q')).toEqual({
      code: 'US_GDP_QOQ',
      variant: 'second',
      isPrimary: true,
    });
  });

  // Documents the three NOT-companion multi-title codes found by the full
  // audit, so a future edit doesn't accidentally "fix" them into companion
  // pairs without re-litigating why they aren't.
  it('US_PCE_YOY: y/y is primary; m/m is NOT marked companion (flagged mis-registration, not a companion pair)', () => {
    expect(resolveEvent('USD', 'Core PCE Price Index y/y')?.isPrimary).toBe(true);
    // Deliberately still isPrimary: true — see the mapping file's inline
    // comment. Marking it companion() would misrepresent it as solved.
    expect(resolveEvent('USD', 'Core PCE Price Index m/m')?.isPrimary).toBe(true);
  });

  it('EU_CPI_YOY: both titles remain isPrimary (flash/final ladder gap, not a companion pair)', () => {
    expect(resolveEvent('EUR', 'Final CPI y/y')?.isPrimary).toBe(true);
    expect(resolveEvent('EUR', 'CPI Flash Estimate y/y')?.isPrimary).toBe(true);
  });

  it('US_ADP: both titles remain isPrimary (different cadences, not a companion pair)', () => {
    expect(resolveEvent('USD', 'ADP Weekly Employment Change')?.isPrimary).toBe(true);
    expect(resolveEvent('USD', 'ADP Non-Farm Employment Change')?.isPrimary).toBe(true);
  });

  it('CN_CAIXIN_PMI_MFG: both spellings remain isPrimary (never co-occur, no companion needed)', () => {
    expect(resolveEvent('CNY', 'RatingDog Manufacturing PMI')?.isPrimary).toBe(true);
    expect(resolveEvent('CNY', 'Caixin Manufacturing PMI')?.isPrimary).toBe(true);
  });
});

describe('Companion events — full-table audit invariant', () => {
  // Regression guard for the audit itself: no code may EVER have zero
  // isPrimary: true entries among its one() registrations. Zero primaries
  // would mean nothing can ever drive overdue for that indicator — a code
  // going permanently invisible to the resolver is a much worse failure than
  // the flagged-but-unfixed groups (which still have every title primary,
  // just not narrowed to one). This guards the fix, not a "someone will
  // remember to companion() the flagged groups later" assumption.
  it('no one()-registered code has zero primaries', async () => {
    const { FF_EVENT_TO_INDICATOR } = await import(
      '@modules/edgefinder/services/forex-factory-event-mapping'
    );

    const byCode = new Map<string, boolean[]>();
    for (const titles of Object.values(FF_EVENT_TO_INDICATOR)) {
      for (const resolution of Object.values(titles)) {
        if (resolution.variant !== null) continue; // ladder rungs excluded — see file doc
        const list = byCode.get(resolution.code) ?? [];
        list.push(resolution.isPrimary);
        byCode.set(resolution.code, list);
      }
    }

    for (const [code, flags] of byCode.entries()) {
      const primaryCount = flags.filter(Boolean).length;
      expect(primaryCount, `${code} has ${flags.length} one() titles but ${primaryCount} primaries`).toBeGreaterThanOrEqual(1);
    }
  });

  // The three codes actually fixed by this pass — AU_RBA_RATE, UK_GDP_MOM,
  // JP_BOJ_RATE — are narrowed to EXACTLY one primary. US_PCE_YOY,
  // EU_CPI_YOY, US_ADP, CN_CAIXIN_PMI_MFG are deliberately excluded from this
  // stricter check (see the "flagged mis-registration"/"not a companion
  // pair" tests above) — they still have 2 primaries each, which is correct
  // for their situation, not a bug this list should catch.
  it('the three fixed companion codes are narrowed to exactly one primary', async () => {
    const { FF_EVENT_TO_INDICATOR } = await import(
      '@modules/edgefinder/services/forex-factory-event-mapping'
    );

    const FIXED_CODES = ['AU_RBA_RATE', 'UK_GDP_MOM', 'JP_BOJ_RATE'];
    const byCode = new Map<string, boolean[]>();
    for (const titles of Object.values(FF_EVENT_TO_INDICATOR)) {
      for (const resolution of Object.values(titles)) {
        if (resolution.variant !== null) continue;
        const list = byCode.get(resolution.code) ?? [];
        list.push(resolution.isPrimary);
        byCode.set(resolution.code, list);
      }
    }

    for (const code of FIXED_CODES) {
      const flags = byCode.get(code) ?? [];
      expect(flags.length, `${code} should have exactly 2 one() titles`).toBe(2);
      expect(flags.filter(Boolean).length, `${code} should have exactly 1 primary`).toBe(1);
    }
  });
});
