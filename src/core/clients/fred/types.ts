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

  /**
   * ALFRED real-time (vintage) bounds. Phase C.
   *
   * `observation_end` alone bounds WHICH OBSERVATION DATES come back; it does
   * NOT bound what was KNOWN on a given day. Two distinct biases follow from
   * omitting these:
   *
   *   1. Revision bias — FRED serves the latest revised value of every
   *      observation, not the value as first published.
   *   2. Publication-lag bias, the larger of the two — an observation DATED
   *      2008-09-01 was not published until mid-October 2008, but a filter of
   *      `obs.date <= 2008-09-02` admits it six weeks early.
   *
   * Setting realtimeStart == realtimeEnd == some past date D makes FRED serve
   * the ALFRED vintage as of D: the data exactly as it was actually known then.
   *
   * Both are OPTIONAL and are only appended to the request when supplied, so
   * every existing caller (NIFTY's fred-indicator.service, EdgeFinder macro)
   * is byte-for-byte unaffected.
   */
  realtimeStart?: string; // ISO date
  realtimeEnd?: string; // ISO date
}

export interface FredFetchResult {
  seriesId: string;
  observations: FredObservation[];
  requestUrl: string;
  fetchedAt: Date;
}
