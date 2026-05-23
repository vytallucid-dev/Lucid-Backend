/**
 * Raw event shape as returned by https://nfs.faireconomy.media/ff_calendar_thisweek.json
 *
 * Notes from observed live data:
 * - `actual` field is OMITTED entirely for future (unreleased) events
 * - All numeric values come as strings with unit suffixes: "%", "K" (thousands),
 *   "M" (millions), "B" (billions), "T" (trillions). Empty value = ""
 * - `date` is ISO 8601 with timezone offset (typically -04:00 for FF servers)
 * - `country` is the currency code (USD, EUR, GBP, JPY, etc.)
 * - `impact` values seen: "High" | "Medium" | "Low" | "Holiday"
 */
export interface ForexFactoryEvent {
  title: string;
  country: string;
  date: string;
  impact: string;
  forecast: string;
  previous: string;
  actual?: string;
  url?: string;
}

export type ForexFactoryCalendarResponse = ForexFactoryEvent[];

export interface ForexFactoryFetchResult {
  events: ForexFactoryEvent[];
  fetchedAt: Date;
  requestUrl: string;
  responseSizeBytes: number;
}
