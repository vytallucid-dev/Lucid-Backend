/**
 * FRED API response types.
 * Reference: https://fred.stlouisfed.org/docs/api/fred/series_observations.html
 */

export interface FredObservation {
  realtime_start: string; // ISO date "YYYY-MM-DD"
  realtime_end: string;
  date: string; // observation date "YYYY-MM-DD"
  value: string; // FRED returns values as strings; can be "." for missing
}

export interface FredObservationsResponse {
  realtime_start: string;
  realtime_end: string;
  observation_start: string;
  observation_end: string;
  units: string;
  output_type: number;
  file_type: string;
  order_by: string;
  sort_order: string;
  count: number;
  offset: number;
  limit: number;
  observations: FredObservation[];
}

export interface FredFetchOptions {
  seriesId: string;
  observationStart?: string; // ISO date
  observationEnd?: string; // ISO date
  limit?: number; // default 100000 (effectively all)
}

export interface FredFetchResult {
  seriesId: string;
  observations: FredObservation[];
  requestUrl: string;
  fetchedAt: Date;
}
