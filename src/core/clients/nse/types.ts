/**
 * NSE allIndices response types.
 * Endpoint: GET https://www.nseindia.com/api/allIndices
 *
 * NSE returns an array of every index they publish. Each row has a `last` field
 * holding the current/closing value depending on market state. The "INDIA VIX"
 * row is what we care about for the volatility indicator.
 */

export interface NseIndexRow {
  key?: string;
  index: string;
  indexSymbol?: string;
  last: number;
  variation?: number;
  percentChange?: number;
  open?: number;
  high?: number;
  low?: number;
  previousClose?: number;
  yearHigh?: number;
  yearLow?: number;
  pe?: string;
  pb?: string;
  dy?: string;
  declines?: string;
  advances?: string;
  unchanged?: string;
  perChange365d?: number;
  date365dAgo?: string;
  perChange30d?: number;
  date30dAgo?: string;
}

export interface NseAllIndicesResponse {
  data: NseIndexRow[];
  timestamp?: string; // "DD-MMM-YYYY HH:MM:SS" e.g. "16-May-2026 15:30:00"
  advances?: string;
  declines?: string;
  unchanged?: string;
  dates?: Record<string, string>;
  date30dAgo?: string;
  date365dAgo?: string;
}

/**
 * NSE FII/DII trade endpoint response.
 * Endpoint: /api/fiidiiTradeReact
 * Returns an array of category rows (FII and DII).
 */
export interface NseFiiDiiRow {
  category: string; // 'FII/FPI **' or 'DII **'
  date: string; // 'DD-MMM-YYYY'
  buyValue: string; // INR Crore as string
  sellValue: string; // INR Crore as string
  netValue: string; // INR Crore as string
}

export type NseFiiDiiResponse = NseFiiDiiRow[];
