/**
 * EdgeFinder Phase 5 — pair-scoring template config.
 *
 * Fixed indicator-row template per Spec v1 §7. Each row maps a logical
 * concept (GDP, CPI, ...) to its per-currency indicator code. The pair
 * scoring service consumes this to evaluate every (base, quote) pair as
 * `base_indicator_score − quote_indicator_score` per row, optionally with
 * per-currency inversion and per-pair inclusion rules.
 *
 * The canonical source of truth is now the `pair_template_rows` DB table
 * (seeded via seed-edgefinder.ts). Use `loadPairTemplateFromDb()` at runtime
 * instead of the static `PAIR_TEMPLATE` array.
 */
import { prisma } from '@core/db/prisma';

export type Currency = 'USD' | 'EUR' | 'GBP' | 'JPY';

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
  indicators: Partial<Record<Currency, string>>;
  /** If true for a currency, that side's score is negated before subtraction. */
  inverted?: Partial<Record<Currency, boolean>>;
  /** Row is only scored when one of these currencies is in the pair. */
  requiresCurrency?: Currency[];
}

export const PAIR_TEMPLATE: PairRowConfig[] = [
  {
    rowName: 'GDP',
    uiGroup: 'Growth',
    indicators: { USD: 'US_GDP_QOQ', EUR: 'EU_GDP_QOQ', GBP: 'UK_GDP_MOM', JPY: 'JP_GDP_QOQ' },
  },
  {
    rowName: 'Manufacturing PMI',
    uiGroup: 'Growth',
    indicators: { USD: 'US_ISM_MFG', EUR: 'EU_MFG_PMI', GBP: 'UK_MFG_PMI', JPY: 'JP_MFG_PMI' },
  },
  {
    rowName: 'Services PMI',
    uiGroup: 'Growth',
    indicators: { USD: 'US_ISM_SVC', EUR: 'EU_SVC_PMI', GBP: 'UK_SVC_PMI', JPY: 'JP_SVC_PMI' },
  },
  {
    rowName: 'Retail Sales',
    uiGroup: 'Growth',
    indicators: { USD: 'US_RETAIL_MOM', EUR: 'EU_RETAIL_MOM', GBP: 'UK_RETAIL_MOM', JPY: 'JP_RETAIL_YOY' },
  },
  {
    rowName: 'Consumer Confidence',
    uiGroup: 'Sentiment',
    indicators: { USD: 'US_CB_CONSCONF', EUR: 'EU_CCI', GBP: 'UK_GFK', JPY: 'JP_CONSCONF' },
  },
  {
    rowName: 'CPI',
    uiGroup: 'Inflation',
    indicators: { USD: 'US_CPI_YOY', EUR: 'EU_CPI_YOY', GBP: 'UK_CPI_YOY', JPY: 'JP_CPI_YOY' },
  },
  {
    rowName: 'PPI',
    uiGroup: 'Inflation',
    indicators: { USD: 'US_PPI_MOM', EUR: 'EU_PPI_MOM', GBP: 'UK_PPI_MOM', JPY: 'JP_PPI_YOY' },
    inverted: { EUR: true },
    requiresCurrency: ['EUR'],
  },
  {
    rowName: 'PCE',
    uiGroup: 'Inflation',
    indicators: { USD: 'US_PCE_YOY' },
    requiresCurrency: ['USD'],
  },
  {
    rowName: 'Household Spending',
    uiGroup: 'Inflation',
    indicators: { JPY: 'JP_HSHLD_SPEND' },
    requiresCurrency: ['JPY'],
  },
  {
    rowName: 'NFP / Employment',
    uiGroup: 'Jobs',
    indicators: { USD: 'US_NFP' },
    requiresCurrency: ['USD'],
  },
  {
    rowName: 'Unemployment',
    uiGroup: 'Jobs',
    indicators: { USD: 'US_UNEMP', EUR: 'EU_UNEMP', GBP: 'UK_UNEMP', JPY: 'JP_UNEMP' },
    // Unemployment uses the inverted scoring handler (lower = better for currency).
    // The engine already returns lower-is-positive scores, so do NOT double-invert here.
  },
  {
    rowName: 'Jobless Claims',
    uiGroup: 'Jobs',
    indicators: { USD: 'US_JOBLESS_CLAIMS' },
    requiresCurrency: ['USD'],
  },
  {
    rowName: 'JOLTS',
    uiGroup: 'Jobs',
    indicators: { USD: 'US_JOLTS' },
    requiresCurrency: ['USD'],
  },
  {
    rowName: 'ADP',
    uiGroup: 'Jobs',
    indicators: { USD: 'US_ADP' },
    requiresCurrency: ['USD'],
  },
  {
    rowName: 'Interest Rate',
    uiGroup: 'Rates',
    indicators: { USD: 'US_FED_RATE', EUR: 'EU_ECB_RATE', GBP: 'UK_BOE_RATE', JPY: 'JP_BOJ_RATE' },
  },
];

export interface PairDefinition {
  code: string;
  base: Currency;
  quote: Currency;
}

export const PAIR_DEFINITIONS: ReadonlyArray<PairDefinition> = [
  { code: 'EURUSD', base: 'EUR', quote: 'USD' },
  { code: 'GBPUSD', base: 'GBP', quote: 'USD' },
  { code: 'USDJPY', base: 'USD', quote: 'JPY' },
  { code: 'EURJPY', base: 'EUR', quote: 'JPY' },
  { code: 'GBPJPY', base: 'GBP', quote: 'JPY' },
] as const;

export function getPairDefinition(pairCode: string): PairDefinition | null {
  return PAIR_DEFINITIONS.find((p) => p.code === pairCode) ?? null;
}

// ─── DB-driven template loading ───────────────────────────────────────────────

function dbRowToPairRowConfig(row: {
  displayName: string;
  uiGroup: string;
  treatment: string;
  usIndicatorCode: string | null;
  eurIndicatorCode: string | null;
  gbpIndicatorCode: string | null;
  jpyIndicatorCode: string | null;
}): PairRowConfig {
  const indicators: Partial<Record<Currency, string>> = {};
  if (row.usIndicatorCode) indicators.USD = row.usIndicatorCode;
  if (row.eurIndicatorCode) indicators.EUR = row.eurIndicatorCode;
  if (row.gbpIndicatorCode) indicators.GBP = row.gbpIndicatorCode;
  if (row.jpyIndicatorCode) indicators.JPY = row.jpyIndicatorCode;

  let requiresCurrency: Currency[] | undefined;
  if (row.treatment === 'USD_ONLY') requiresCurrency = ['USD'];
  else if (row.treatment === 'JPY_ONLY') requiresCurrency = ['JPY'];
  // BILATERAL and RATES_BILATERAL have no requiresCurrency constraint.

  return {
    rowName: row.displayName,
    uiGroup: row.uiGroup as PairRowUiGroup,
    indicators,
    requiresCurrency,
    // No `inverted` field: PPI is correctly BILATERAL in the DB (no EUR inversion).
  };
}

/**
 * Load active pair-template rows from the database ordered by rowOrder.
 *
 * This is the canonical runtime replacement for the static PAIR_TEMPLATE array.
 * The DB is the single source of truth for indicator codes and treatment rules,
 * so any seed change (e.g. fixing PPI to BILATERAL) is automatically picked up
 * without redeploying application code.
 */
export async function loadPairTemplateFromDb(): Promise<PairRowConfig[]> {
  const rows = await prisma.pairTemplateRow.findMany({
    where: { isActive: true },
    orderBy: { rowOrder: 'asc' },
  });
  return rows.map(dbRowToPairRowConfig);
}
