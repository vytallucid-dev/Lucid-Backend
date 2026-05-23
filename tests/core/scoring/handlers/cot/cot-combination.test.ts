import { describe, it, expect } from 'vitest';
import {
  combineCotLabelsForAsset,
  combineCotLabelsForPair,
} from '@core/scoring/handlers/cot/cot-combination';

describe('combineCotLabelsForAsset (3×3 matrix)', () => {
  it('Bullish + Bullish → +2', () => {
    expect(combineCotLabelsForAsset('Bullish', 'Bullish')).toBe(2);
  });
  it('Bullish + Neutral → +1', () => {
    expect(combineCotLabelsForAsset('Bullish', 'Neutral')).toBe(1);
  });
  it('Bullish + Bearish → 0', () => {
    expect(combineCotLabelsForAsset('Bullish', 'Bearish')).toBe(0);
  });
  it('Neutral + Bullish → +1', () => {
    expect(combineCotLabelsForAsset('Neutral', 'Bullish')).toBe(1);
  });
  it('Neutral + Neutral → 0', () => {
    expect(combineCotLabelsForAsset('Neutral', 'Neutral')).toBe(0);
  });
  it('Neutral + Bearish → -1', () => {
    expect(combineCotLabelsForAsset('Neutral', 'Bearish')).toBe(-1);
  });
  it('Bearish + Bullish → 0', () => {
    expect(combineCotLabelsForAsset('Bearish', 'Bullish')).toBe(0);
  });
  it('Bearish + Neutral → -1', () => {
    expect(combineCotLabelsForAsset('Bearish', 'Neutral')).toBe(-1);
  });
  it('Bearish + Bearish → -2', () => {
    expect(combineCotLabelsForAsset('Bearish', 'Bearish')).toBe(-2);
  });
});

describe('combineCotLabelsForPair (3×3 matrix — Change% only)', () => {
  it('Bullish vs Bullish → 0', () => {
    expect(combineCotLabelsForPair('Bullish', 'Bullish')).toBe(0);
  });
  it('Bullish vs Neutral → +1', () => {
    expect(combineCotLabelsForPair('Bullish', 'Neutral')).toBe(1);
  });
  it('Bullish vs Bearish → +2', () => {
    expect(combineCotLabelsForPair('Bullish', 'Bearish')).toBe(2);
  });
  it('Neutral vs Bullish → -1', () => {
    expect(combineCotLabelsForPair('Neutral', 'Bullish')).toBe(-1);
  });
  it('Neutral vs Neutral → 0', () => {
    expect(combineCotLabelsForPair('Neutral', 'Neutral')).toBe(0);
  });
  it('Neutral vs Bearish → +1', () => {
    expect(combineCotLabelsForPair('Neutral', 'Bearish')).toBe(1);
  });
  it('Bearish vs Bullish → -2', () => {
    expect(combineCotLabelsForPair('Bearish', 'Bullish')).toBe(-2);
  });
  it('Bearish vs Neutral → -1', () => {
    expect(combineCotLabelsForPair('Bearish', 'Neutral')).toBe(-1);
  });
  it('Bearish vs Bearish → 0', () => {
    expect(combineCotLabelsForPair('Bearish', 'Bearish')).toBe(0);
  });
});
