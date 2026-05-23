import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@core/scoring/engine', () => ({
  scoreIndicator: vi.fn(),
}));

vi.mock('@core/repositories/edgefinder-scorecards.repository', () => ({
  edgefinderScorecardsRepository: {
    upsert: vi.fn(),
    getCurrent: vi.fn(),
  },
}));

vi.mock('@core/repositories/compass-classifications.repository', () => ({
  compassClassificationsRepository: {
    getRegimeAsOf: vi.fn(),
    getMostRecentBefore: vi.fn(),
  },
}));

vi.mock('@modules/edgefinder/services/scorecard/asset-indicator-resolver', () => ({
  resolveAssetIndicators: vi.fn(),
}));

import { scoreIndicator } from '@core/scoring/engine';
import { edgefinderScorecardsRepository } from '@core/repositories/edgefinder-scorecards.repository';
import { compassClassificationsRepository } from '@core/repositories/compass-classifications.repository';
import { resolveAssetIndicators } from '@modules/edgefinder/services/scorecard/asset-indicator-resolver';
import {
  assembleAssetScorecard,
  mapScoreToLabel,
} from '@modules/edgefinder/services/scorecard/asset-scorecard.service';

const mockedScore = scoreIndicator as unknown as ReturnType<typeof vi.fn>;
const mockedUpsert =
  edgefinderScorecardsRepository.upsert as unknown as ReturnType<typeof vi.fn>;
const mockedRegime =
  compassClassificationsRepository.getRegimeAsOf as unknown as ReturnType<typeof vi.fn>;
const mockedResolver =
  resolveAssetIndicators as unknown as ReturnType<typeof vi.fn>;

const DATE = new Date(Date.UTC(2026, 4, 19));

type ResolvedIndicatorMock = {
  indicatorId: string;
  indicatorCode: string;
  uiGroup: string;
  category: 'Growth' | 'Inflation' | 'Jobs' | 'Sentiment' | 'Rates' | 'COT' | 'Other';
  isCot: boolean;
  flipScoreForGold: boolean;
};

function ind(
  code: string,
  category: ResolvedIndicatorMock['category'] = 'Growth',
  opts: { isCot?: boolean; flip?: boolean } = {},
): ResolvedIndicatorMock {
  return {
    indicatorId: `i-${code}`,
    indicatorCode: code,
    uiGroup: opts.isCot ? 'COT' : category,
    category: opts.isCot ? 'COT' : category,
    isCot: opts.isCot ?? false,
    flipScoreForGold: opts.flip ?? false,
  };
}

function scoredResult(score: number, metadata: Record<string, unknown> = {}) {
  return {
    kind: 'scored' as const,
    score,
    flags: [],
    metadata,
  };
}

function insufficient(reason: string) {
  return { kind: 'insufficient_data' as const, reason, details: {} };
}

