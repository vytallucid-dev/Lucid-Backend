import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@core/db/prisma', () => ({
  prisma: {
    calendarEvent: {
      findFirst: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
  },
}));

import { prisma } from '@core/db/prisma';
import { calendarEventsRepository } from '@core/repositories/calendar-events.repository';

const mockedFindFirst = prisma.calendarEvent.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockedUpdate = prisma.calendarEvent.update as unknown as ReturnType<typeof vi.fn>;
const mockedCreate = prisma.calendarEvent.create as unknown as ReturnType<typeof vi.fn>;

function baseParams(overrides: Partial<Parameters<typeof calendarEventsRepository.upsert>[0]> = {}) {
  return {
    source: 'forex_factory',
    country: 'USD',
    title: 'ADP Weekly Employment Change',
    scheduledAt: new Date('2026-08-11T12:16:00.000Z'),
    impact: 'Low',
    forecastRaw: null,
    previousRaw: '15.0K',
    actualRaw: null,
    indicatorId: 'ind-adp',
    indicatorCode: 'US_ADP',
    variant: null,
    isPrimary: true,
    fetchedVia: 'log-1',
    ...overrides,
  };
}

function storedRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'row-1',
    source: 'forex_factory',
    country: 'USD',
    title: 'ADP Weekly Employment Change',
    scheduledAt: new Date('2026-08-11T12:15:00.000Z'),
    impact: 'Low',
    forecastRaw: null,
    previousRaw: null,
    actualRaw: null,
    indicatorId: 'ind-adp',
    indicatorCode: 'US_ADP',
    variant: null,
    isPrimary: true,
    fetchedVia: 'log-0',
    firstSeenAt: new Date('2026-08-09T15:30:00.000Z'),
    lastSeenAt: new Date('2026-08-09T15:30:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('calendarEventsRepository.upsert — exact-key match (pre-existing contract, unchanged)', () => {
  it('does a full unconditional refresh on an exact scheduledAt match, regardless of populated fields', async () => {
    const existing = storedRow({
      scheduledAt: new Date('2026-08-11T12:16:00.000Z'), // exact match
      previousRaw: '10.0K', // existing HAS populated fields
    });
    mockedFindFirst.mockResolvedValue(existing);
    mockedUpdate.mockResolvedValue({ ...existing, previousRaw: '15.0K' });

    // Incoming ALSO has populated fields, but that's irrelevant for an exact
    // match — this must not go through the near-duplicate merge gate at all.
    await calendarEventsRepository.upsert(baseParams({ previousRaw: '15.0K' }));

    expect(mockedUpdate).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: expect.objectContaining({ previousRaw: '15.0K' }), // incoming wins unconditionally
    });
  });

  it('exact match still refreshes even when incoming has NO populated fields (actual publishing later can null out other fields legitimately)', async () => {
    const existing = storedRow({
      scheduledAt: new Date('2026-08-11T12:16:00.000Z'),
      previousRaw: '15.0K',
    });
    mockedFindFirst.mockResolvedValue(existing);
    mockedUpdate.mockResolvedValue(existing);

    await calendarEventsRepository.upsert(
      baseParams({ scheduledAt: new Date('2026-08-11T12:16:00.000Z'), previousRaw: null, forecastRaw: null }),
    );

    // Exact match: unconditional refresh — the populated-fields merge gate
    // must NEVER apply here, only to genuine near-duplicate merges below.
    expect(mockedUpdate).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: expect.objectContaining({ previousRaw: null, forecastRaw: null }),
    });
  });
});

