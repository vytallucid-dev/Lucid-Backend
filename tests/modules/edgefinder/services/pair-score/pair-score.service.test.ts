import { vi, describe, it, expect, beforeEach } from 'vitest';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    asset: { findUnique: vi.fn() },
    cotData: { findFirst: vi.fn() },
    pairTemplateRow: { findMany: vi.fn() },
    edgefinderScorecard: { findFirst: vi.fn() },
  },
}));

vi.mock('@core/db/prisma', () => ({
  prisma: prismaMock,
}));

vi.mock('@core/scoring/engine', () => ({
  scoreIndicator: vi.fn(),
}));

vi.mock('@core/repositories/edgefinder-pair-scores.repository', () => ({
  edgefinderPairScoresRepository: {
    upsert: vi.fn(),
    getCurrent: vi.fn(),
  },
}));

vi.mock('@core/repositories/compass-classifications.repository', () => ({
  compassClassificationsRepository: {
    getRegimeAsOf: vi.fn(),
  },
}));

import { scoreIndicator } from '@core/scoring/engine';
import { edgefinderPairScoresRepository } from '@core/repositories/edgefinder-pair-scores.repository';
import { compassClassificationsRepository } from '@core/repositories/compass-classifications.repository';
import { assemblePairScore } from '@modules/edgefinder/services/pair-score/pair-score.service';

const mockedScore = scoreIndicator as unknown as ReturnType<typeof vi.fn>;
const mockedUpsert = edgefinderPairScoresRepository.upsert as unknown as ReturnType<typeof vi.fn>;
const mockedRegime =
  compassClassificationsRepository.getRegimeAsOf as unknown as ReturnType<typeof vi.fn>;

const DATE = new Date(Date.UTC(2026, 4, 19));

