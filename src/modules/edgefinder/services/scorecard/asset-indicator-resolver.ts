import { prisma } from '@core/db/prisma';
import { AppError } from '@core/middleware/error-handler';
import type { IndicatorCategory } from './compass-overrides';

export interface ResolvedIndicator {
  indicatorId: string;
  indicatorCode: string;
  uiGroup: string;
  category: IndicatorCategory;
  isCot: boolean;
  /**
   * For Gold (XAUUSD), all non-COT US indicators except US_JOBLESS_CLAIMS
   * have their score sign flipped by the scorecard assembly layer.
   */
  flipScoreForGold: boolean;
}

export interface AssetIndicatorMapping {
  assetCode: string;
  assetId: string;
  indicators: ResolvedIndicator[];
}

const COUNTRY_BY_ASSET: Record<string, { fundamental: string[]; cot: string }> = {
  USD: { fundamental: ['US'], cot: 'USD' },
  EUR: { fundamental: ['EU'], cot: 'EUR' },
  GBP: { fundamental: ['UK'], cot: 'GBP' },
  JPY: { fundamental: ['JP'], cot: 'JPY' },
  XAUUSD: { fundamental: ['US'], cot: 'XAU' },
};

const GOLD_NON_FLIPPED_CODE = 'US_JOBLESS_CLAIMS';

function uiGroupToCategory(uiGroup: string | null): IndicatorCategory {
  switch (uiGroup) {
    case 'Growth':
    case 'Inflation':
    case 'Jobs':
    case 'Sentiment':
    case 'Rates':
    case 'COT':
      return uiGroup;
    default:
      return 'Other';
  }
}

/**
 * Resolve the full indicator set for an asset's scorecard.
 *
 * Country-code conventions in the seed:
 *   - Fundamentals: 'US' / 'EU' / 'UK' / 'JP'
 *   - COT: 'USD' / 'EUR' / 'GBP' / 'JPY' / 'XAU'
 *
 * Gold (XAUUSD) shares the US fundamentals indicator set with USD. Score-flip
 * (negate sign) is handled at the scorecard-assembly layer, NOT here. This
 * resolver flags each indicator with `flipScoreForGold` so the caller knows
 * which entries to negate for Gold.
 */
export async function resolveAssetIndicators(
  assetCode: string,
): Promise<AssetIndicatorMapping> {
  const mapping = COUNTRY_BY_ASSET[assetCode];
  if (!mapping) {
    throw new AppError(
      404,
      `No indicator mapping for asset code: ${assetCode}`,
      'UNKNOWN_ASSET',
    );
  }

  const asset = await prisma.asset.findUnique({ where: { code: assetCode } });
  if (!asset) {
    throw new AppError(404, `Asset not found: ${assetCode}`, 'ASSET_NOT_FOUND');
  }

  const indicators = await prisma.indicator.findMany({
    where: {
      tool: 'edgefinder',
      isActive: true,
      country: { in: [...mapping.fundamental, mapping.cot] },
    },
    orderBy: [{ uiGroup: 'asc' }, { code: 'asc' }],
  });

  const resolved: ResolvedIndicator[] = indicators.map((ind) => {
    const isCot = ind.uiGroup === 'COT' || ind.country === mapping.cot;
    return {
      indicatorId: ind.id,
      indicatorCode: ind.code,
      uiGroup: ind.uiGroup ?? 'Other',
      category: uiGroupToCategory(ind.uiGroup),
      isCot,
      flipScoreForGold:
        assetCode === 'XAUUSD' && !isCot && ind.code !== GOLD_NON_FLIPPED_CODE,
    };
  });

  return {
    assetCode,
    assetId: asset.id,
    indicators: resolved,
  };
}
