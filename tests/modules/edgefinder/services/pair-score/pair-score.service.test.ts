import { vi, describe, it, expect, beforeEach } from 'vitest';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    // Phase 2: loadPairDefinitions() derives the pair universe from the
    // registry, so asset.findMany is now part of the pair-scoring path.
    asset: { findUnique: vi.fn(), findMany: vi.fn() },
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
    getRegimeGateAsOf: vi.fn(),
  },
}));

import { scoreIndicator } from '@core/scoring/engine';
import { edgefinderPairScoresRepository } from '@core/repositories/edgefinder-pair-scores.repository';
import { compassClassificationsRepository } from '@core/repositories/compass-classifications.repository';
import { assemblePairScore } from '@modules/edgefinder/services/pair-score/pair-score.service';

const mockedScore = scoreIndicator as unknown as ReturnType<typeof vi.fn>;
const mockedUpsert = edgefinderPairScoresRepository.upsert as unknown as ReturnType<typeof vi.fn>;
const mockedRegime =
  compassClassificationsRepository.getRegimeGateAsOf as unknown as ReturnType<typeof vi.fn>;

const DATE = new Date(Date.UTC(2026, 4, 19));

/**
 * Phase 6 gate snapshot from a plain regime — finalRegime == regime, no
 * shocks, 8A rate gate PERMITS Override 5 (not hawkish). So a Risk-Off regime
 * fires Override 5 exactly as pre-Phase-6, letting these tests assert the
 * unchanged −1 carry-unwind adjustment. Gate-specific behaviour is covered in
 * pair-compass-overrides.test.ts and compass-override-gates.test.ts.
 */
function gateSnapshot(regime: 'Risk-On' | 'Caution' | 'Risk-Off') {
  return {
    classificationDate: DATE,
    activeRegime: regime,
    finalRegime: regime,
    shockAActive: false,
    shockBActive: false,
    rateGateHawkish: false,
    override3SuppressedByGate: false,
    override5SuppressedByGate: false,
    fedConstraint: 'CONSTRAINED',
    override2SuppressedByConstraint: false,
  };
}

