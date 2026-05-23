/**
 * Forex Factory publishes numeric values as strings with unit suffixes.
 * This parser converts them to plain numbers for storage.
 *
 * Examples seen in real data:
 *   "3.7%"     → 3.7
 *   "-0.5%"    → -0.5
 *   "25.9K"    → 25.9
 *   "82.4B"    → 82.4
 *   "1.38M"    → 1.38
 *   "-0.23T"   → -0.23
 *   ""         → null
 *   "5.25%|3.5" → 5.25 (auction format: rate|bid-to-cover; we take the rate)
 *
 * The magnitude unit (K/M/B/T) is implicit per indicator and cancels out in
 * the actual-vs-forecast comparison (FF uses consistent units within an
 * indicator's history). The original raw string is preserved in
 * source_metadata for debugging.
 */
export function parseForexFactoryValue(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null || raw === '') return null;

  const value = raw.includes('|') ? raw.split('|')[0] : raw;

  const stripped = value.replace(/[%KMBT]$/, '').trim();
  if (stripped === '') return null;

  const parsed = Number(stripped);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}
