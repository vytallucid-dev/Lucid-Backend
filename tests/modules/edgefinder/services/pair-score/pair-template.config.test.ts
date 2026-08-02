import { vi, describe, it, expect, beforeEach } from 'vitest';

/**
 * Phase 2: the template and the pair universe both come from the database.
 * The static PAIR_TEMPLATE / PAIR_DEFINITIONS arrays were removed, so these
 * tests drive the real loaders against a mocked Prisma.
 */
type TemplateRow = {
  displayName: string;
  uiGroup: string;
  treatment: string;
  rowOrder: number;
  isActive: boolean;
  currencies: Array<{ currencyCode: string; indicatorCode: string | null }>;
};

type PairAsset = {
  code: string;
  metadata: Record<string, unknown> | null;
};

const fixtures: { rows: TemplateRow[]; pairs: PairAsset[] } = { rows: [], pairs: [] };

vi.mock('@core/db/prisma', () => ({
  prisma: {
    pairTemplateRow: {
      findMany: vi.fn(async ({ where }: { where?: { isActive?: boolean } }) =>
        fixtures.rows
          .filter((r) => (where?.isActive === undefined ? true : r.isActive === where.isActive))
          .sort((a, b) => a.rowOrder - b.rowOrder),
      ),
    },
    asset: {
      findMany: vi.fn(async () => fixtures.pairs),
    },
  },
}));

import {
  dbRowToPairRowConfig,
  loadPairTemplateFromDb,
  loadPairDefinitions,
  getPairDefinition,
} from '@modules/edgefinder/services/pair-score/pair-template.config';

beforeEach(() => {
  fixtures.rows = [
    {
      displayName: 'GDP', uiGroup: 'Growth', treatment: 'BILATERAL', rowOrder: 1, isActive: true,
      currencies: [
        { currencyCode: 'AUD', indicatorCode: 'AU_GDP_QOQ' },
        { currencyCode: 'EUR', indicatorCode: 'EU_GDP_QOQ' },
        { currencyCode: 'GBP', indicatorCode: 'UK_GDP_MOM' },
        { currencyCode: 'JPY', indicatorCode: 'JP_GDP_QOQ' },
        { currencyCode: 'USD', indicatorCode: 'US_GDP_QOQ' },
      ],
    },
    {
      displayName: 'PCE', uiGroup: 'Inflation', treatment: 'USD_ONLY', rowOrder: 2, isActive: true,
      currencies: [{ currencyCode: 'USD', indicatorCode: 'US_PCE_YOY' }],
    },
    {
      displayName: 'Household Spending', uiGroup: 'Inflation', treatment: 'JPY_ONLY', rowOrder: 3, isActive: true,
      currencies: [{ currencyCode: 'JPY', indicatorCode: 'JP_HSHLD_SPEND' }],
    },
    {
      displayName: 'AU Employment Change', uiGroup: 'Jobs', treatment: 'AUD_ONLY', rowOrder: 4, isActive: true,
      currencies: [{ currencyCode: 'AUD', indicatorCode: 'AU_EMPLOYMENT_CHANGE' }],
    },
    {
      displayName: 'Parked Row', uiGroup: 'Growth', treatment: 'BILATERAL', rowOrder: 5, isActive: false,
      currencies: [{ currencyCode: 'USD', indicatorCode: 'US_SOMETHING' }],
    },
  ];
  fixtures.pairs = [
    { code: 'AUDJPY', metadata: { base: 'AUD', quote: 'JPY' } },
    { code: 'EURAUD', metadata: { base: 'EUR', quote: 'AUD' } },
    { code: 'EURUSD', metadata: { base: 'EUR', quote: 'USD' } },
  ];
});

