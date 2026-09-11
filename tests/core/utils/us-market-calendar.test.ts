import { describe, it, expect } from 'vitest';
import {
  isUsMarketTradingDay,
  nonTradingReason,
  usMarketHolidays,
  generateTradingDays,
  toIsoDate,
} from '@core/utils/us-market-calendar';

function d(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

describe('us-market-calendar', () => {
  describe('the dates Stage 0 caught Compass classifying on', () => {
    // These four are the confirmed defect: the live classifier wrote a full
    // classification on three of them (Memorial Day was skipped only because
    // 3 of 6 inputs happened to land).
    it.each([
      ['2026-05-25', 'Memorial Day'],
      ['2026-06-19', 'Juneteenth'],
      ['2026-07-03', 'Independence Day'],
      ['2026-09-07', 'Labor Day'],
    ])('%s is NOT a trading day (%s)', (iso, name) => {
      expect(isUsMarketTradingDay(d(iso))).toBe(false);
      expect(nonTradingReason(d(iso))).toBe(name);
    });

    it('2026-07-04 is a Saturday, so Independence Day is observed on Friday the 3rd', () => {
      expect(d('2026-07-04').getUTCDay()).toBe(6);
      expect(nonTradingReason(d('2026-07-03'))).toBe('Independence Day');
    });
  });

  describe('weekends', () => {
    it('reports Saturday and Sunday distinctly', () => {
      expect(nonTradingReason(d('2026-09-05'))).toBe('Saturday');
      expect(nonTradingReason(d('2026-09-06'))).toBe('Sunday');
    });
  });

  describe('ordinary trading days either side of a holiday', () => {
    it.each(['2026-09-04', '2026-09-08', '2026-06-18', '2026-06-22'])('%s IS a trading day', (iso) => {
      expect(isUsMarketTradingDay(d(iso))).toBe(true);
      expect(nonTradingReason(d(iso))).toBeNull();
    });
  });

  describe('Good Friday (the computus)', () => {
    // Independently checkable: Easter Sunday 2025 was 20 April, 2024 was
    // 31 March, 2008 was 23 March, 2020 was 12 April.
    it.each([
      ['2025-04-18', '2025 Easter 20 Apr'],
      ['2024-03-29', '2024 Easter 31 Mar'],
      ['2008-03-21', '2008 Easter 23 Mar'],
      ['2020-04-10', '2020 Easter 12 Apr'],
    ])('%s is Good Friday (%s)', (iso) => {
      expect(nonTradingReason(d(iso))).toBe('Good Friday');
    });
  });

  describe('unscheduled closures that no rule can derive', () => {
    it('2018-12-05 (Bush day of mourning) — falls inside validation window V3 2018_Q4', () => {
      expect(isUsMarketTradingDay(d('2018-12-05'))).toBe(false);
      expect(nonTradingReason(d('2018-12-05'))).toContain('George H. W. Bush');
      // 2018-12-05 was a Wednesday: without the exception it would look normal.
      expect(d('2018-12-05').getUTCDay()).toBe(3);
    });

    it.each([
      ['2001-09-11', 'September 11 attacks'],
      ['2012-10-29', 'Hurricane Sandy'],
      ['2025-01-09', 'National day of mourning — Jimmy Carter'],
    ])('%s is closed (%s)', (iso, reason) => {
      expect(nonTradingReason(d(iso))).toBe(reason);
    });
  });

  describe('observation rule for fixed-date holidays', () => {
    it('New Year 2022 fell on a Saturday -> observed Friday 2021-12-31', () => {
      expect(d('2022-01-01').getUTCDay()).toBe(6);
      expect(isUsMarketTradingDay(d('2021-12-31'))).toBe(false);
    });

    it('Christmas 2022 fell on a Sunday -> observed Monday 2022-12-26', () => {
      expect(d('2022-12-25').getUTCDay()).toBe(0);
      expect(nonTradingReason(d('2022-12-26'))).toBe('Christmas Day');
    });

    it('New Year 2023 fell on a Sunday -> observed Monday 2023-01-02', () => {
      expect(nonTradingReason(d('2023-01-02'))).toBe("New Year's Day");
    });
  });

  describe('holidays that did not always exist', () => {
    it('Juneteenth is not a market holiday before 2022', () => {
      expect(isUsMarketTradingDay(d('2021-06-18'))).toBe(true);
      expect(nonTradingReason(d('2022-06-20'))).toBe('Juneteenth');
    });

    it('MLK Day is not observed before 1998', () => {
      // 1997-01-20 was the third Monday of January.
      expect(isUsMarketTradingDay(d('1997-01-20'))).toBe(true);
      expect(nonTradingReason(d('1998-01-19'))).toBe('Martin Luther King Jr. Day');
    });
  });

  describe('generateTradingDays', () => {
    it('excludes weekends AND holidays over the Labor Day 2026 week', () => {
      const days = generateTradingDays(d('2026-09-04'), d('2026-09-11')).map(toIsoDate);
      expect(days).toEqual([
        '2026-09-04',
        // 05, 06 weekend; 07 Labor Day
        '2026-09-08',
        '2026-09-09',
        '2026-09-10',
        '2026-09-11',
      ]);
    });

    it('is inclusive of both endpoints when they are trading days', () => {
      const days = generateTradingDays(d('2026-09-08'), d('2026-09-08')).map(toIsoDate);
      expect(days).toEqual(['2026-09-08']);
    });

    it('returns an empty array for a weekend-only range', () => {
      expect(generateTradingDays(d('2026-09-05'), d('2026-09-06'))).toEqual([]);
    });

    it('yields ~250 trading days in a full year (2024)', () => {
      const n = generateTradingDays(d('2024-01-01'), d('2024-12-31')).length;
      // NYSE traded 252 days in 2024.
      expect(n).toBe(252);
    });

    it('yields 251 trading days in 2018 — the Bush closure removes one from 252', () => {
      // 2018: 261 weekdays - 9 recurring holidays (no Juneteenth before 2022)
      // = 252, less the 5 Dec national day of mourning = 251.
      const withClosure = generateTradingDays(d('2018-01-01'), d('2018-12-31')).length;
      expect(withClosure).toBe(251);
    });
  });

  describe('usMarketHolidays', () => {
    it('returns 10 recurring closures for a modern year', () => {
      const h = usMarketHolidays(2026);
      // 10 recurring holidays; a New Year observed on 31 Dec would add an 11th.
      expect(h.size).toBeGreaterThanOrEqual(10);
      expect([...h.values()]).toContain('Thanksgiving Day');
    });

    it('Thanksgiving 2026 is the fourth Thursday of November (26 Nov)', () => {
      expect(usMarketHolidays(2026).get('2026-11-26')).toBe('Thanksgiving Day');
    });
  });
});
