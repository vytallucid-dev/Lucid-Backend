import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@core/db/prisma', () => ({
  prisma: {
    calendarEvent: { findMany: vi.fn() },
    dataPoint: { findMany: vi.fn() },
  },
}));

vi.mock('@core/repositories/calendar-event-deferrals.repository', () => ({
  calendarEventDeferralsRepository: {
    findForIndicatorVariantPairs: vi.fn().mockResolvedValue([]),
  },
}));

import { prisma } from '@core/db/prisma';
import {
  findAllOverdue,
  findDueToday,
  findOverdueByIndicatorCodes,
  resolveOverdue,
} from '@modules/edgefinder/services/overdue-resolver';

const mockedCalendarFindMany = prisma.calendarEvent.findMany as unknown as ReturnType<typeof vi.fn>;
const mockedDataPointFindMany = prisma.dataPoint.findMany as unknown as ReturnType<typeof vi.fn>;

function makeEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'evt-1',
    source: 'forex_factory',
    country: 'USD',
    title: 'Test Event',
    scheduledAt: new Date('2026-08-03T12:30:00.000Z'),
    impact: 'High',
    forecastRaw: null,
    previousRaw: null,
    actualRaw: null,
    indicatorId: 'ind-1',
    indicatorCode: 'US_TEST',
    variant: null,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    fetchedVia: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findAllOverdue — Fix 1/3 shared existence join', () => {
  const NOW = new Date('2026-08-08T12:00:00.000Z'); // >24h past 2026-08-03

  it('flags an event overdue when no DataPoint matches on either UTC or IST date', async () => {
    mockedCalendarFindMany.mockResolvedValue([makeEvent()]);
    mockedDataPointFindMany.mockResolvedValue([]);

    const result = await findAllOverdue(NOW);
    expect(result).toHaveLength(1);
    expect(result[0].event.id).toBe('evt-1');
  });

  it('does NOT flag overdue when a DataPoint matches the UTC-truncated date', async () => {
    mockedCalendarFindMany.mockResolvedValue([makeEvent({ scheduledAt: new Date('2026-08-03T12:30:00.000Z'), variant: null })]);
    mockedDataPointFindMany.mockResolvedValue([
      { indicatorId: 'ind-1', variant: null, observationDate: new Date('2026-08-03T00:00:00.000Z') },
    ]);

    const result = await findAllOverdue(NOW);
    expect(result).toHaveLength(0);
  });

  // Fix 3 — the exact JP_HSHLD_SPEND scenario: scheduledAt 23:30 UTC is a
  // different calendar date in IST than in UTC. A DataPoint entered on the
  // IST date (what the trader actually saw) must satisfy the join.
  it('Fix 3: does NOT flag overdue when a DataPoint matches the IST-truncated date but not the UTC date', async () => {
    mockedCalendarFindMany.mockResolvedValue([
      makeEvent({
        id: 'evt-jp',
        indicatorCode: 'JP_HSHLD_SPEND',
        scheduledAt: new Date('2026-08-06T23:30:00.000Z'), // UTC date 08-06, IST date 08-07
        variant: null,
      }),
    ]);
    mockedDataPointFindMany.mockResolvedValue([
      // Entered on the IST date, not the UTC date.
      { indicatorId: 'ind-1', variant: null, observationDate: new Date('2026-08-07T00:00:00.000Z') },
    ]);

    const result = await findAllOverdue(NOW);
    expect(result).toHaveLength(0);
  });

  it('Fix 3: still flags overdue when NEITHER the UTC nor IST date has a match', async () => {
    mockedCalendarFindMany.mockResolvedValue([
      makeEvent({
        id: 'evt-jp',
        indicatorCode: 'JP_HSHLD_SPEND',
        scheduledAt: new Date('2026-08-06T23:30:00.000Z'),
        variant: null,
      }),
    ]);
    mockedDataPointFindMany.mockResolvedValue([
      // Wrong date entirely — neither 08-06 nor 08-07.
      { indicatorId: 'ind-1', variant: null, observationDate: new Date('2026-08-01T00:00:00.000Z') },
    ]);

    const result = await findAllOverdue(NOW);
    expect(result).toHaveLength(1);
  });

  it('does not flag overdue when variant matches but is on a genuinely different day', async () => {
    // Regression guard: widening the match to two dates must not become a
    // blanket "any date within a day or two" match — only exactly the UTC
    // and IST truncations of scheduledAt count.
    mockedCalendarFindMany.mockResolvedValue([
      makeEvent({ scheduledAt: new Date('2026-08-03T12:30:00.000Z'), variant: 'final' }),
    ]);
    mockedDataPointFindMany.mockResolvedValue([
      { indicatorId: 'ind-1', variant: 'final', observationDate: new Date('2026-08-05T00:00:00.000Z') },
    ]);

    const result = await findAllOverdue(NOW);
    expect(result).toHaveLength(1); // still overdue — the entered date doesn't match either truncation
  });

  it('respects the 24h grace window — a recent event is not yet overdue-eligible in the candidate query', async () => {
    // findAllOverdue's WHERE clause filters scheduledAt < now-24h; simulate
    // that by returning no candidates for a too-recent event (the real
    // Prisma query would exclude it — this proves the join itself doesn't
    // wrongly resurrect it).
    mockedCalendarFindMany.mockResolvedValue([]);
    mockedDataPointFindMany.mockResolvedValue([]);

    const result = await findAllOverdue(NOW);
    expect(result).toHaveLength(0);
    expect(mockedCalendarFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          scheduledAt: { lt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000) },
        }),
      }),
    );
  });
});

