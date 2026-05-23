import { describe, it, expect } from 'vitest';
import {
  classifyNetPositioning,
  classifyChangePercent,
} from '@core/scoring/handlers/cot/cot-label.helpers';

describe('classifyNetPositioning', () => {
  it('67.5 → Bullish', () => {
    expect(classifyNetPositioning(67.5)).toBe('Bullish');
  });

  it('55.0 → Neutral (upper boundary inclusive)', () => {
    expect(classifyNetPositioning(55.0)).toBe('Neutral');
  });

  it('55.01 → Bullish (above boundary)', () => {
    expect(classifyNetPositioning(55.01)).toBe('Bullish');
  });

  it('50 → Neutral', () => {
    expect(classifyNetPositioning(50)).toBe('Neutral');
  });

  it('45.0 → Neutral (lower boundary inclusive)', () => {
    expect(classifyNetPositioning(45.0)).toBe('Neutral');
  });

  it('44.99 → Bearish (below boundary)', () => {
    expect(classifyNetPositioning(44.99)).toBe('Bearish');
  });

  it('22 → Bearish', () => {
    expect(classifyNetPositioning(22)).toBe('Bearish');
  });
});

describe('classifyChangePercent', () => {
  it('+2.5 → Bullish', () => {
    expect(classifyChangePercent(2.5)).toBe('Bullish');
  });

  it('+0.5 → Neutral (upper boundary inclusive)', () => {
    expect(classifyChangePercent(0.5)).toBe('Neutral');
  });

  it('+0.51 → Bullish (above boundary)', () => {
    expect(classifyChangePercent(0.51)).toBe('Bullish');
  });

  it('0 → Neutral', () => {
    expect(classifyChangePercent(0)).toBe('Neutral');
  });

  it('-0.5 → Neutral (lower boundary inclusive)', () => {
    expect(classifyChangePercent(-0.5)).toBe('Neutral');
  });

  it('-0.51 → Bearish (below boundary)', () => {
    expect(classifyChangePercent(-0.51)).toBe('Bearish');
  });

  it('-4.66 → Bearish (JPY-anomaly case)', () => {
    expect(classifyChangePercent(-4.66)).toBe('Bearish');
  });
});
