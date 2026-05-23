import { vi, describe, it, expect } from 'vitest';

vi.mock('@core/db/prisma', () => ({
  prisma: {
    edgefinderScorecard: { findMany: vi.fn() },
    edgefinderPairScore: { findMany: vi.fn() },
  },
}));

import {
  scoreToFrontendBias,
  clampCotValue,
  scoreToIndicatorValue,
  pairScoreToIndicatorValue,
  isStale,
  formatDateShort,
  formatPercentWithSign,
  formatNumberWithSign,
  formatIndicatorValue,
  computeSurprise,
  computeNextRelease,
  INDICATOR_SLOT,
  PAIR_ROW_TO_SLOT,
  EMPTY_INDICATOR_SLOTS,
  uiGroupToSectionLabel,
  uiGroupToHeatmapCategory,
  dbFrequencyToHeatmapFrequency,
} from '@modules/edgefinder/api/oracle-mappers';

// ============================================================================
// scoreToFrontendBias
// ============================================================================

describe('scoreToFrontendBias', () => {
  it('returns Strong Bullish for score >= 5', () => {
    expect(scoreToFrontendBias(5)).toBe('Strong Bullish');
    expect(scoreToFrontendBias(8)).toBe('Strong Bullish');
  });

  it('returns Bullish for score 3 or 4', () => {
    expect(scoreToFrontendBias(3)).toBe('Bullish');
    expect(scoreToFrontendBias(4)).toBe('Bullish');
  });

  it('returns Neutral for score -2 through 2', () => {
    expect(scoreToFrontendBias(0)).toBe('Neutral');
    expect(scoreToFrontendBias(2)).toBe('Neutral');
    expect(scoreToFrontendBias(-2)).toBe('Neutral');
  });

  it('returns Bearish for score -3 or -4', () => {
    expect(scoreToFrontendBias(-3)).toBe('Bearish');
    expect(scoreToFrontendBias(-4)).toBe('Bearish');
  });

  it('returns Strong Bearish for score <= -5', () => {
    expect(scoreToFrontendBias(-5)).toBe('Strong Bearish');
    expect(scoreToFrontendBias(-10)).toBe('Strong Bearish');
  });
});

// ============================================================================
// clampCotValue
// ============================================================================

describe('clampCotValue', () => {
  it('clamps high values to 2', () => {
    expect(clampCotValue(2)).toBe(2);
    expect(clampCotValue(5)).toBe(2);
  });

  it('passes through 1, 0, -1', () => {
    expect(clampCotValue(1)).toBe(1);
    expect(clampCotValue(0)).toBe(0);
    expect(clampCotValue(-1)).toBe(-1);
  });

  it('clamps low values to -2', () => {
    expect(clampCotValue(-2)).toBe(-2);
    expect(clampCotValue(-5)).toBe(-2);
  });
});

// ============================================================================
// scoreToIndicatorValue
// ============================================================================

describe('scoreToIndicatorValue', () => {
  it('returns null for insufficient_data outcome', () => {
    expect(scoreToIndicatorValue(1, 'insufficient_data')).toBeNull();
  });

  it('returns null for absent outcome', () => {
    expect(scoreToIndicatorValue(1, 'absent')).toBeNull();
  });

  it('returns null when score is null', () => {
    expect(scoreToIndicatorValue(null, 'scored')).toBeNull();
  });

  it('returns 1 for positive score with scored outcome', () => {
    expect(scoreToIndicatorValue(2, 'scored')).toBe(1);
  });

  it('returns -1 for negative score with carry_forward outcome', () => {
    expect(scoreToIndicatorValue(-1, 'carry_forward')).toBe(-1);
  });

  it('returns 0 for score 0 with scored outcome', () => {
    expect(scoreToIndicatorValue(0, 'scored')).toBe(0);
  });
});

// ============================================================================
// pairScoreToIndicatorValue
// ============================================================================

describe('pairScoreToIndicatorValue', () => {
  it('returns null when row is not included', () => {
    expect(pairScoreToIndicatorValue(2, false)).toBeNull();
  });

  it('returns 1 for positive pairScore when included', () => {
    expect(pairScoreToIndicatorValue(1, true)).toBe(1);
  });

  it('returns -1 for negative pairScore when included', () => {
    expect(pairScoreToIndicatorValue(-2, true)).toBe(-1);
  });

  it('returns 0 for zero pairScore when included', () => {
    expect(pairScoreToIndicatorValue(0, true)).toBe(0);
  });
});

