import { vi, describe, it, expect, beforeEach } from 'vitest';

type ClassRow = {
  classificationDate: Date;
  activeRegime: 'Risk-On' | 'Caution' | 'Risk-Off';
  crisisOverrideFired: boolean;
};

const state: { rows: ClassRow[]; reports: unknown[] } = {
  rows: [],
  reports: [],
};

vi.mock('@core/db/prisma', () => ({
  prisma: {
    compassClassification: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            isValidation: boolean;
            isCurrent: boolean;
            classificationDate: { gte: Date; lte: Date };
          };
        }) => {
          void where.isValidation;
          void where.isCurrent;
          return state.rows
            .filter(
              (r) =>
                r.classificationDate.getTime() >=
                  where.classificationDate.gte.getTime() &&
                r.classificationDate.getTime() <=
                  where.classificationDate.lte.getTime(),
            )
            .sort(
              (a, b) =>
                a.classificationDate.getTime() - b.classificationDate.getTime(),
            );
        },
      ),
    },
    compassValidationReport: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: 'rep-1', generatedAt: new Date(), ...data };
        state.reports.push(row);
        return row;
      }),
      findFirst: vi.fn(async () => {
        return state.reports[state.reports.length - 1] ?? null;
      }),
    },
  },
}));

import {
  runValidation,
  getMostRecentReport,
} from '@modules/edgefinder/services/compass/validation/validation-harness.service';

function utc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