function setupScoreMap(
  byCode: Record<string, number | { score: number; metadata?: Record<string, unknown> } | 'missing'>,
): void {
  mockedScore.mockImplementation(async ({ indicatorCode }: { indicatorCode: string }) => {
    const v = byCode[indicatorCode];
    if (v === undefined) throw new Error(`Test mock has no entry for ${indicatorCode}`);
    if (v === 'missing') return insufficient(`no data for ${indicatorCode}`);
    if (typeof v === 'number') return scoredResult(v);
    return scoredResult(v.score, v.metadata ?? {});
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedUpsert.mockResolvedValue({ scorecardId: 'sc-1', action: 'inserted' });
  mockedRegime.mockResolvedValue({
    classificationDate: DATE,
    activeRegime: 'Caution',
    candidateRegime: 'Caution',
    persistenceDaysCount: 0,
  });
});

describe('mapScoreToLabel', () => {
  it.each([
    [5, 'Very Support'],
    [4, 'Very Support'],
    [3, 'Support'],
    [2, 'Neutral'],
    [0, 'Neutral'],
    [-2, 'Neutral'],
    [-3, 'Weak'],
    [-4, 'Very Weak'],
    [-10, 'Very Weak'],
  ])('score %d → %s', (score, expected) => {
    expect(mapScoreToLabel(score)).toBe(expected);
  });
});

describe('assembleAssetScorecard — base assembly', () => {
  it('USD in Risk-On: sums fundamentals + cot, no overrides applied', async () => {
    mockedResolver.mockResolvedValue({
      assetCode: 'USD',
      assetId: 'asset-usd',
      indicators: [
        ind('US_GDP_QOQ', 'Growth'),
        ind('US_NFP', 'Jobs'),
        ind('USD_COT', 'COT', { isCot: true }),
      ],
    });
    mockedRegime.mockResolvedValue({
      classificationDate: DATE,
      activeRegime: 'Risk-On',
      candidateRegime: 'Risk-On',
      persistenceDaysCount: 0,
    });
    setupScoreMap({ US_GDP_QOQ: 1, US_NFP: -1, USD_COT: 1 });

    const r = await assembleAssetScorecard('USD', DATE);
    expect(r.baseFundamentalsScore).toBe(0); // 1 + (-1)
    expect(r.cotScore).toBe(1);
    expect(r.compassAdjustment).toBe(0);
    expect(r.fundamentalsScore).toBe(0);
    expect(r.totalScore).toBe(1);
    expect(r.ratingLabel).toBe('Neutral');
    expect(r.regime).toBe('Risk-On');
  });

  it('USD Caution: no overrides applied', async () => {
    mockedResolver.mockResolvedValue({
      assetCode: 'USD',
      assetId: 'asset-usd',
      indicators: [ind('US_NFP', 'Jobs'), ind('USD_COT', 'COT', { isCot: true })],
    });
    setupScoreMap({ US_NFP: -1, USD_COT: 0 });

    const r = await assembleAssetScorecard('USD', DATE);
    expect(r.compassAdjustment).toBe(0);
    expect(r.regime).toBe('Caution');
  });
});

describe('assembleAssetScorecard — overrides in Risk-Off', () => {
  beforeEach(() => {
    mockedRegime.mockResolvedValue({
      classificationDate: DATE,
      activeRegime: 'Risk-Off',
      candidateRegime: 'Risk-Off',
      persistenceDaysCount: 0,
    });
  });

  it('USD weak-jobs override fires: +1 per jobs miss', async () => {
    mockedResolver.mockResolvedValue({
      assetCode: 'USD',
      assetId: 'asset-usd',
      indicators: [
        ind('US_GDP_QOQ', 'Growth'),
        ind('US_NFP', 'Jobs'),
        ind('US_UNEMP', 'Jobs'),
        ind('USD_COT', 'COT', { isCot: true }),
      ],
    });
    setupScoreMap({ US_GDP_QOQ: 0, US_NFP: -1, US_UNEMP: -1, USD_COT: 0 });

    const r = await assembleAssetScorecard('USD', DATE);
    expect(r.baseFundamentalsScore).toBe(-2); // GDP 0 + NFP -1 + UNEMP -1
    expect(r.compassAdjustment).toBe(2);
    expect(r.fundamentalsScore).toBe(0);
    expect(r.cotScore).toBe(0);
    expect(r.totalScore).toBe(0);
    expect(r.ratingLabel).toBe('Neutral');
    const upsertCall = mockedUpsert.mock.calls[0][0];
    expect(upsertCall.compassOverridesApplied.regime).toBe('Risk-Off');
    expect(upsertCall.compassOverridesApplied.overridesFired[0].code).toBe(
      'OVERRIDE_4_USD_WEAK_JOBS',
    );
  });

  it('JPY safe-haven override: +1 regardless of indicator state', async () => {
    mockedResolver.mockResolvedValue({
      assetCode: 'JPY',
      assetId: 'asset-jpy',
      indicators: [ind('JP_GDP_QOQ', 'Growth'), ind('JPY_COT', 'COT', { isCot: true })],
    });
    setupScoreMap({ JP_GDP_QOQ: 0, JPY_COT: 1 });

    const r = await assembleAssetScorecard('JPY', DATE);
    expect(r.compassAdjustment).toBe(1);
    expect(r.baseFundamentalsScore).toBe(0);
    expect(r.fundamentalsScore).toBe(1);
    expect(r.totalScore).toBe(2);
    expect(r.ratingLabel).toBe('Neutral');
  });

  it('Gold inflation hedge: CPI beat (engine +1 → Gold-flipped -1) flips back via +2 override', async () => {
    mockedResolver.mockResolvedValue({
      assetCode: 'XAUUSD',
      assetId: 'asset-xau',
      indicators: [
        ind('US_CPI_YOY', 'Inflation', { flip: true }),
        ind('US_GDP_QOQ', 'Growth', { flip: true }),
        ind('US_JOBLESS_CLAIMS', 'Jobs', { flip: false }),
        ind('XAUUSD_COT', 'COT', { isCot: true }),
      ],
    });
    setupScoreMap({ US_CPI_YOY: 1, US_GDP_QOQ: 1, US_JOBLESS_CLAIMS: 1, XAUUSD_COT: 0 });

    const r = await assembleAssetScorecard('XAUUSD', DATE);
    // Engine returns: CPI +1, GDP +1, Jobless +1, COT 0
    // Gold flip applied: CPI -1, GDP -1, Jobless +1 (not flipped), COT 0
    // Base fundamentals = -1 + -1 + 1 = -1
    expect(r.baseFundamentalsScore).toBe(-1);
    // Override 2: CPI is -1 → +2 adjustment
    expect(r.compassAdjustment).toBe(2);
    expect(r.fundamentalsScore).toBe(1);
    expect(r.cotScore).toBe(0);
    expect(r.totalScore).toBe(1);
  });

  it('Gold flip negates GDP score sign while keeping jobless claims unchanged', async () => {
    mockedResolver.mockResolvedValue({
      assetCode: 'XAUUSD',
      assetId: 'asset-xau',
      indicators: [
        ind('US_GDP_QOQ', 'Growth', { flip: true }),
        ind('US_JOBLESS_CLAIMS', 'Jobs', { flip: false }),
        ind('XAUUSD_COT', 'COT', { isCot: true }),
      ],
    });
    mockedRegime.mockResolvedValue({
      classificationDate: DATE,
      activeRegime: 'Caution',
      candidateRegime: 'Caution',
      persistenceDaysCount: 0,
    });
    setupScoreMap({ US_GDP_QOQ: 1, US_JOBLESS_CLAIMS: 1, XAUUSD_COT: 0 });

    const r = await assembleAssetScorecard('XAUUSD', DATE);
    expect(r.baseFundamentalsScore).toBe(0); // -1 + 1
    expect(r.compassAdjustment).toBe(0);
    expect(r.totalScore).toBe(0);
    const breakdown = mockedUpsert.mock.calls[0][0].indicatorBreakdown;
    const gdp = breakdown.find((b: { indicatorCode: string }) => b.indicatorCode === 'US_GDP_QOQ');
    expect(gdp.score).toBe(-1);
    expect(gdp.baseScoreBeforeGoldFlip).toBe(1);
    const jc = breakdown.find(
      (b: { indicatorCode: string }) => b.indicatorCode === 'US_JOBLESS_CLAIMS',
    );
    expect(jc.score).toBe(1);
  });
});

describe('assembleAssetScorecard — edge cases', () => {
  it('Missing COT data: cotScore = 0, scorecard still computed', async () => {
    mockedResolver.mockResolvedValue({
      assetCode: 'EUR',
      assetId: 'asset-eur',
      indicators: [ind('EU_GDP_QOQ', 'Growth'), ind('EUR_COT', 'COT', { isCot: true })],
    });
    setupScoreMap({ EU_GDP_QOQ: 1, EUR_COT: 'missing' });

    const r = await assembleAssetScorecard('EUR', DATE);
    expect(r.cotScore).toBe(0);
    expect(r.baseFundamentalsScore).toBe(1);
    expect(r.totalScore).toBe(1);
  });

  it('No compass classification → defaults to Caution, no overrides', async () => {
    mockedResolver.mockResolvedValue({
      assetCode: 'USD',
      assetId: 'asset-usd',
      indicators: [ind('US_NFP', 'Jobs'), ind('USD_COT', 'COT', { isCot: true })],
    });
    mockedRegime.mockResolvedValue(null);
    setupScoreMap({ US_NFP: -1, USD_COT: 0 });

    const r = await assembleAssetScorecard('USD', DATE);
    expect(r.regime).toBe('Caution');
    expect(r.compassAdjustment).toBe(0);
  });

  it('Idempotent re-run propagates skipped from repository', async () => {
    mockedResolver.mockResolvedValue({
      assetCode: 'USD',
      assetId: 'asset-usd',
      indicators: [ind('US_GDP_QOQ'), ind('USD_COT', 'COT', { isCot: true })],
    });
    setupScoreMap({ US_GDP_QOQ: 1, USD_COT: 1 });
    mockedUpsert.mockResolvedValue({ scorecardId: 'sc-1', action: 'skipped' });

    const r = await assembleAssetScorecard('USD', DATE);
    expect(r.action).toBe('skipped');
  });

  it('Very Support boundary: totalScore +4 → "Very Support"', async () => {
    mockedResolver.mockResolvedValue({
      assetCode: 'USD',
      assetId: 'asset-usd',
      indicators: [
        ind('US_GDP_QOQ', 'Growth'),
        ind('US_ISM_MFG', 'Growth'),
        ind('US_ISM_SVC', 'Growth'),
        ind('USD_COT', 'COT', { isCot: true }),
      ],
    });
    setupScoreMap({ US_GDP_QOQ: 1, US_ISM_MFG: 1, US_ISM_SVC: 1, USD_COT: 1 });

    const r = await assembleAssetScorecard('USD', DATE);
    expect(r.totalScore).toBe(4);
    expect(r.ratingLabel).toBe('Very Support');
  });

  it('Very Weak boundary: totalScore -4 → "Very Weak"', async () => {
    mockedResolver.mockResolvedValue({
      assetCode: 'USD',
      assetId: 'asset-usd',
      indicators: [
        ind('US_GDP_QOQ'),
        ind('US_ISM_MFG'),
        ind('US_ISM_SVC'),
        ind('USD_COT', 'COT', { isCot: true }),
      ],
    });
    setupScoreMap({ US_GDP_QOQ: -1, US_ISM_MFG: -1, US_ISM_SVC: -1, USD_COT: -1 });

    const r = await assembleAssetScorecard('USD', DATE);
    expect(r.totalScore).toBe(-4);
    expect(r.ratingLabel).toBe('Very Weak');
  });

  it('Indicator breakdown serializes per-indicator details', async () => {
    mockedResolver.mockResolvedValue({
      assetCode: 'USD',
      assetId: 'asset-usd',
      indicators: [ind('US_GDP_QOQ', 'Growth'), ind('USD_COT', 'COT', { isCot: true })],
    });
    setupScoreMap({
      US_GDP_QOQ: { score: 1, metadata: { direction: 'BEAT', actual: 2.3, forecast: 2.0 } },
      USD_COT: { score: 1, metadata: { netLabel: 'Bullish', changeLabel: 'Bullish', longPct: 55, weeklyChangePct: 3, reportDate: '2026-05-12' } },
    });

    await assembleAssetScorecard('USD', DATE);
    const call = mockedUpsert.mock.calls[0][0];
    expect(call.indicatorBreakdown).toHaveLength(2);
    const gdp = call.indicatorBreakdown.find(
      (b: { indicatorCode: string }) => b.indicatorCode === 'US_GDP_QOQ',
    );
    expect(gdp.direction).toBe('BEAT');
    expect(call.cotBreakdown.netLabel).toBe('Bullish');
    expect(call.cotBreakdown.reportDate).toBe('2026-05-12');
  });

  it('compassOverridesApplied is null when in Caution/Risk-On', async () => {
    mockedResolver.mockResolvedValue({
      assetCode: 'USD',
      assetId: 'asset-usd',
      indicators: [ind('US_NFP', 'Jobs'), ind('USD_COT', 'COT', { isCot: true })],
    });
    setupScoreMap({ US_NFP: -1, USD_COT: 0 });

    await assembleAssetScorecard('USD', DATE);
    const call = mockedUpsert.mock.calls[0][0];
    expect(call.compassOverridesApplied).toBeNull();
  });

  it('passes regimeAtCompute to repository', async () => {
    mockedResolver.mockResolvedValue({
      assetCode: 'JPY',
      assetId: 'asset-jpy',
      indicators: [ind('JP_GDP_QOQ'), ind('JPY_COT', 'COT', { isCot: true })],
    });
    mockedRegime.mockResolvedValue({
      classificationDate: DATE,
      activeRegime: 'Risk-Off',
      candidateRegime: 'Risk-Off',
      persistenceDaysCount: 0,
    });
    setupScoreMap({ JP_GDP_QOQ: 0, JPY_COT: 0 });

    await assembleAssetScorecard('JPY', DATE);
    expect(mockedUpsert.mock.calls[0][0].regimeAtCompute).toBe('Risk-Off');
  });
});
