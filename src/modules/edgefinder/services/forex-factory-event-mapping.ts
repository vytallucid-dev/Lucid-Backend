/**
 * Forex Factory event (country, title) → EdgeFinder indicator code.
 *
 * Confidence levels:
 *   VERIFIED — confirmed from real FF JSON feed
 *   HIGH     — standard FF naming convention
 *   MEDIUM   — multiple candidate names exist; best guess
 *   LOW      — unusual / rare release; verify on first occurrence
 *
 * NOTE: Both Flash and Final PMIs map to the same indicator. The idempotent
 * upsert handles overwriting Flash with Final when Final releases later.
 *
 * JP CPI uses "National Core CPI y/y" because FF reliably publishes that;
 * national headline CPI is not consistently named in FF. Spec deviation noted.
 */

export const FF_EVENT_TO_INDICATOR: Record<string, Record<string, string>> = {
  USD: {
    // VERIFIED from real fetch
    'Unemployment Claims': 'US_JOBLESS_CLAIMS',
    'ADP Weekly Employment Change': 'US_ADP',
    // HIGH confidence — standard FF naming
    'CPI y/y': 'US_CPI_YOY',
    'PPI m/m': 'US_PPI_MOM',
    'Retail Sales m/m': 'US_RETAIL_MOM',
    'ISM Manufacturing PMI': 'US_ISM_MFG',
    'ISM Services PMI': 'US_ISM_SVC',
    'CB Consumer Confidence': 'US_CB_CONSCONF',
    'Non-Farm Employment Change': 'US_NFP',
    'Unemployment Rate': 'US_UNEMP',
    'ADP Non-Farm Employment Change': 'US_ADP',
    'JOLTS Job Openings': 'US_JOLTS',
    'Federal Funds Rate': 'US_FED_RATE',
    'Advance GDP q/q': 'US_GDP_QOQ',
    'Prelim GDP q/q': 'US_GDP_QOQ',
    'Final GDP q/q': 'US_GDP_QOQ',
    // MEDIUM confidence
    'Core PCE Price Index y/y': 'US_PCE_YOY',
    'Core PCE Price Index m/m': 'US_PCE_YOY',
  },
  EUR: {
    // VERIFIED
    'Consumer Confidence': 'EU_CCI',
    'Final CPI y/y': 'EU_CPI_YOY',
    'Flash Manufacturing PMI': 'EU_MFG_PMI',
    'Flash Services PMI': 'EU_SVC_PMI',
    // HIGH
    'Final Manufacturing PMI': 'EU_MFG_PMI',
    'Final Services PMI': 'EU_SVC_PMI',
    'Flash GDP q/q': 'EU_GDP_QOQ',
    'Prelim Flash GDP q/q': 'EU_GDP_QOQ',
    'Final GDP q/q': 'EU_GDP_QOQ',
    'Retail Sales m/m': 'EU_RETAIL_MOM',
    'PPI m/m': 'EU_PPI_MOM',
    'CPI Flash Estimate y/y': 'EU_CPI_YOY',
    'Unemployment Rate': 'EU_UNEMP',
    'Main Refinancing Rate': 'EU_ECB_RATE',
  },
  GBP: {
    // VERIFIED
    'CPI y/y': 'UK_CPI_YOY',
    'GfK Consumer Confidence': 'UK_GFK',
    'Unemployment Rate': 'UK_UNEMP',
    'Flash Manufacturing PMI': 'UK_MFG_PMI',
    'Flash Services PMI': 'UK_SVC_PMI',
    'Retail Sales m/m': 'UK_RETAIL_MOM',
    // HIGH
    'Final Manufacturing PMI': 'UK_MFG_PMI',
    'Final Services PMI': 'UK_SVC_PMI',
    'GDP m/m': 'UK_GDP_MOM',
    'Prelim GDP q/q': 'UK_GDP_MOM',
    'PPI Output m/m': 'UK_PPI_MOM',
    'Official Bank Rate': 'UK_BOE_RATE',
  },
  JPY: {
    // VERIFIED
    'National Core CPI y/y': 'JP_CPI_YOY',
    'Prelim GDP q/q': 'JP_GDP_QOQ',
    'Flash Manufacturing PMI': 'JP_MFG_PMI',
    // HIGH
    'Final Manufacturing PMI': 'JP_MFG_PMI',
    'Flash Services PMI': 'JP_SVC_PMI',
    'Final Services PMI': 'JP_SVC_PMI',
    'PPI y/y': 'JP_PPI_YOY',
    'Household Spending y/y': 'JP_HSHLD_SPEND',
    'Retail Sales y/y': 'JP_RETAIL_YOY',
    'Consumer Confidence': 'JP_CONSCONF',
    'Unemployment Rate': 'JP_UNEMP',
    'Final GDP q/q': 'JP_GDP_QOQ',
    // LOW
    'Monetary Policy Statement': 'JP_BOJ_RATE',
    'BOJ Policy Rate': 'JP_BOJ_RATE',
  },
};

export function mapEventToIndicator(country: string, title: string): string | null {
  const countryMap = FF_EVENT_TO_INDICATOR[country];
  if (!countryMap) return null;
  return countryMap[title] ?? null;
}
