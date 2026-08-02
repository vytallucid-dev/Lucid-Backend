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
   * Asset-level sign applied on top of the rule layer: `final = raw * polarity`.
   *
   * Phase 2: this replaces the `flipScoreForGold` boolean. A single boolean can
   * only express "flip everything" (Gold, a strict USD inverse). Indices need
   * MIXED signs — a growth beat is bullish for both USD and equities (+1) while
   * an inflation beat is bullish USD but bearish equities (-1) — which no
   * global flag can represent. Sourced from asset_indicator_map.polarity.
   */
  polarity: 1 | -1;
  /**
   * LEGACY, derived: `polarity === -1`. Retained solely because it is a key in
   * the persisted `indicatorBreakdown` JSON (and therefore in the API response
   * shape, which Phase 3 owns). Never drives arithmetic any more — polarity does.
   */
  flipScoreForGold: boolean;
}

export interface AssetIndicatorMapping {
  assetCode: string;
  assetId: string;
  /**
   * Phase 4: the asset's assetClass ('currency', 'commodity', 'forex_pair',
   * 'index'), threaded through from the Asset row this resolver already
   * fetches. Lets a caller derive asset-category eligibility (e.g. "is this
   * an index") without a hardcoded code list or an extra query — see
   * compass-overrides.ts Override 1.
   */
  assetClass: string;
  indicators: ResolvedIndicator[];
}

/**
 * PHASE 2 — SUPERSEDED, INTENTIONALLY RETAINED, NO LONGER READ.
 *
 * Membership now comes from the asset_indicator_map table (see
 * resolveAssetIndicators below). This constant stays in place, unused, until
 * the regression gate has been signed off and removal is explicitly approved.
 * Do not add new assets here — they will have no effect.
 */
const COUNTRY_BY_ASSET: Record<string, { fundamental: string[]; cot: string }> = {
  USD: { fundamental: ['US'], cot: 'USD' },
  EUR: { fundamental: ['EU'], cot: 'EUR' },
  GBP: { fundamental: ['UK'], cot: 'GBP' },
  JPY: { fundamental: ['JP'], cot: 'JPY' },
  XAUUSD: { fundamental: ['US'], cot: 'XAU' },
};
void COUNTRY_BY_ASSET;

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
 * Phase 2: membership, COT identification and sign all come from the
 * `asset_indicator_map` table. Nothing about which indicators belong to which
 * asset is expressed in code any more — adding an economy or an instrument is
 * a data insert.
 *
 * Ordering is `uiGroup ASC, code ASC` on the indicator, matching the previous
 * country-query ordering exactly so the persisted `indicatorBreakdown` array
 * keeps byte-identical ordering across the cutover.
 *
 * An asset with no map rows THROWS. A missing mapping is a configuration bug;
 * silently scoring 0 would look like a real (neutral) reading.
 */
export async function resolveAssetIndicators(
  assetCode: string,
): Promise<AssetIndicatorMapping> {
  const asset = await prisma.asset.findUnique({ where: { code: assetCode } });
  if (!asset) {
    throw new AppError(404, `Asset not found: ${assetCode}`, 'ASSET_NOT_FOUND');
  }

  const mapRows = await prisma.assetIndicatorMap.findMany({
    where: {
      assetId: asset.id,
      indicator: { tool: 'edgefinder', isActive: true },
    },
    include: { indicator: true },
    orderBy: [{ indicator: { uiGroup: 'asc' } }, { indicator: { code: 'asc' } }],
  });

  if (mapRows.length === 0) {
    throw new AppError(
      500,
      `No indicator map rows for asset code: ${assetCode} — asset_indicator_map has no active entries for this asset. This is a configuration gap, not a neutral score.`,
      'ASSET_NOT_MAPPED',
    );
  }

  const resolved: ResolvedIndicator[] = mapRows.map((m) => {
    const polarity: 1 | -1 = m.polarity === -1 ? -1 : 1;
    return {
      indicatorId: m.indicator.id,
      indicatorCode: m.indicator.code,
      uiGroup: m.indicator.uiGroup ?? 'Other',
      category: uiGroupToCategory(m.indicator.uiGroup),
      isCot: m.isCot,
      polarity,
      flipScoreForGold: polarity === -1,
    };
  });

  return {
    assetCode,
    assetId: asset.id,
    assetClass: asset.assetClass,
    indicators: resolved,
  };
}
