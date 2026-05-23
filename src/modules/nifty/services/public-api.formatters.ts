/**
 * Formatters for translating raw data into frontend display strings.
 * The frontend expects pre-formatted `value` and `magnitude` strings,
 * not raw numbers — this layer produces them.
 */

const INDIAN_RUPEE = '₹';
const USD = '$';

/**
 * Format a numeric value for display, indicator-specific.
 * Examples:
 *   PMI: 54.6 → '54.6'
 *   CPI: 3.48 → '3.48%'
 *   FII Flow: 1329.17 → '₹1,329 Cr'
 *   Brent: 106.11 → '$106.1'
 *   VIX: 18.79 → '18.79'
 *   Ind 9 (raw): 0 → 'Raw 0'
 *   Ind 13: 12.43 → '12.4%'
 */
export function formatIndicatorValue(indicatorCode: string, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';

  switch (indicatorCode) {
    case 'IND_NIFTY_01_PMI_MFG':
    case 'IND_NIFTY_02_PMI_SVC':
    case 'IND_NIFTY_08_VIX':
      return value.toFixed(2);

    case 'IND_NIFTY_03_CPI':
    case 'IND_NIFTY_05_IIP':
      return `${value.toFixed(2)}%`;

    case 'IND_NIFTY_04_RBI_RATE':
      return `${value.toFixed(2)}%`;

    case 'IND_NIFTY_06_FII_FLOW': {
      const sign = value < 0 ? '-' : '';
      const absVal = Math.abs(value);
      return `${sign}${INDIAN_RUPEE}${absVal.toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr`;
    }

    case 'IND_NIFTY_07_DII_ABSORPTION':
      return value.toFixed(3);

    case 'IND_NIFTY_09_USD_WEAKNESS': {
      const sign = value > 0 ? '+' : '';
      return `Raw ${sign}${Math.round(value)}`;
    }

    case 'IND_NIFTY_10_DXY':
      return value.toFixed(2);

    case 'IND_NIFTY_11_BRENT':
      return `${USD}${value.toFixed(2)}`;

    case 'IND_NIFTY_12_USDINR':
      return value.toFixed(2);

    case 'IND_NIFTY_13_FII_LS_RATIO':
      return `${value.toFixed(1)}%`;

    default:
      return value.toString();
  }
}

/**
 * Generate a magnitude / context narrative for an indicator.
 * Compares current value to prior data point and provides directional context.
 */
export function formatMagnitude(
  indicatorCode: string,
  currentValue: number | null,
  priorValue: number | null,
): string {
  if (currentValue === null) return 'No data';
  if (priorValue === null) {
    // For indicators with static magnitude, return the static string
    // even when no prior is available (their magnitude doesn't depend on prior)
    switch (indicatorCode) {
      case 'IND_NIFTY_09_USD_WEAKNESS':
        return 'composite from 14 sub-indicators';
      case 'IND_NIFTY_10_DXY':
        return '10-day change';
      case 'IND_NIFTY_11_BRENT':
        return '10-day change';
      case 'IND_NIFTY_13_FII_LS_RATIO':
        return 'FII long share of futures';
      default:
        return '';
    }
  }

  const delta = currentValue - priorValue;
  const direction = delta > 0 ? '+' : delta < 0 ? '' : '±';
  const absDelta = Math.abs(delta);

  switch (indicatorCode) {
    case 'IND_NIFTY_01_PMI_MFG':
    case 'IND_NIFTY_02_PMI_SVC':
      return `vs prior ${priorValue.toFixed(1)} (${direction}${absDelta.toFixed(1)} MoM)`;

    case 'IND_NIFTY_03_CPI':
    case 'IND_NIFTY_05_IIP':
      return `vs prior ${priorValue.toFixed(2)}% (${direction}${absDelta.toFixed(2)} pp MoM)`;

    case 'IND_NIFTY_06_FII_FLOW': {
      const sign = currentValue < 0 ? 'net sell' : 'net buy';
      return `${sign} (vs prior ${INDIAN_RUPEE}${Math.abs(priorValue).toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr)`;
    }

    case 'IND_NIFTY_08_VIX':
      return `vs prior ${priorValue.toFixed(2)} (${direction}${absDelta.toFixed(2)} pts)`;

    case 'IND_NIFTY_09_USD_WEAKNESS':
      return `composite from 14 sub-indicators`;

    case 'IND_NIFTY_10_DXY':
      return `10-day change`;

    case 'IND_NIFTY_11_BRENT':
      return `10-day change`;

    case 'IND_NIFTY_12_USDINR':
      return `10-day change vs ${priorValue.toFixed(2)}`;

    case 'IND_NIFTY_13_FII_LS_RATIO':
      return `FII long share of futures`;

    default:
      return `vs prior ${priorValue.toFixed(2)}`;
  }
}

/**
 * Map indicator dataSource to a friendly display string.
 */
export function describeDataSource(dataSource: string): string {
  const mapping: Record<string, string> = {
    fred: 'FRED API',
    manual: 'Manual',
    nse_scrape: 'NSE scrape',
    derived: 'Derived',
    edgefinder: 'EdgeFinder',
  };
  return mapping[dataSource] ?? dataSource;
}

/**
 * Compose output_range string from indicator metadata.
 */
export function indicatorOutputRange(indicatorCode: string): string {
  // Indicators that can score ±2 per v2.0 spec
  const fiveTier = new Set([
    'IND_NIFTY_03_CPI',
    'IND_NIFTY_06_FII_FLOW',
    'IND_NIFTY_09_USD_WEAKNESS',
    'IND_NIFTY_12_USDINR',
  ]);
  return fiveTier.has(indicatorCode) ? '-2/-1/0/+1/+2' : '-1/0/+1';
}

export function indicatorShortName(code: string): string {
  // Keyed by indicator code (stable) rather than name (which may change).
  const shortMap: Record<string, string> = {
    IND_NIFTY_01_PMI_MFG: 'PMI Mfg',
    IND_NIFTY_02_PMI_SVC: 'PMI Svc',
    IND_NIFTY_03_CPI: 'India CPI',
    IND_NIFTY_04_RBI_RATE: 'RBI Rate',
    IND_NIFTY_05_IIP: 'IIP',
    IND_NIFTY_06_FII_FLOW: 'FII Flow',
    IND_NIFTY_07_DII_ABSORPTION: 'DII Abs',
    IND_NIFTY_08_VIX: 'India VIX',
    IND_NIFTY_09_USD_WEAKNESS: 'USD Wkns',
    IND_NIFTY_10_DXY: 'DXY Trend',
    IND_NIFTY_11_BRENT: 'Brent',
    IND_NIFTY_12_USDINR: 'INR/USD',
    IND_NIFTY_13_FII_LS_RATIO: 'FII L/S',
  };
  return shortMap[code] ?? code;
}