// ============================================================================
// isStale
// ============================================================================

describe('isStale', () => {
  it('returns false when observation is within 60 days', () => {
    const asOf = new Date('2026-05-19');
    const obs = new Date('2026-04-20');
    expect(isStale(obs, asOf)).toBe(false);
  });

  it('returns true when observation is older than 60 days', () => {
    const asOf = new Date('2026-05-19');
    const obs = new Date('2026-01-01');
    expect(isStale(obs, asOf)).toBe(true);
  });
});

// ============================================================================
// formatDateShort
// ============================================================================

describe('formatDateShort', () => {
  it('formats a date as "Mon D, YYYY"', () => {
    expect(formatDateShort(new Date('2026-03-27T00:00:00.000Z'))).toBe('Mar 27, 2026');
  });

  it('handles January and single-digit day', () => {
    expect(formatDateShort(new Date('2026-01-05T00:00:00.000Z'))).toBe('Jan 5, 2026');
  });
});

// ============================================================================
// formatPercentWithSign / formatNumberWithSign
// ============================================================================

describe('formatPercentWithSign', () => {
  it('adds + for positive', () => {
    expect(formatPercentWithSign(3.8)).toBe('+3.8%');
  });

  it('adds - for negative', () => {
    expect(formatPercentWithSign(-1.2)).toBe('-1.2%');
  });

  it('adds + for zero', () => {
    expect(formatPercentWithSign(0)).toBe('+0.0%');
  });
});

describe('formatNumberWithSign', () => {
  it('adds + for positive', () => {
    expect(formatNumberWithSign(3.8)).toBe('+3.8');
  });

  it('adds - for negative', () => {
    expect(formatNumberWithSign(-1.2)).toBe('-1.2');
  });
});

// ============================================================================
// formatIndicatorValue
// ============================================================================

describe('formatIndicatorValue', () => {
  it('returns — for null value', () => {
    expect(formatIndicatorValue('US_CPI_YOY', null)).toBe('—');
  });

  it('formats US_02Y_SMA as yield percent', () => {
    expect(formatIndicatorValue('US_02Y_SMA', 4.75)).toBe('4.75%');
  });

  it('formats NFP as K (value stored in K units)', () => {
    expect(formatIndicatorValue('US_NFP', 177)).toBe('177K');
  });

  it('formats ADP as K (value stored in K units)', () => {
    expect(formatIndicatorValue('US_ADP', 109)).toBe('109K');
  });

  it('formats JOLTS as M (value stored in M units)', () => {
    expect(formatIndicatorValue('US_JOLTS', 7.5)).toBe('7.50M');
  });

  it('formats percent indicators with 1 decimal', () => {
    expect(formatIndicatorValue('US_CPI_YOY', 3.5)).toBe('3.5%');
    expect(formatIndicatorValue('EU_CPI_YOY', 2.4)).toBe('2.4%');
  });

  it('formats other indicators as plain number', () => {
    expect(formatIndicatorValue('US_CB_CONSCONF', 102.3)).toBe('102.3');
  });
});

// ============================================================================
// computeSurprise
// ============================================================================

describe('computeSurprise', () => {
  it('returns +K surprise for NFP beat (values in K units)', () => {
    expect(computeSurprise('US_NFP', 200, 170)).toBe('+30K');
  });

  it('returns -K surprise for NFP miss (values in K units)', () => {
    expect(computeSurprise('US_NFP', 140, 170)).toBe('-30K');
  });

  it('returns +K surprise for ADP beat (values in K units)', () => {
    expect(computeSurprise('US_ADP', 109, 84)).toBe('+25K');
  });

  it('returns +M surprise for JOLTS beat (values in M units)', () => {
    expect(computeSurprise('US_JOLTS', 8.0, 7.5)).toBe('+0.50M');
  });

  it('returns percent surprise for CPI', () => {
    expect(computeSurprise('US_CPI_YOY', 3.5, 3.4)).toBe('+0.1%');
  });

  it('returns numeric surprise for CB_CONSCONF', () => {
    expect(computeSurprise('US_CB_CONSCONF', 105.0, 100.0)).toBe('+5.0');
  });
});

// ============================================================================
// computeNextRelease
// ============================================================================

