/**
 * Replay series helpers — production port of the Phase B harness, archived
 * outside this repo in Lucid-Research/research/phase-b/replay/series.ts.
 *
 * The research original loaded every series from a CSV under
 * the archived research data set. Production fetches instead (see
 * `replay-sources.service.ts`), so all the file-reading is gone and what remains
 * is the pure date/series arithmetic the engine needs.
 *
 * ONE DELIBERATE BEHAVIOUR CHANGE. The research `generateTradingDays` was a
 * verbatim copy of the old weekday-only filter. This re-exports the real,
 * holiday-aware US market calendar instead, because the live classifier now
 * refuses to score on a closed market. If the replay kept the weekday rule, the
 * replay and the live path would disagree by construction on every market
 * holiday — and reproducing live scoring exactly is the whole point of the
 * harness. Results therefore differ slightly from the Phase B published figures
 * on windows containing holidays; that difference is an improvement, and it is
 * reported rather than hidden.
 */
export { generateTradingDays } from '@core/utils/us-market-calendar';

export interface DatedValue {
  date: Date;
  value: number;
}

export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function parseUtc(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Inclusive slice of an ascending series. */
export function slice(s: DatedValue[], from: Date, to: Date): DatedValue[] {
  const f = from.getTime();
  const t = to.getTime();
  return s.filter((o) => o.date.getTime() >= f && o.date.getTime() <= t);
}

export function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}