// Mirrors the 15 active rows seeded into pair_template_rows (PPI is BILATERAL — no EUR inversion).
// Mirrors the seeded pair_template_rows + pair_template_row_currencies (Phase 2:
// currency is a ROW, not one of four columns). PPI is BILATERAL — no EUR inversion.
const MOCK_TEMPLATE_ROWS = [
  { displayName: 'GDP', uiGroup: 'Growth', treatment: 'BILATERAL', rowOrder: 1, isActive: true,
    currencies: [{ currencyCode: 'EUR', indicatorCode: 'EU_GDP_QOQ' }, { currencyCode: 'GBP', indicatorCode: 'UK_GDP_MOM' }, { currencyCode: 'JPY', indicatorCode: 'JP_GDP_QOQ' }, { currencyCode: 'USD', indicatorCode: 'US_GDP_QOQ' }] },
  { displayName: 'Manufacturing PMI', uiGroup: 'Growth', treatment: 'BILATERAL', rowOrder: 2, isActive: true,
    currencies: [{ currencyCode: 'EUR', indicatorCode: 'EU_MFG_PMI' }, { currencyCode: 'GBP', indicatorCode: 'UK_MFG_PMI' }, { currencyCode: 'JPY', indicatorCode: 'JP_MFG_PMI' }, { currencyCode: 'USD', indicatorCode: 'US_ISM_MFG' }] },
  { displayName: 'Services PMI', uiGroup: 'Growth', treatment: 'BILATERAL', rowOrder: 3, isActive: true,
    currencies: [{ currencyCode: 'EUR', indicatorCode: 'EU_SVC_PMI' }, { currencyCode: 'GBP', indicatorCode: 'UK_SVC_PMI' }, { currencyCode: 'JPY', indicatorCode: 'JP_SVC_PMI' }, { currencyCode: 'USD', indicatorCode: 'US_ISM_SVC' }] },
  { displayName: 'Retail Sales', uiGroup: 'Growth', treatment: 'BILATERAL', rowOrder: 4, isActive: true,
    currencies: [{ currencyCode: 'EUR', indicatorCode: 'EU_RETAIL_MOM' }, { currencyCode: 'GBP', indicatorCode: 'UK_RETAIL_MOM' }, { currencyCode: 'JPY', indicatorCode: 'JP_RETAIL_YOY' }, { currencyCode: 'USD', indicatorCode: 'US_RETAIL_MOM' }] },
  { displayName: 'Consumer Confidence', uiGroup: 'Sentiment', treatment: 'BILATERAL', rowOrder: 5, isActive: true,
    currencies: [{ currencyCode: 'EUR', indicatorCode: 'EU_CCI' }, { currencyCode: 'GBP', indicatorCode: 'UK_GFK' }, { currencyCode: 'JPY', indicatorCode: 'JP_CONSCONF' }, { currencyCode: 'USD', indicatorCode: 'US_CB_CONSCONF' }] },
  { displayName: 'CPI', uiGroup: 'Inflation', treatment: 'BILATERAL', rowOrder: 6, isActive: true,
    currencies: [{ currencyCode: 'EUR', indicatorCode: 'EU_CPI_YOY' }, { currencyCode: 'GBP', indicatorCode: 'UK_CPI_YOY' }, { currencyCode: 'JPY', indicatorCode: 'JP_CPI_YOY' }, { currencyCode: 'USD', indicatorCode: 'US_CPI_YOY' }] },
  { displayName: 'PPI', uiGroup: 'Inflation', treatment: 'BILATERAL', rowOrder: 7, isActive: true,
    currencies: [{ currencyCode: 'EUR', indicatorCode: 'EU_PPI_MOM' }, { currencyCode: 'GBP', indicatorCode: 'UK_PPI_MOM' }, { currencyCode: 'JPY', indicatorCode: 'JP_PPI_YOY' }, { currencyCode: 'USD', indicatorCode: 'US_PPI_MOM' }] },
  { displayName: 'PCE', uiGroup: 'Inflation', treatment: 'USD_ONLY', rowOrder: 8, isActive: true,
    currencies: [{ currencyCode: 'USD', indicatorCode: 'US_PCE_YOY' }] },
  { displayName: 'Household Spending', uiGroup: 'Inflation', treatment: 'JPY_ONLY', rowOrder: 9, isActive: true,
    currencies: [{ currencyCode: 'JPY', indicatorCode: 'JP_HSHLD_SPEND' }] },
  { displayName: 'NFP / Employment', uiGroup: 'Jobs', treatment: 'USD_ONLY', rowOrder: 10, isActive: true,
    currencies: [{ currencyCode: 'USD', indicatorCode: 'US_NFP' }] },
  { displayName: 'Unemployment', uiGroup: 'Jobs', treatment: 'BILATERAL', rowOrder: 11, isActive: true,
    currencies: [{ currencyCode: 'EUR', indicatorCode: 'EU_UNEMP' }, { currencyCode: 'GBP', indicatorCode: 'UK_UNEMP' }, { currencyCode: 'JPY', indicatorCode: 'JP_UNEMP' }, { currencyCode: 'USD', indicatorCode: 'US_UNEMP' }] },
  { displayName: 'Jobless Claims', uiGroup: 'Jobs', treatment: 'USD_ONLY', rowOrder: 12, isActive: true,
    currencies: [{ currencyCode: 'USD', indicatorCode: 'US_JOBLESS_CLAIMS' }] },
  { displayName: 'JOLTS', uiGroup: 'Jobs', treatment: 'USD_ONLY', rowOrder: 13, isActive: true,
    currencies: [{ currencyCode: 'USD', indicatorCode: 'US_JOLTS' }] },
  { displayName: 'ADP', uiGroup: 'Jobs', treatment: 'USD_ONLY', rowOrder: 14, isActive: true,
    currencies: [{ currencyCode: 'USD', indicatorCode: 'US_ADP' }] },
  { displayName: 'Interest Rate', uiGroup: 'Rates', treatment: 'RATES_BILATERAL', rowOrder: 15, isActive: true,
    currencies: [{ currencyCode: 'EUR', indicatorCode: 'EU_ECB_RATE' }, { currencyCode: 'GBP', indicatorCode: 'UK_BOE_RATE' }, { currencyCode: 'JPY', indicatorCode: 'JP_BOJ_RATE' }, { currencyCode: 'USD', indicatorCode: 'US_FED_RATE' }] },
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
  mockedRegime.mockResolvedValue(gateSnapshot('Caution'));
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
  // Phase 5: isCarryPair mirrors the real registry (EUR/GBPJPY true, USDJPY
  // false — see pair-template.config.ts's PairDefinition.isCarryPair).
  prismaMock.asset.findMany.mockResolvedValue([
    { code: 'EURUSD', metadata: { base: 'EUR', quote: 'USD' } },
    { code: 'GBPUSD', metadata: { base: 'GBP', quote: 'USD' } },
    { code: 'USDJPY', metadata: { base: 'USD', quote: 'JPY' } },
    { code: 'EURJPY', metadata: { base: 'EUR', quote: 'JPY', isCarryPair: true } },
    { code: 'GBPJPY', metadata: { base: 'GBP', quote: 'JPY', isCarryPair: true } },
  ]);
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
    mockedRegime.mockResolvedValue(gateSnapshot('Risk-Off'));
    const r = await assemblePairScore('EURJPY', DATE);
    expect(r.compassAdjustment).toBe(-1);
    expect(r.totalScore).toBe(r.baseTotal - 1);
    expect(r.regime).toBe('Risk-Off');
  });

  it('Risk-Off + GBPJPY → -1 compass adjustment', async () => {
    setupScoreMap({});
    mockedRegime.mockResolvedValue(gateSnapshot('Risk-Off'));
    const r = await assemblePairScore('GBPJPY', DATE);
    expect(r.compassAdjustment).toBe(-1);
  });

  it('Risk-Off + USDJPY → no adjustment (override 5 excludes USDJPY)', async () => {
    setupScoreMap({});
    mockedRegime.mockResolvedValue(gateSnapshot('Risk-Off'));
    const r = await assemblePairScore('USDJPY', DATE);
    expect(r.compassAdjustment).toBe(0);
  });

  it('Risk-Off + EURUSD → no adjustment (no JPY in pair)', async () => {
    setupScoreMap({});
    mockedRegime.mockResolvedValue(gateSnapshot('Risk-Off'));
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
