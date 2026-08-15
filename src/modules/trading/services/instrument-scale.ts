// ─────────────────────────────────────────────────────────────────────────────
// How an instrument's price distance is measured.
//
// Forex pairs are quoted in PIPS — 0.0001 of the quote currency, or 0.01 when
// the quote side is JPY. Everything else the journal trades — indices, metals —
// is quoted in whole POINTS: buying an index at 4500 and selling at 4600 is
// 100 points, not 1,000,000 of anything.
//
// The distinction is a property of the instrument, so it is read from the asset
// registry's assetClass rather than from a list of index symbols kept here. An
// index added to the assets table later is scaled correctly with no edit to
// this file.
// ─────────────────────────────────────────────────────────────────────────────
import { getInstrumentRegistry } from '@modules/edgefinder/api/instrument-registry';

/**
 * True when `symbol` is a forex pair, and therefore quoted in pips.
 *
 * Registry-first. A symbol the registry does not know — a pair invented in the
 * Trading Hub that has no asset row — falls back to the shape of the symbol:
 * six letters split into two halves that are BOTH currencies the registry does
 * know. Requiring both halves is what keeps XAUUSD out of the forex branch if
 * it ever loses its asset row: USD is a currency, XAU is not.
 */
export async function isForexPairSymbol(symbol: string): Promise<boolean> {
  const code = symbol.toUpperCase();
  const registry = await getInstrumentRegistry();

  const known = registry.byCode.get(code);
  if (known) return known.assetClass === 'forex_pair';

  if (code.length !== 6) return false;
  const isCurrency = (c: string): boolean =>
    registry.byCode.get(c)?.assetClass === 'currency';
  return isCurrency(code.slice(0, 3)) && isCurrency(code.slice(3));
}
