import { describe, it, expect } from 'vitest';
import { mapEventToIndicator } from '@modules/edgefinder/services/forex-factory-event-mapping';

describe('mapEventToIndicator', () => {
  it('returns indicator code for known (country, title)', () => {
    expect(mapEventToIndicator('USD', 'Unemployment Claims')).toBe('US_JOBLESS_CLAIMS');
    expect(mapEventToIndicator('EUR', 'Final CPI y/y')).toBe('EU_CPI_YOY');
    expect(mapEventToIndicator('GBP', 'CPI y/y')).toBe('UK_CPI_YOY');
    expect(mapEventToIndicator('JPY', 'National Core CPI y/y')).toBe('JP_CPI_YOY');
  });

  it('returns null for unknown country', () => {
    expect(mapEventToIndicator('AUD', 'CPI y/y')).toBeNull();
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