describe('findDueToday — Fix 1: shares the same join as findAllOverdue', () => {
  const NOW = new Date('2026-08-07T13:00:00.000Z');

  it('clears from due-today once a matching DataPoint exists (the US_NFP/US_UNEMP bug)', async () => {
    mockedCalendarFindMany.mockResolvedValue([
      makeEvent({ id: 'evt-nfp', indicatorCode: 'US_NFP', scheduledAt: new Date('2026-08-07T12:30:00.000Z'), variant: null }),
    ]);
    mockedDataPointFindMany.mockResolvedValue([
      { indicatorId: 'ind-1', variant: null, observationDate: new Date('2026-08-07T00:00:00.000Z') },
    ]);

    const result = await findDueToday(NOW);
    expect(result).toHaveLength(0);
  });

  it('stays in due-today when no matching DataPoint exists yet', async () => {
    mockedCalendarFindMany.mockResolvedValue([
      makeEvent({ id: 'evt-nfp', indicatorCode: 'US_NFP', scheduledAt: new Date('2026-08-07T12:30:00.000Z'), variant: null }),
    ]);
    mockedDataPointFindMany.mockResolvedValue([]);

    const result = await findDueToday(NOW);
    expect(result).toHaveLength(1);
  });

  it('queries calendar_events with the due-today window, not the overdue cutoff window', async () => {
    mockedCalendarFindMany.mockResolvedValue([]);
    mockedDataPointFindMany.mockResolvedValue([]);

    await findDueToday(NOW);

    const call = mockedCalendarFindMany.mock.calls[0][0];
    const dayStart = new Date(Date.UTC(2026, 7, 7));
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const overdueCutoff = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    expect(call.where.scheduledAt).toEqual({ gte: dayStart, lt: dayEnd, gt: overdueCutoff });
  });
});

describe('findOverdueByIndicatorCodes', () => {
  it('filters findAllOverdue results down to the requested codes', async () => {
    mockedCalendarFindMany.mockResolvedValue([
      makeEvent({ id: 'e1', indicatorCode: 'US_NFP' }),
      makeEvent({ id: 'e2', indicatorCode: 'US_UNEMP' }),
    ]);
    mockedDataPointFindMany.mockResolvedValue([]);

    const result = await findOverdueByIndicatorCodes(['US_NFP'], new Date('2026-08-08T12:00:00.000Z'));
    expect(result.size).toBe(1);
    expect(result.get('US_NFP')).toHaveLength(1);
    expect(result.has('US_UNEMP')).toBe(false);
  });

  it('returns an empty map for an empty code list, with no query at all', async () => {
    const result = await findOverdueByIndicatorCodes([], new Date());
    expect(result.size).toBe(0);
    expect(mockedCalendarFindMany).not.toHaveBeenCalled();
  });
});

describe('resolveOverdue — deferral precedence unaffected by the join widening', () => {
  it('still resolves a plain overdue event with no deferral to state=overdue', async () => {
    mockedCalendarFindMany.mockResolvedValue([makeEvent()]);
    mockedDataPointFindMany.mockResolvedValue([]);

    const result = await resolveOverdue(new Date('2026-08-08T12:00:00.000Z'));
    expect(result).toHaveLength(1);
    expect(result[0].state).toBe('overdue');
    expect(result[0].deferral).toBeNull();
  });
});
