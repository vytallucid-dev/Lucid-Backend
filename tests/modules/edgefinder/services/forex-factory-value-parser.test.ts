import { describe, it, expect } from 'vitest';
import { parseForexFactoryValue } from '@modules/edgefinder/services/forex-factory-value-parser';

describe('parseForexFactoryValue', () => {
  it('parses percentage values', () => {
    expect(parseForexFactoryValue('3.7%')).toBe(3.7);
  });

  it('parses negative percentage values', () => {
    expect(parseForexFactoryValue('-0.5%')).toBe(-0.5);
  });

  it('parses K (thousands) suffix', () => {
    expect(parseForexFactoryValue('25.9K')).toBe(25.9);
  });

  it('parses B (billions) suffix', () => {
    expect(parseForexFactoryValue('82.4B')).toBe(82.4);
  });

  it('parses M (millions) suffix', () => {
    expect(parseForexFactoryValue('1.38M')).toBe(1.38);
  });

  it('parses T (trillions) suffix with negative', () => {
    expect(parseForexFactoryValue('-0.23T')).toBe(-0.23);
  });

  it('returns null for empty string', () => {
    expect(parseForexFactoryValue('')).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(parseForexFactoryValue(undefined)).toBeNull();
  });

  it('returns null for null', () => {
    expect(parseForexFactoryValue(null)).toBeNull();
  });

  it('handles auction format (rate%|bid-to-cover)', () => {
    expect(parseForexFactoryValue('5.25%|3.5')).toBe(5.25);
  });

  it('handles pipe-separated value with no suffix', () => {
    expect(parseForexFactoryValue('4.91|3.5')).toBe(4.91);
  });

  it('returns null for non-numeric strings', () => {
    expect(parseForexFactoryValue('abc')).toBeNull();
  });

  it('parses raw number string without suffix', () => {
    expect(parseForexFactoryValue('3.7')).toBe(3.7);
  });
});