describe('dbRowToPairRowConfig', () => {
  it('maps currencies from rows, not from four fixed columns', () => {
    const cfg = dbRowToPairRowConfig(fixtures.rows[0]);
    expect(cfg.indicators).toEqual({
      AUD: 'AU_GDP_QOQ',
      EUR: 'EU_GDP_QOQ',
      GBP: 'UK_GDP_MOM',
      JPY: 'JP_GDP_QOQ',
      USD: 'US_GDP_QOQ',
    });
  });

  it('supports a currency the code never names', () => {
    const cfg = dbRowToPairRowConfig({
      displayName: 'X', uiGroup: 'Growth', treatment: 'BILATERAL', rowOrder: 9, isActive: true,
      currencies: [{ currencyCode: 'NZD', indicatorCode: 'NZ_GDP' }],
    });
    expect(cfg.indicators.NZD).toBe('NZ_GDP');
    expect(cfg.requiresCurrency).toEqual(['NZD']);
  });

  it('derives requiresCurrency from the row’s own mapped currencies', () => {
    expect(dbRowToPairRowConfig(fixtures.rows[1]).requiresCurrency).toEqual(['USD']);
    expect(dbRowToPairRowConfig(fixtures.rows[2]).requiresCurrency).toEqual(['JPY']);
  });

  it('ignores null indicator codes', () => {
    const cfg = dbRowToPairRowConfig({
      displayName: 'X', uiGroup: 'Growth', treatment: 'BILATERAL', rowOrder: 9, isActive: true,
      currencies: [
        { currencyCode: 'USD', indicatorCode: 'US_X' },
        { currencyCode: 'AUD', indicatorCode: null },
      ],
    });
    expect(cfg.indicators).toEqual({ USD: 'US_X' });
    expect(cfg.requiresCurrency).toEqual(['USD']);
  });

  it('sets softExcludeWhenUnsupported only for the legacy USD_ONLY treatment', () => {
    expect(dbRowToPairRowConfig(fixtures.rows[1]).softExcludeWhenUnsupported).toBe(true);
    expect(dbRowToPairRowConfig(fixtures.rows[2]).softExcludeWhenUnsupported).toBe(false);
    expect(dbRowToPairRowConfig(fixtures.rows[3]).softExcludeWhenUnsupported).toBe(false);
    expect(dbRowToPairRowConfig(fixtures.rows[0]).softExcludeWhenUnsupported).toBe(false);
  });

  it('never marks a row inverted (PPI included)', () => {
    expect(dbRowToPairRowConfig(fixtures.rows[0]).inverted).toBeUndefined();
  });
});

describe('loadPairTemplateFromDb', () => {
  it('returns only active rows, ordered by rowOrder', async () => {
    const t = await loadPairTemplateFromDb();
    expect(t.map((r) => r.rowName)).toEqual([
      'GDP',
      'PCE',
      'Household Spending',
      'AU Employment Change',
    ]);
  });
});

describe('loadPairDefinitions', () => {
  it('derives the pair universe from the registry', async () => {
    const defs = await loadPairDefinitions();
    expect(defs).toEqual([
      { code: 'AUDJPY', base: 'AUD', quote: 'JPY', isCarryPair: false },
      { code: 'EURAUD', base: 'EUR', quote: 'AUD', isCarryPair: false },
      { code: 'EURUSD', base: 'EUR', quote: 'USD', isCarryPair: false },
    ]);
  });

  it('picks up a newly registered pair with no code change', async () => {
    fixtures.pairs.push({ code: 'GBPAUD', metadata: { base: 'GBP', quote: 'AUD' } });
    const defs = await loadPairDefinitions();
    expect(defs.map((d) => d.code)).toContain('GBPAUD');
  });

  it('throws rather than inferring base/quote by slicing the code', async () => {
    fixtures.pairs.push({ code: 'NZDUSD', metadata: {} });
    await expect(loadPairDefinitions()).rejects.toThrow(/missing base\/quote in metadata/);
  });

  it('throws when metadata is absent entirely', async () => {
    fixtures.pairs.push({ code: 'NZDUSD', metadata: null });
    await expect(loadPairDefinitions()).rejects.toThrow(/missing base\/quote in metadata/);
  });

  // Phase 5: isCarryPair is read from Asset.metadata.isCarryPair — the data
  // property Override 5 (Carry Unwind) now derives its eligibility from,
  // instead of a hand-maintained pair-code enumeration.
  it('reads isCarryPair: true from metadata when present', async () => {
    fixtures.pairs.push({ code: 'AUDJPY2', metadata: { base: 'AUD', quote: 'JPY', isCarryPair: true } });
    const defs = await loadPairDefinitions();
    expect(defs.find((d) => d.code === 'AUDJPY2')?.isCarryPair).toBe(true);
  });

  it('defaults isCarryPair to false when the metadata key is absent', async () => {
    const defs = await loadPairDefinitions();
    expect(defs.find((d) => d.code === 'EURUSD')?.isCarryPair).toBe(false);
  });
});

describe('getPairDefinition', () => {
  it('returns the matching pair', async () => {
    await expect(getPairDefinition('EURAUD')).resolves.toEqual({
      code: 'EURAUD',
      base: 'EUR',
      quote: 'AUD',
      isCarryPair: false,
    });
  });

  it('returns null for a code that is not a registered pair', async () => {
    await expect(getPairDefinition('XAUUSD')).resolves.toBeNull();
    await expect(getPairDefinition('NZDUSD')).resolves.toBeNull();
  });
});