describe('computeNextRelease', () => {
  it('returns Daily for daily frequency', () => {
    expect(computeNextRelease(new Date(), 'daily')).toBe('Daily');
  });

  it('returns — for unknown/event_driven frequency', () => {
    expect(computeNextRelease(new Date(), 'event_driven')).toBe('—');
  });

  it('adds ~30 days for monthly', () => {
    const base = new Date('2026-04-01T00:00:00.000Z');
    const result = computeNextRelease(base, 'monthly');
    expect(result).toBe('May 1, 2026');
  });

  it('adds ~7 days for weekly', () => {
    const base = new Date('2026-05-01T00:00:00.000Z');
    const result = computeNextRelease(base, 'weekly');
    expect(result).toBe('May 8, 2026');
  });
});

// ============================================================================
// INDICATOR_SLOT / PAIR_ROW_TO_SLOT coverage
// ============================================================================

describe('INDICATOR_SLOT', () => {
  it('maps US GDP indicator to gdp slot', () => {
    expect(INDICATOR_SLOT['US_GDP_QOQ']).toBe('gdp');
  });

  it('maps US_02Y_SMA to yield slot', () => {
    expect(INDICATOR_SLOT['US_02Y_SMA']).toBe('yield');
  });

  it('all slot values are keys of EMPTY_INDICATOR_SLOTS', () => {
    const validSlots = Object.keys(EMPTY_INDICATOR_SLOTS);
    for (const slot of Object.values(INDICATOR_SLOT)) {
      expect(validSlots).toContain(slot);
    }
  });
});

describe('PAIR_ROW_TO_SLOT', () => {
  it('maps GDP row to gdp slot', () => {
    expect(PAIR_ROW_TO_SLOT['GDP']).toBe('gdp');
  });

  it('maps Interest Rate row to yield slot', () => {
    expect(PAIR_ROW_TO_SLOT['Interest Rate']).toBe('yield');
  });

  it('all slot values are keys of EMPTY_INDICATOR_SLOTS', () => {
    const validSlots = Object.keys(EMPTY_INDICATOR_SLOTS);
    for (const slot of Object.values(PAIR_ROW_TO_SLOT)) {
      expect(validSlots).toContain(slot);
    }
  });
});

// ============================================================================
// uiGroupToSectionLabel / uiGroupToHeatmapCategory
// ============================================================================

describe('uiGroupToSectionLabel', () => {
  it('maps Growth → ECONOMIC GROWTH', () => {
    expect(uiGroupToSectionLabel('Growth')).toBe('ECONOMIC GROWTH');
  });

  it('maps Sentiment → ECONOMIC GROWTH', () => {
    expect(uiGroupToSectionLabel('Sentiment')).toBe('ECONOMIC GROWTH');
  });

  it('maps Inflation → INFLATION', () => {
    expect(uiGroupToSectionLabel('Inflation')).toBe('INFLATION');
  });

  it('maps Rates → INFLATION', () => {
    expect(uiGroupToSectionLabel('Rates')).toBe('INFLATION');
  });

  it('maps Jobs → JOBS MARKET', () => {
    expect(uiGroupToSectionLabel('Jobs')).toBe('JOBS MARKET');
  });

  it('returns null for unknown group', () => {
    expect(uiGroupToSectionLabel('COT')).toBeNull();
  });
});

describe('uiGroupToHeatmapCategory', () => {
  it('maps Growth → ECONOMIC GROWTH', () => {
    expect(uiGroupToHeatmapCategory('Growth')).toBe('ECONOMIC GROWTH');
  });

  it('maps Rates → INFLATION', () => {
    expect(uiGroupToHeatmapCategory('Rates')).toBe('INFLATION');
  });

  it('returns null for COT group', () => {
    expect(uiGroupToHeatmapCategory('COT')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(uiGroupToHeatmapCategory(null)).toBeNull();
  });
});

// ============================================================================
// dbFrequencyToHeatmapFrequency
// ============================================================================

describe('dbFrequencyToHeatmapFrequency', () => {
  it('converts monthly → Monthly', () => {
    expect(dbFrequencyToHeatmapFrequency('monthly')).toBe('Monthly');
  });

  it('converts quarterly → Quarterly', () => {
    expect(dbFrequencyToHeatmapFrequency('quarterly')).toBe('Quarterly');
  });

  it('converts weekly → Weekly', () => {
    expect(dbFrequencyToHeatmapFrequency('weekly')).toBe('Weekly');
  });

  it('converts daily → Daily', () => {
    expect(dbFrequencyToHeatmapFrequency('daily')).toBe('Daily');
  });

  it('defaults to Daily for unknown', () => {
    expect(dbFrequencyToHeatmapFrequency('event_driven')).toBe('Daily');
  });
});
