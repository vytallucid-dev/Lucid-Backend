/**
 * EdgeFinder pair-scoring template.
 *
 * Each row maps a logical concept (GDP, CPI, ...) to a per-currency indicator
 * code. The pair scoring service evaluates every (base, quote) pair as
 * `base_indicator_score − quote_indicator_score` per row.
 *
 * PHASE 2 CUTOVER
 * ---------------
 * Both the template and the pair universe are now read from the database, and
 * no currency or instrument is named in this file:
 *
 *   - Row → currency → indicator comes from `pair_template_row_currencies`
 *     (currency is a ROW, not one of four literal columns).
 *   - The pair list comes from the asset registry (assetClass = 'forex_pair'),
 *     with base/quote read from the asset's own metadata.
 *
 * Adding an economy or an instrument is therefore a data insert.
 */
import { prisma } from '@core/db/prisma';
import { AppError } from '@core/middleware/error-handler';

/**
 * A currency code. Deliberately an open string type: the template supports any
 * currency present in `pair_template_row_currencies`, and enumerating them in
 * code is exactly the coupling Phase 2 removes.
 */
export type Currency = string;

export type PairRowUiGroup =
  | 'Growth'
  | 'Inflation'
  | 'Jobs'
  | 'Sentiment'
  | 'Rates';

export interface PairRowConfig {
  rowName: string;
  uiGroup: PairRowUiGroup;
  /** Indicator code per currency. Absent entry = currency has no indicator for this row. */
  indicators: Record<string, string>;
  /** If true for a currency, that side's score is negated before subtraction. */
  inverted?: Record<string, boolean>;
  /**
   * The currencies this row actually supports, derived from the normalised
   * table. The row applies to a pair when base or quote is one of them.
   */
  requiresCurrency?: Currency[];
  /**
   * Behaviour when the row does NOT apply to a pair — the Phase 3 asymmetry,
   * expressed as a property of the row rather than a list of row codes:
   *
   *   false → HARD exclude. The row is not part of that pair's template at all
   *           (rowIncluded=false). This is the default for single-currency rows
   *           such as Household Spending, Labor Cash Earnings, Tokyo Core CPI,
   *           AU Employment Change and China Caixin.
   *   true  → SOFT exclude. The row stays visible but is forced to score 0 —
   *           the "dead" rows. This is the legacy carve-out for the five
   *           USD-only rows (PCE, NFP, Jobless Claims, JOLTS, ADP).
   *
   * Because it is derived from the row's own `treatment` value, a future
   * single-side row behaves correctly with no code change.
   */
  softExcludeWhenUnsupported: boolean;
}

/**
 * Treatments whose rows stay VISIBLE scoring 0 when they do not apply, instead
 * of being dropped from the pair's template.
 *
 * This is the historical carve-out for the five USD-only rows, which have
 * always been rendered as zero rows in non-USD pairs. Every other
 * single-currency treatment (JPY_ONLY, AUD_ONLY, and any future one) defaults
 * to hard exclusion, matching the Household Spending precedent.
 */
const SOFT_EXCLUDE_TREATMENTS: ReadonlySet<string> = new Set(['USD_ONLY']);

export interface PairDefinition {
  code: string;
  base: Currency;
  quote: Currency;
  /**
   * Phase 5: whether this pair is a JPY carry-funding pair for Override 5
   * (Carry Unwind) — a higher-yielding currency funded by JPY. Sourced from
   * Asset.metadata.isCarryPair, a data property (not derived from a rate
   * differential — see pair-compass-overrides.ts for why). Defaults to false
   * when absent.
   */
  isCarryPair: boolean;
}

// ─── DB-driven template loading ───────────────────────────────────────────────

interface TemplateRowWithCurrencies {
  displayName: string;
  uiGroup: string;
  treatment: string;
  currencies: Array<{ currencyCode: string; indicatorCode: string | null }>;
}

export function dbRowToPairRowConfig(row: TemplateRowWithCurrencies): PairRowConfig {
  const indicators: Record<string, string> = {};
  for (const c of row.currencies) {
    if (c.indicatorCode) indicators[c.currencyCode] = c.indicatorCode;
  }

  // The row's supported currencies ARE its requirement. No currency literal.
  const supported = Object.keys(indicators);

  return {
    rowName: row.displayName,
    uiGroup: row.uiGroup as PairRowUiGroup,
    indicators,
    requiresCurrency: supported.length > 0 ? supported : undefined,
    softExcludeWhenUnsupported: SOFT_EXCLUDE_TREATMENTS.has(row.treatment),
    // No `inverted` field: every currency's PPI is NORMAL, including EUR.
  };
}

/**
 * Load active pair-template rows from the database ordered by rowOrder,
 * resolving each row's currencies from `pair_template_row_currencies`.
 */
export async function loadPairTemplateFromDb(): Promise<PairRowConfig[]> {
  const rows = await prisma.pairTemplateRow.findMany({
    where: { isActive: true },
    orderBy: { rowOrder: 'asc' },
    include: {
      currencies: {
        orderBy: { currencyCode: 'asc' },
        select: { currencyCode: true, indicatorCode: true },
      },
    },
  });
  return rows.map(dbRowToPairRowConfig);
}

// ─── Registry-driven pair definitions ─────────────────────────────────────────

/**
 * The pair universe, derived from the asset registry.
 *
 * base/quote are read from the asset's stored metadata. They are NEVER inferred
 * by slicing the pair code: a three-character split is wrong for any non-3+3
 * symbol, and a wrong parse silently inverts the sign of the pair's entire
 * score rather than failing. A pair missing that metadata throws.
 */
export async function loadPairDefinitions(): Promise<PairDefinition[]> {
  const assets = await prisma.asset.findMany({
    where: {
      isActive: true,
      assetClass: 'forex_pair',
      toolScope: { has: 'edgefinder' },
    },
    select: { code: true, metadata: true },
    orderBy: { code: 'asc' },
  });

  return assets.map((a) => {
    const meta = (a.metadata ?? {}) as Record<string, unknown>;
    const base = typeof meta.base === 'string' ? meta.base : null;
    const quote = typeof meta.quote === 'string' ? meta.quote : null;
    if (!base || !quote) {
      throw new AppError(
        500,
        `Pair asset ${a.code} is missing base/quote in metadata — refusing to infer them from the code, because a wrong parse silently inverts the pair's entire score.`,
        'PAIR_METADATA_INCOMPLETE',
      );
    }
    const isCarryPair = meta.isCarryPair === true;
    return { code: a.code, base, quote, isCarryPair };
  });
}

export async function getPairDefinition(pairCode: string): Promise<PairDefinition | null> {
  const defs = await loadPairDefinitions();
  return defs.find((p) => p.code === pairCode) ?? null;
}