function tradingDaysBetween(start: Date, end: Date): Date[] {
  const out: Date[] = [];
  const cursor = new Date(start);
  while (cursor.getTime() <= end.getTime()) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/**
 * Build classification rows for a window with the given regime distribution.
 * `pattern` is a function that returns the regime per date.
 */
function fillWindow(
  start: Date,
  end: Date,
  pattern: (d: Date) => 'Risk-On' | 'Caution' | 'Risk-Off',
  crisisDates: Date[] = [],
): ClassRow[] {
  const crisisSet = new Set(crisisDates.map((d) => d.getTime()));
  return tradingDaysBetween(start, end).map((d) => ({
    classificationDate: d,
    activeRegime: pattern(d),
    crisisOverrideFired: crisisSet.has(d.getTime()),
  }));
}

describe('runValidation', () => {
  beforeEach(() => {
    state.rows = [];
    state.reports = [];
    vi.clearAllMocks();
  });

  it('returns overallPassed=false with "no data" failures when database is empty', async () => {
    const report = await runValidation();
    expect(report.overallPassed).toBe(false);
    expect(report.windowResults).toHaveLength(4);
    for (const w of report.windowResults) {
      expect(w.passed).toBe(false);
      expect(w.failures.some((f) => f.includes('no classifications'))).toBe(true);
      expect(w.totalTradingDays).toBe(0);
    }
  });

  it('persists a report row with overall_passed and window_results JSON', async () => {
    const report = await runValidation();
    expect(report.id).toBeDefined();
    expect(state.reports).toHaveLength(1);
  });

  it('2008_GFC passes when >=60% Risk-Off + crisis override fires on 2008-09-29', async () => {
    // Fill 2008 with mostly Risk-Off
    state.rows.push(
      ...fillWindow(
        utc(2008, 7, 1),
        utc(2008, 12, 31),
        (d) => (d.getTime() >= utc(2008, 8, 1).getTime() ? 'Risk-Off' : 'Caution'),
        [utc(2008, 9, 29)],
      ),
    );
    // Fill other windows minimally so they don't crash
    state.rows.push(
      ...fillWindow(utc(2020, 1, 15), utc(2020, 5, 31), () => 'Risk-Off', [utc(2020, 3, 16)]),
    );

    const report = await runValidation();
    const gfc = report.windowResults.find((w) => w.windowName === '2008_GFC');
    expect(gfc).toBeDefined();
    expect(gfc!.passed).toBe(true);
    expect(gfc!.crisisOverrideFiredOnPeak).toBe(true);
    expect(gfc!.riskOffPercent).toBeGreaterThanOrEqual(60);
  });

  it('fails a 60%-required window when Risk-Off is below threshold', async () => {
    state.rows.push(
      ...fillWindow(
        utc(2008, 7, 1),
        utc(2008, 12, 31),
        () => 'Caution',
        [utc(2008, 9, 29)], // crisis override fires
      ),
    );
    const report = await runValidation();
    const gfc = report.windowResults.find((w) => w.windowName === '2008_GFC');
    expect(gfc!.passed).toBe(false);
    expect(gfc!.failures.some((f) => f.includes('below threshold'))).toBe(true);
  });

  it('fails 2008/2020 when crisis override did not fire on peak date', async () => {
    state.rows.push(
      ...fillWindow(
        utc(2008, 7, 1),
        utc(2008, 12, 31),
        () => 'Risk-Off',
        [], // no crisis override anywhere
      ),
    );
    const report = await runValidation();
    const gfc = report.windowResults.find((w) => w.windowName === '2008_GFC');
    expect(gfc!.passed).toBe(false);
    expect(gfc!.crisisOverrideFiredOnPeak).toBe(false);
    expect(gfc!.failures.some((f) => f.includes('crisis override'))).toBe(true);
  });

  it('does NOT require crisis override for 2022 and 2024 (more lenient)', async () => {
    // 2022: enough Risk-Off, no false Risk-On in core, no crisis override
    state.rows.push(
      ...fillWindow(
        utc(2022, 4, 1),
        utc(2022, 11, 30),
        (d) =>
          d.getTime() >= utc(2022, 9, 1).getTime() ? 'Risk-Off' : 'Caution',
      ),
    );
    const report = await runValidation();
    const hikes = report.windowResults.find((w) => w.windowName === '2022_HIKES');
    expect(hikes!.crisisOverrideFiredOnPeak).toBe(false);
    expect(hikes!.passed).toBe(true);
  });

  it('flags false Risk-On classifications inside the crisis core', async () => {
    // GFC core is 2008-09-15..2008-12-31. Plant one Risk-On day in the core.
    state.rows.push(
      ...fillWindow(
        utc(2008, 7, 1),
        utc(2008, 12, 31),
        (d) =>
          d.getTime() === utc(2008, 10, 6).getTime() // a Mon in the core
            ? 'Risk-On'
            : 'Risk-Off',
        [utc(2008, 9, 29)],
      ),
    );
    const report = await runValidation();
    const gfc = report.windowResults.find((w) => w.windowName === '2008_GFC');
    expect(gfc!.passed).toBe(false);
    expect(gfc!.falseRiskOnDates).toContain('2008-10-06');
    expect(gfc!.failures.some((f) => f.includes('false Risk-On'))).toBe(true);
  });

  it('does not flag Risk-On outside the crisis core', async () => {
    // 2008 core starts 2008-09-15. Plant Risk-On in July (before core) only.
    state.rows.push(
      ...fillWindow(
        utc(2008, 7, 1),
        utc(2008, 12, 31),
        (d) =>
          d.getTime() < utc(2008, 9, 15).getTime()
            ? 'Risk-On'
            : 'Risk-Off',
        [utc(2008, 9, 29)],
      ),
    );
    const report = await runValidation();
    const gfc = report.windowResults.find((w) => w.windowName === '2008_GFC');
    expect(gfc!.falseRiskOnDates).toHaveLength(0);
  });

  it('counts regime days correctly', async () => {
    state.rows.push(
      ...fillWindow(
        utc(2024, 6, 1),
        utc(2024, 9, 30),
        (d) => {
          const t = d.getTime();
          if (t === utc(2024, 8, 5).getTime()) return 'Risk-Off';
          if (t >= utc(2024, 7, 31).getTime() && t <= utc(2024, 8, 9).getTime())
            return 'Caution';
          return 'Risk-On';
        },
        [utc(2024, 8, 5)],
      ),
    );
    const report = await runValidation();
    const yen = report.windowResults.find((w) => w.windowName === '2024_YEN_UNWIND');
    expect(yen!.totalTradingDays).toBeGreaterThan(0);
    expect(yen!.riskOffDays + yen!.cautionDays + yen!.riskOnDays).toBe(
      yen!.totalTradingDays,
    );
  });

  it('overallPassed=true requires every window to pass', async () => {
    // Even with one passing window, others empty → overall fails
    state.rows.push(
      ...fillWindow(utc(2008, 7, 1), utc(2008, 12, 31), () => 'Risk-Off', [utc(2008, 9, 29)]),
    );
    const report = await runValidation();
    expect(report.overallPassed).toBe(false); // 2020, 2022, 2024 have no data
  });

  it('summary mentions failure count when not all pass', async () => {
    const report = await runValidation();
    expect(report.overallSummary).toMatch(/Failures/i);
  });
});

describe('getMostRecentReport', () => {
  beforeEach(() => {
    state.rows = [];
    state.reports = [];
    vi.clearAllMocks();
  });

  it('returns null when no reports exist', async () => {
    const report = await getMostRecentReport();
    expect(report).toBeNull();
  });

  it('returns the persisted report after a run', async () => {
    await runValidation();
    const report = await getMostRecentReport();
    expect(report).not.toBeNull();
    expect(report!.windowResults).toHaveLength(4);
  });
});