describe('calendarEventsRepository.upsert — cross-fetch near-duplicate merge (Fix 2)', () => {
  it('placeholder stored first, real row arrives in a LATER fetch: incoming wins, scheduledAt moves to the incoming (real) instant', async () => {
    const placeholder = storedRow({
      scheduledAt: new Date('2026-08-11T12:15:00.000Z'),
      previousRaw: null,
      forecastRaw: null,
    });
    mockedFindFirst.mockResolvedValue(placeholder);
    mockedUpdate.mockResolvedValue({ ...placeholder, scheduledAt: new Date('2026-08-11T12:16:00.000Z') });

    const result = await calendarEventsRepository.upsert(
      baseParams({ scheduledAt: new Date('2026-08-11T12:16:00.000Z'), previousRaw: '15.0K' }),
    );

    expect(mockedFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          source: 'forex_factory',
          country: 'USD',
          title: 'ADP Weekly Employment Change',
          scheduledAt: {
            gte: new Date('2026-08-11T12:11:00.000Z'), // -5min
            lte: new Date('2026-08-11T12:21:00.000Z'), // +5min
          },
        }),
      }),
    );
    expect(mockedUpdate).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: expect.objectContaining({
        previousRaw: '15.0K',
        scheduledAt: new Date('2026-08-11T12:16:00.000Z'), // incoming (real) instant wins
      }),
    });
    expect(result.action).toBe('updated');
  });

  it('real row already stored, a later fetch re-sends the placeholder shape: existing wins, nothing churns', async () => {
    const real = storedRow({
      scheduledAt: new Date('2026-08-11T12:16:00.000Z'),
      previousRaw: '15.0K',
    });
    mockedFindFirst.mockResolvedValue(real);
    mockedUpdate.mockResolvedValue(real);

    await calendarEventsRepository.upsert(
      baseParams({
        scheduledAt: new Date('2026-08-11T12:15:00.000Z'), // placeholder's own instant
        previousRaw: null,
        forecastRaw: null,
      }),
    );

    expect(mockedUpdate).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: expect.objectContaining({
        previousRaw: '15.0K', // existing (real) data preserved
        scheduledAt: new Date('2026-08-11T12:16:00.000Z'), // existing instant preserved, NOT overwritten by placeholder
      }),
    });
  });

  it('neither row has populated fields: existing is left unchanged, no churn', async () => {
    const existing = storedRow({
      scheduledAt: new Date('2026-08-10T19:00:00.000Z'),
      previousRaw: null,
      forecastRaw: null,
      title: 'FOMC Member Hammack Speaks',
    });
    mockedFindFirst.mockResolvedValue(existing);
    mockedUpdate.mockResolvedValue(existing);

    await calendarEventsRepository.upsert(
      baseParams({
        title: 'FOMC Member Hammack Speaks',
        scheduledAt: new Date('2026-08-10T19:01:00.000Z'),
        previousRaw: null,
        forecastRaw: null,
      }),
    );

    expect(mockedUpdate).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: expect.objectContaining({
        scheduledAt: new Date('2026-08-10T19:00:00.000Z'), // unchanged
      }),
    });
  });

  it('a genuine reschedule (hours apart) falls OUTSIDE the window and inserts as a new row', async () => {
    // findFirst with the widened window returns null — a 6-hour-later event
    // is outside +/-5min of itself, so no existing row is found for it.
    mockedFindFirst.mockResolvedValue(null);
    mockedCreate.mockResolvedValue(storedRow({ scheduledAt: new Date('2026-08-12T14:30:00.000Z') }));

    const result = await calendarEventsRepository.upsert(
      baseParams({ title: 'Core CPI m/m', scheduledAt: new Date('2026-08-12T14:30:00.000Z') }),
    );

    expect(mockedCreate).toHaveBeenCalled();
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(result.action).toBe('inserted');
  });

  it('AU_RBA_RATE companion pair: different titles at the identical instant never collide in the lookup', async () => {
    // "Cash Rate" upsert — findFirst is scoped to title: "Cash Rate", so a
    // stored "RBA Rate Statement" row at the same instant must never match.
    mockedFindFirst.mockResolvedValue(null);
    mockedCreate.mockResolvedValue(storedRow({ title: 'Cash Rate' }));

    await calendarEventsRepository.upsert(
      baseParams({
        title: 'Cash Rate',
        country: 'AUD',
        indicatorCode: 'AU_RBA_RATE',
        scheduledAt: new Date('2026-08-11T04:30:00.000Z'),
      }),
    );

    expect(mockedFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ title: 'Cash Rate' }) }),
    );
    expect(mockedCreate).toHaveBeenCalled();
  });
});

describe('calendarEventsRepository.upsert — insert path', () => {
  it('creates a new row with isPrimary when no existing row is found in the window', async () => {
    mockedFindFirst.mockResolvedValue(null);
    mockedCreate.mockResolvedValue(storedRow());

    const result = await calendarEventsRepository.upsert(baseParams({ isPrimary: false }));

    expect(mockedCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ isPrimary: false }),
    });
    expect(result.action).toBe('inserted');
  });
});