// Mirrors the 15 active rows seeded into pair_template_rows (PPI is BILATERAL — no EUR inversion).
const MOCK_TEMPLATE_ROWS = [
  { displayName: 'GDP', uiGroup: 'Growth', treatment: 'BILATERAL', rowOrder: 1, isActive: true, usIndicatorCode: 'US_GDP_QOQ', eurIndicatorCode: 'EU_GDP_QOQ', gbpIndicatorCode: 'UK_GDP_MOM', jpyIndicatorCode: 'JP_GDP_QOQ' },
  { displayName: 'Manufacturing PMI', uiGroup: 'Growth', treatment: 'BILATERAL', rowOrder: 2, isActive: true, usIndicatorCode: 'US_ISM_MFG', eurIndicatorCode: 'EU_MFG_PMI', gbpIndicatorCode: 'UK_MFG_PMI', jpyIndicatorCode: 'JP_MFG_PMI' },
  { displayName: 'Services PMI', uiGroup: 'Growth', treatment: 'BILATERAL', rowOrder: 3, isActive: true, usIndicatorCode: 'US_ISM_SVC', eurIndicatorCode: 'EU_SVC_PMI', gbpIndicatorCode: 'UK_SVC_PMI', jpyIndicatorCode: 'JP_SVC_PMI' },
  { displayName: 'Retail Sales', uiGroup: 'Growth', treatment: 'BILATERAL', rowOrder: 4, isActive: true, usIndicatorCode: 'US_RETAIL_MOM', eurIndicatorCode: 'EU_RETAIL_MOM', gbpIndicatorCode: 'UK_RETAIL_MOM', jpyIndicatorCode: 'JP_RETAIL_YOY' },
  { displayName: 'Consumer Confidence', uiGroup: 'Sentiment', treatment: 'BILATERAL', rowOrder: 5, isActive: true, usIndicatorCode: 'US_CB_CONSCONF', eurIndicatorCode: 'EU_CCI', gbpIndicatorCode: 'UK_GFK', jpyIndicatorCode: 'JP_CONSCONF' },
  { displayName: 'CPI', uiGroup: 'Inflation', treatment: 'BILATERAL', rowOrder: 6, isActive: true, usIndicatorCode: 'US_CPI_YOY', eurIndicatorCode: 'EU_CPI_YOY', gbpIndicatorCode: 'UK_CPI_YOY', jpyIndicatorCode: 'JP_CPI_YOY' },
  { displayName: 'PPI', uiGroup: 'Inflation', treatment: 'BILATERAL', rowOrder: 7, isActive: true, usIndicatorCode: 'US_PPI_MOM', eurIndicatorCode: 'EU_PPI_MOM', gbpIndicatorCode: 'UK_PPI_MOM', jpyIndicatorCode: 'JP_PPI_YOY' },
  { displayName: 'PCE', uiGroup: 'Inflation', treatment: 'USD_ONLY', rowOrder: 8, isActive: true, usIndicatorCode: 'US_PCE_YOY', eurIndicatorCode: null, gbpIndicatorCode: null, jpyIndicatorCode: null },
  { displayName: 'Household Spending', uiGroup: 'Inflation', treatment: 'JPY_ONLY', rowOrder: 9, isActive: true, usIndicatorCode: null, eurIndicatorCode: null, gbpIndicatorCode: null, jpyIndicatorCode: 'JP_HSHLD_SPEND' },
  { displayName: 'NFP / Employment', uiGroup: 'Jobs', treatment: 'USD_ONLY', rowOrder: 10, isActive: true, usIndicatorCode: 'US_NFP', eurIndicatorCode: null, gbpIndicatorCode: null, jpyIndicatorCode: null },
  { displayName: 'Unemployment', uiGroup: 'Jobs', treatment: 'BILATERAL', rowOrder: 11, isActive: true, usIndicatorCode: 'US_UNEMP', eurIndicatorCode: 'EU_UNEMP', gbpIndicatorCode: 'UK_UNEMP', jpyIndicatorCode: 'JP_UNEMP' },
  { displayName: 'Jobless Claims', uiGroup: 'Jobs', treatment: 'USD_ONLY', rowOrder: 12, isActive: true, usIndicatorCode: 'US_JOBLESS_CLAIMS', eurIndicatorCode: null, gbpIndicatorCode: null, jpyIndicatorCode: null },
  { displayName: 'JOLTS', uiGroup: 'Jobs', treatment: 'USD_ONLY', rowOrder: 13, isActive: true, usIndicatorCode: 'US_JOLTS', eurIndicatorCode: null, gbpIndicatorCode: null, jpyIndicatorCode: null },
  { displayName: 'ADP', uiGroup: 'Jobs', treatment: 'USD_ONLY', rowOrder: 14, isActive: true, usIndicatorCode: 'US_ADP', eurIndicatorCode: null, gbpIndicatorCode: null, jpyIndicatorCode: null },
  { displayName: 'Interest Rate', uiGroup: 'Rates', treatment: 'RATES_BILATERAL', rowOrder: 15, isActive: true, usIndicatorCode: 'US_FED_RATE', eurIndicatorCode: 'EU_ECB_RATE', gbpIndicatorCode: 'UK_BOE_RATE', jpyIndicatorCode: 'JP_BOJ_RATE' },
];

function scored(score: number, direction: string | null = null) {
  return {
    kind: 'scored' as const,
    score,
    flags: [],
    metadata: direction ? { direction } : {},
  };
}

function insufficient(reason: string) {
  return { kind: 'insufficient_data' as const, reason, details: {} };
}

interface FakeAsset {
  id: string;
  code: string;
  metadata: Record<string, unknown>;
}

const ASSETS: Record<string, FakeAsset> = {
  USD: { id: 'a-usd', code: 'USD', metadata: { cotContractCode: '098662', cotTraderCategory: 'Non-Commercials' } },
  EUR: { id: 'a-eur', code: 'EUR', metadata: { cotContractCode: '099741', cotTraderCategory: 'Non-Commercials' } },
  GBP: { id: 'a-gbp', code: 'GBP', metadata: { cotContractCode: '096742', cotTraderCategory: 'Non-Commercials' } },
  JPY: { id: 'a-jpy', code: 'JPY', metadata: { cotContractCode: '097741', cotTraderCategory: 'Non-Commercials' } },
  EURUSD: { id: 'a-eurusd', code: 'EURUSD', metadata: {} },
  GBPUSD: { id: 'a-gbpusd', code: 'GBPUSD', metadata: {} },
  USDJPY: { id: 'a-usdjpy', code: 'USDJPY', metadata: {} },
  EURJPY: { id: 'a-eurjpy', code: 'EURJPY', metadata: {} },
  GBPJPY: { id: 'a-gbpjpy', code: 'GBPJPY', metadata: {} },
};

