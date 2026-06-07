/**
 * EODHD API response types.
 * Reference: https://eodhd.com/financial-apis/
 *
 * EODHD exposes two endpoint shapes used here:
 *   - EOD endpoint   /api/eod/{symbol}                  → array of OHLCV rows
 *   - Commodities    /api/commodities/historical/{code} → { meta, data[] } of {date,value}
 *
 * Both are normalized by the client to the common `EodhdDataPoint` shape.
 */

/** Normalized, source-shape-agnostic point returned by the client. */
export interface EodhdDataPoint {
  date: string; // observation date "YYYY-MM-DD"
  value: number;
}

/** Raw row from the standard EOD endpoint (/api/eod/{symbol}). */
export interface EodhdEodRow {
  date: string; // "YYYY-MM-DD"
  open: number;
  high: number;
  low: number;
  close: number;
  adjusted_close: number;
  volume: number;
}

/** Raw row from the commodities endpoint (/api/commodities/historical/{code}). */
export interface EodhdCommodityRow {
  date: string; // "YYYY-MM-DD"
  value: number;
}

/** Raw response envelope from the commodities endpoint. */
export interface EodhdCommodityResponse {
  meta?: Record<string, unknown>;
  data: EodhdCommodityRow[];
}
