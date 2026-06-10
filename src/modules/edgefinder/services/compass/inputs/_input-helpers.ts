export function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

/** Format a Date as a "YYYY-MM-DD" string (the shape EODHD's `from` param and
 *  EodhdDataPoint.date both use). */
export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
