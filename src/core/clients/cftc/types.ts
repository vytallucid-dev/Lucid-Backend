/**
 * Raw row shape from CFTC Legacy Futures-only Socrata API.
 * Endpoint: https://publicreporting.cftc.gov/resource/6dca-aqww.json
 *
 * NOTE: CFTC's field names contain typos that we must preserve:
 *   - "noncomm_postions_spread_all" (should be "positions")
 *   - "change_in_noncomm_spead_all" (should be "spread")
 *
 * Numeric fields come as strings (Socrata convention). Convert with parseFloat
 * or parseInt as appropriate.
 */
export interface CftcLegacyRow {
  market_and_exchange_names: string;
  report_date_as_yyyy_mm_dd: string;
  cftc_contract_market_code: string;
  cftc_market_code?: string;
  cftc_commodity_code?: string;
  commodity_name?: string;
  open_interest_all?: string;
  noncomm_positions_long_all?: string;
  noncomm_positions_short_all?: string;
  noncomm_postions_spread_all?: string;
  comm_positions_long_all?: string;
  comm_positions_short_all?: string;
  tot_rept_positions_long_all?: string;
  tot_rept_positions_short_all?: string;
  nonrept_positions_long_all?: string;
  nonrept_positions_short_all?: string;
  change_in_open_interest_all?: string;
  change_in_noncomm_long_all?: string;
  change_in_noncomm_short_all?: string;
  change_in_noncomm_spead_all?: string;
  [key: string]: string | undefined;
}

export interface CftcFetchOptions {
  daysBack?: number;
  contractCodes?: string[];
}

export interface CftcFetchResult {
  rows: CftcLegacyRow[];
  fetchedAt: Date;
  requestUrl: string;
  totalRowsReturned: number;
}