interface CotRow {
  contractCode: string;
  weeklyChangePct: number;
  reportDate: Date;
}

const cotRows: CotRow[] = [];

function setupScoreMap(byCode: Record<string, number | 'missing'>): void {
  mockedScore.mockImplementation(async ({ indicatorCode }: { indicatorCode: string }) => {
    const v = byCode[indicatorCode];
    if (v === undefined) {
      // Default any unspecified indicator to 0 (Met). Keeps tests focused on the
      // rows under test rather than enumerating every code.
      return scored(0, 'MET');
    }
    if (v === 'missing') return insufficient(`no data for ${indicatorCode}`);
    const direction = v > 0 ? 'BEAT' : v < 0 ? 'MISS' : 'MET';
    return scored(v, direction);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  cotRows.length = 0;
  mockedUpsert.mockResolvedValue({ pairScoreId: 'ps-1', action: 'inserted' });
  mockedRegime.mockResolvedValue({
    classificationDate: DATE,
    activeRegime: 'Caution',
    candidateRegime: 'Caution',
    persistenceDaysCount: 0,
  });
  prismaMock.asset.findUnique.mockImplementation(
    async ({ where }: { where: { code: string } }) => ASSETS[where.code] ?? null,
  );
  prismaMock.cotData.findFirst.mockImplementation(
    async ({ where }: { where: { contractCode: string } }) => {
      const candidates = cotRows.filter((r) => r.contractCode === where.contractCode);
      if (candidates.length === 0) return null;
      return {
        ...candidates[0],
        weeklyChangePct: candidates[0].weeklyChangePct,
      };
    },
  );
  prismaMock.pairTemplateRow.findMany.mockResolvedValue(MOCK_TEMPLATE_ROWS);
  prismaMock.edgefinderScorecard.findFirst.mockResolvedValue(null);
  setupScoreMap({});
});

describe('assemblePairScore — pair definition lookup', () => {
  it('throws on unknown pair code', async () => {
    await expect(assemblePairScore('AUDUSD', DATE)).rejects.toThrow(/Unknown pair code/);
  });
});

describe('assemblePairScore — EURUSD bilateral assembly', () => {
  it('all indicators MET (0) → base score 0, no COT data → pairCot 0', async () => {
    setupScoreMap({});
    const r = await assemblePairScore('EURUSD', DATE);
    expect(r.basePairScore).toBe(0);
    expect(r.pairCotScore).toBe(0);
    expect(r.totalScore).toBe(0);
    expect(r.ratingLabel).toBe('Neutral');
    expect(r.regime).toBe('Caution');
  });

  it('EUR GDP -1 vs USD GDP +1 contributes -2 to base score', async () => {
    setupScoreMap({ EU_GDP_QOQ: -1, US_GDP_QOQ: 1 });
    const r = await assemblePairScore('EURUSD', DATE);
    expect(r.basePairScore).toBe(-2);
  });

  it('PPI bilateral (no inversion): EUR PPI +1 vs USD PPI +1 → pair score 0', async () => {
    setupScoreMap({ EU_PPI_MOM: 1, US_PPI_MOM: 1 });
    const r = await assemblePairScore('EURUSD', DATE);
    expect(r.basePairScore).toBe(0);
  });
});

describe('assemblePairScore — template row counts', () => {
  it('EURUSD: 14 applicable rows (HSpend excluded, no JPY)', async () => {
    setupScoreMap({});
    const r = await assemblePairScore('EURUSD', DATE);
    expect(r.rowCount).toBe(14);
  });

  it('GBPUSD: 14 applicable rows (HSpend excluded; PPI present but forced 0)', async () => {
    setupScoreMap({});
    const r = await assemblePairScore('GBPUSD', DATE);
    expect(r.rowCount).toBe(14);
  });

  it('USDJPY: 15 applicable rows (HSpend present; PPI present but forced 0)', async () => {
    setupScoreMap({});
    const r = await assemblePairScore('USDJPY', DATE);
    expect(r.rowCount).toBe(15);
  });

  it('EURJPY: 15 applicable rows (USD-only rows present but forced 0; PPI scores normally)', async () => {
    setupScoreMap({});
    const r = await assemblePairScore('EURJPY', DATE);
    expect(r.rowCount).toBe(15);
  });

  it('GBPJPY: 15 applicable rows (USD-only rows + PPI all present, forced 0)', async () => {
    setupScoreMap({});
    const r = await assemblePairScore('GBPJPY', DATE);
    expect(r.rowCount).toBe(15);
  });

  it('rowsScored counts only rows with non-zero pairScore', async () => {
    setupScoreMap({ EU_GDP_QOQ: -1, US_GDP_QOQ: 1 }); // only GDP nonzero
    const r = await assemblePairScore('EURUSD', DATE);
    expect(r.rowCount).toBe(14);
    expect(r.rowsScored).toBe(1);
  });

  it('rowsScored = 0 when all rows score 0', async () => {
    setupScoreMap({});
    const r = await assemblePairScore('GBPJPY', DATE);
    expect(r.rowsScored).toBe(0);
  });
});

describe('assemblePairScore — pair COT scoring', () => {
  it('returns pairCotScore 0 when either side missing COT data', async () => {
    setupScoreMap({});
    cotRows.push({ contractCode: '099741', weeklyChangePct: 2.0, reportDate: DATE });
    const r = await assemblePairScore('EURUSD', DATE);
    expect(r.pairCotScore).toBe(0);
  });

  it('combines Bullish A vs Bearish B = +2 (EUR strong vs USD weakening)', async () => {
    setupScoreMap({});
    cotRows.push(
      { contractCode: '099741', weeklyChangePct: 2.0, reportDate: DATE }, // EUR Bullish
      { contractCode: '098662', weeklyChangePct: -2.0, reportDate: DATE }, // USD Bearish
    );
    const r = await assemblePairScore('EURUSD', DATE);
    expect(r.pairCotScore).toBe(2);
  });

  it('Neutral A vs Bullish B = -1', async () => {
    setupScoreMap({});
    cotRows.push(
      { contractCode: '099741', weeklyChangePct: 0.1, reportDate: DATE }, // EUR Neutral
      { contractCode: '098662', weeklyChangePct: 2.0, reportDate: DATE }, // USD Bullish
    );
    const r = await assemblePairScore('EURUSD', DATE);
    expect(r.pairCotScore).toBe(-1);
  });
});

describe('assemblePairScore — Compass Override 5', () => {
  it('Risk-Off + EURJPY → -1 compass adjustment applied to total', async () => {
    setupScoreMap({});
    mockedRegime.mockResolvedValue({
      classificationDate: DATE,
      activeRegime: 'Risk-Off',
      candidateRegime: 'Risk-Off',
      persistenceDaysCount: 1,
    });
    const r = await assemblePairScore('EURJPY', DATE);
    expect(r.compassAdjustment).toBe(-1);
    expect(r.totalScore).toBe(r.baseTotal - 1);
    expect(r.regime).toBe('Risk-Off');
  });

  it('Risk-Off + GBPJPY → -1 compass adjustment', async () => {
    setupScoreMap({});
    mockedRegime.mockResolvedValue({
      classificationDate: DATE,
      activeRegime: 'Risk-Off',
      candidateRegime: 'Risk-Off',
      persistenceDaysCount: 1,
    });
    const r = await assemblePairScore('GBPJPY', DATE);
    expect(r.compassAdjustment).toBe(-1);
  });

  it('Risk-Off + USDJPY → no adjustment (override 5 excludes USDJPY)', async () => {
    setupScoreMap({});
    mockedRegime.mockResolvedValue({
      classificationDate: DATE,
      activeRegime: 'Risk-Off',
      candidateRegime: 'Risk-Off',
      persistenceDaysCount: 1,
    });
    const r = await assemblePairScore('USDJPY', DATE);
    expect(r.compassAdjustment).toBe(0);
  });

  it('Risk-Off + EURUSD → no adjustment (no JPY in pair)', async () => {
    setupScoreMap({});
    mockedRegime.mockResolvedValue({
      classificationDate: DATE,
      activeRegime: 'Risk-Off',
      candidateRegime: 'Risk-Off',
      persistenceDaysCount: 1,
    });
    const r = await assemblePairScore('EURUSD', DATE);
    expect(r.compassAdjustment).toBe(0);
  });

  it('No regime classification → defaults to Caution (no override)', async () => {
    setupScoreMap({});
    mockedRegime.mockResolvedValue(null);
    const r = await assemblePairScore('EURJPY', DATE);
    expect(r.regime).toBe('Caution');
    expect(r.compassAdjustment).toBe(0);
  });
});

describe('assemblePairScore — persistence', () => {
  it('returns inserted action and pairScoreId from repository', async () => {
    setupScoreMap({});
    mockedUpsert.mockResolvedValue({ pairScoreId: 'ps-42', action: 'inserted' });
    const r = await assemblePairScore('EURUSD', DATE);
    expect(r.action).toBe('inserted');
    expect(r.pairScoreId).toBe('ps-42');
  });

  it('returns skipped action when repository skips', async () => {
    setupScoreMap({});
    mockedUpsert.mockResolvedValue({ pairScoreId: 'ps-7', action: 'skipped' });
    const r = await assemblePairScore('EURUSD', DATE);
    expect(r.action).toBe('skipped');
  });

  it('upserts with rowBreakdown including ALL 15 template rows; HSpend excluded, PPI force-zero', async () => {
    setupScoreMap({});
    await assemblePairScore('GBPUSD', DATE);
    const callArgs = mockedUpsert.mock.calls[0][0];
    const rows = callArgs.rowBreakdown as Array<{
      rowName: string;
      rowIncluded: boolean;
      pairScore: number;
    }>;
    // 15 template rows + 1 COT row appended by buildCotPairRow.
    expect(rows).toHaveLength(16);
    const ppi = rows.find((r) => r.rowName === 'PPI');
    expect(ppi?.rowIncluded).toBe(true); // PPI stays in template in GBPUSD
    expect(ppi?.pairScore).toBe(0); // forced 0 since no EUR
    const hs = rows.find((r) => r.rowName === 'Household Spending');
    expect(hs?.rowIncluded).toBe(false); // HSpend removed from non-JPY templates
  });
});

describe('assemblePairScore — Spec v1 §7.4 EURUSD example', () => {
  it('reproduces the expected sign and approximate magnitude for a bearish-EUR scenario', async () => {
    // Synthetic: EU all -1, US all +1 → every bilateral row contributes -2.
    // 8 bilateral rows in EURUSD: GDP, Mfg, Svc, Retail, ConsConf, CPI, Unemp, Rates → -16.
    // PPI: EUR +1 inverted to -1, USD -1 → (-1) - (-1) = 0 (we set EUR PPI +1, USD PPI -1 here).
    // USD-only rows: PCE, NFP, Jobless, JOLTS, ADP each at +1 → EUR side absent (0), pair = -1 each → -5.
    // Household Spending excluded (no JPY).
    setupScoreMap({
      EU_GDP_QOQ: -1,
      US_GDP_QOQ: 1,
      EU_MFG_PMI: -1,
      US_ISM_MFG: 1,
      EU_SVC_PMI: -1,
      US_ISM_SVC: 1,
      EU_RETAIL_MOM: -1,
      US_RETAIL_MOM: 1,
      EU_CCI: -1,
      US_CB_CONSCONF: 1,
      EU_CPI_YOY: -1,
      US_CPI_YOY: 1,
      EU_PPI_MOM: 1, // inverted to -1
      US_PPI_MOM: -1,
      EU_UNEMP: -1,
      US_UNEMP: 1,
      EU_ECB_RATE: -1,
      US_FED_RATE: 1,
      US_PCE_YOY: 1,
      US_NFP: 1,
      US_JOBLESS_CLAIMS: 1,
      US_JOLTS: 1,
      US_ADP: 1,
    });
    const r = await assemblePairScore('EURUSD', DATE);
    // 8 bilateral × -2 = -16, PPI 0, USD-only × -1 × 5 = -5 → -21. Pair COT 0.
    expect(r.basePairScore).toBeLessThanOrEqual(-15);
    expect(r.totalScore).toBe(r.basePairScore + r.pairCotScore + r.compassAdjustment);
    expect(r.ratingLabel).toBe('Very Weak');
  });
});
