/**
 * EdgeFinder instrument registry — Phase 3.
 *
 * The API layer used to enumerate instruments in six hardcoded places
 * (ORACLE_ASSETS, COT_ASSETS, SCORECARD_KEY_TO_ASSET_CODE, SCORECARD_ASSET_META,
 * FX_PAIR_META, plus zod enums on every route). An asset row missing from any
 * one of them computed correctly in the database and appeared nowhere.
 *
 * Everything now derives from the `assets` table through the single filter:
 *
 *     isActive = true
 *   AND toolScope contains 'edgefinder'
 *   AND (has >= 1 asset_indicator_map row  |  is a forex_pair)
 *
 * The map-row requirement is what makes an asset scoreable; FX pairs are the
 * exception because their score lives in edgefinder_pair_scores rather than in
 * a scorecard. That filter excludes, automatically and without naming them:
 *   - SPY / NAS100 / US30 — mapped but isActive=false until Phase 4.
 *   - DXY — active and EdgeFinder-scoped but holds no map rows (Compass input).
 *
 * Display metadata (flag, name, ordering, the Gold key alias) lives in
 * Asset.metadata.display, seeded as DATA. Pair display is derived from the two
 * currency assets, so a new pair needs no display data at all.
 */
import { prisma } from '@core/db/prisma';
import { AppError } from '@core/middleware/error-handler';

export type InstrumentKind = 'Forex' | 'Commodity' | 'Index' | 'Currency';

export interface Instrument {
  /** asset.code — the DB identity. */
  code: string;
  assetClass: string;
  /** Public key used on the scorecard/history endpoints ('Gold' for XAUUSD). */
  key: string;
  /** Screener/COT flag. Pairs concatenate their two currencies' flags. */
  flag: string;
  /** COT-page flag; falls back to `flag`. */
  cotFlag: string;
  /** Screener display name — 'EUR/USD', 'Gold'. */
  name: string;
  /** Scorecard display name — 'US Dollar', 'Gold (XAUUSD)'. */
  scorecardName: string;
  /** Scorecard flag; falls back to `flag`. */
  scorecardFlag: string;
  type: InstrumentKind;
  base: string | null;
  quote: string | null;
  cotContractCode: string | null;
  hasMapRows: boolean;
  screenerOrder: number;
  cotOrder: number;
}

export interface InstrumentRegistry {
  /** Every in-scope instrument, keyed by asset code. */
  byCode: Map<string, Instrument>;
  /** Rows of the Top-Setups screener: tradeable instruments, never currencies. */
  screener: Instrument[];
  /** Assets with their own scorecard (currencies + Gold), keyed by public key. */
  scorecardByKey: Map<string, Instrument>;
  /** FX pairs, keyed by pair code. */
  pairs: Map<string, Instrument>;
  /** Assets shown on the COT page — active AND holding a contract code. */
  cot: Instrument[];
}

interface DisplayMeta {
  flag?: string;
  cotFlag?: string;
  name?: string;
  type?: InstrumentKind;
  scorecardKey?: string;
  scorecardName?: string;
  screenerOrder?: number;
  cotOrder?: number;
}

function readDisplay(metadata: unknown): DisplayMeta {
  if (!metadata || typeof metadata !== 'object') return {};
  const d = (metadata as Record<string, unknown>).display;
  return d && typeof d === 'object' ? (d as DisplayMeta) : {};
}

function readString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const v = (metadata as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
}

function defaultKind(assetClass: string): InstrumentKind {
  switch (assetClass) {
    case 'forex_pair': return 'Forex';
    case 'commodity': return 'Commodity';
    case 'index': return 'Index';
    default: return 'Currency';
  }
}

// ─── In-process cache ─────────────────────────────────────────────────────────
//
// The asset list changes roughly never but these endpoints are read-heavy, so
// the registry is built once and reused. No caching library is introduced: this
// mirrors the plain module-level cache the HTTP clients already use for their
// daily call counters. A short TTL bounds staleness after a seed run, and
// invalidateInstrumentRegistry() gives an explicit escape hatch (used by tests
// and available to any admin write that changes the asset table).

const CACHE_TTL_MS = 5 * 60 * 1000;
let cached: { at: number; registry: InstrumentRegistry } | null = null;

export function invalidateInstrumentRegistry(): void {
  cached = null;
}

async function build(): Promise<InstrumentRegistry> {
  const assets = await prisma.asset.findMany({
    where: {
      isActive: true,
      toolScope: { has: 'edgefinder' },
      OR: [{ indicatorMaps: { some: {} } }, { assetClass: 'forex_pair' }],
    },
    select: {
      code: true,
      name: true,
      assetClass: true,
      metadata: true,
      _count: { select: { indicatorMaps: true } },
    },
    orderBy: { code: 'asc' },
  });

  // First pass: currencies and non-pairs, so pair display can reference them.
  const byCode = new Map<string, Instrument>();
  const flagOf = new Map<string, string>();

  for (const a of assets) {
    if (a.assetClass === 'forex_pair') continue;
    const d = readDisplay(a.metadata);
    const flag = d.flag ?? '';
    flagOf.set(a.code, flag);
    byCode.set(a.code, {
      code: a.code,
      assetClass: a.assetClass,
      key: d.scorecardKey ?? a.code,
      flag,
      cotFlag: d.cotFlag ?? flag,
      name: d.name ?? a.name,
      scorecardName: d.scorecardName ?? d.name ?? a.name,
      scorecardFlag: d.flag ?? '',
      type: d.type ?? defaultKind(a.assetClass),
      base: null,
      quote: null,
      cotContractCode: readString(a.metadata, 'cotContractCode'),
      hasMapRows: a._count.indicatorMaps > 0,
      screenerOrder: d.screenerOrder ?? Number.MAX_SAFE_INTEGER,
      cotOrder: d.cotOrder ?? Number.MAX_SAFE_INTEGER,
    });
  }

  for (const a of assets) {
    if (a.assetClass !== 'forex_pair') continue;
    const d = readDisplay(a.metadata);
    const base = readString(a.metadata, 'base');
    const quote = readString(a.metadata, 'quote');
    if (!base || !quote) {
      throw new AppError(
        500,
        `Pair asset ${a.code} is missing base/quote in metadata — refusing to infer them from the code.`,
        'PAIR_METADATA_INCOMPLETE',
      );
    }
    // Pair display derives entirely from its two currencies, so a new pair
    // needs no display metadata beyond its ordering.
    const flag = `${flagOf.get(base) ?? ''}${flagOf.get(quote) ?? ''}`;
    byCode.set(a.code, {
      code: a.code,
      assetClass: a.assetClass,
      key: a.code,
      flag,
      cotFlag: flag,
      name: `${base}/${quote}`,
      scorecardName: `${base} / ${quote}`,
      scorecardFlag: flag,
      type: 'Forex',
      base,
      quote,
      cotContractCode: readString(a.metadata, 'cotContractCode'),
      hasMapRows: a._count.indicatorMaps > 0,
      screenerOrder: d.screenerOrder ?? Number.MAX_SAFE_INTEGER,
      cotOrder: d.cotOrder ?? Number.MAX_SAFE_INTEGER,
    });
  }

  const all = [...byCode.values()];
  const bySort = (a: Instrument, b: Instrument, k: 'screenerOrder' | 'cotOrder'): number =>
    a[k] - b[k] || a.code.localeCompare(b.code);

  return {
    byCode,
    // Currencies are not screener rows — they are scorecard subjects.
    screener: all
      .filter((i) => i.assetClass !== 'currency')
      .sort((a, b) => bySort(a, b, 'screenerOrder')),
    scorecardByKey: new Map(all.filter((i) => i.hasMapRows).map((i) => [i.key, i])),
    pairs: new Map(all.filter((i) => i.assetClass === 'forex_pair').map((i) => [i.code, i])),
    cot: all
      .filter((i) => i.cotContractCode !== null && i.assetClass !== 'forex_pair')
      .sort((a, b) => bySort(a, b, 'cotOrder')),
  };
}

export async function getInstrumentRegistry(): Promise<InstrumentRegistry> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.registry;
  const registry = await build();
  cached = { at: Date.now(), registry };
  return registry;
}

// ─── Runtime validation (replaces the zod enums) ──────────────────────────────

/** Resolve a scorecard subject key ('USD', 'Gold', 'AUD'), or 400 naming it. */
export async function requireScorecardAsset(key: string): Promise<Instrument> {
  const reg = await getInstrumentRegistry();
  const found = reg.scorecardByKey.get(key);
  if (!found) {
    throw new AppError(
      400,
      `Unknown asset: ${key}. Valid assets: ${[...reg.scorecardByKey.keys()].sort().join(', ')}`,
      'UNKNOWN_ASSET',
    );
  }
  return found;
}

/** Resolve an FX pair code, or 400 naming it. */
export async function requirePair(code: string): Promise<Instrument> {
  const reg = await getInstrumentRegistry();
  const found = reg.pairs.get(code);
  if (!found) {
    throw new AppError(
      400,
      `Unknown pair: ${code}. Valid pairs: ${[...reg.pairs.keys()].sort().join(', ')}`,
      'UNKNOWN_PAIR',
    );
  }
  return found;
}

/** Resolve any score-history subject — an asset key or a pair code — or 400. */
export async function requireScoreSubject(
  subject: string,
): Promise<{ instrument: Instrument; isPair: boolean }> {
  const reg = await getInstrumentRegistry();
  const pair = reg.pairs.get(subject);
  if (pair) return { instrument: pair, isPair: true };
  const asset = reg.scorecardByKey.get(subject);
  if (asset) return { instrument: asset, isPair: false };
  throw new AppError(
    400,
    `Unknown subject: ${subject}. Valid subjects: ${[
      ...reg.scorecardByKey.keys(),
      ...reg.pairs.keys(),
    ].sort().join(', ')}`,
    'UNKNOWN_SUBJECT',
  );
}

/** Resolve a COT subject key, or 400 naming it. */
export async function requireCotAsset(key: string): Promise<Instrument> {
  const reg = await getInstrumentRegistry();
  const found = reg.cot.find((i) => i.key === key || i.code === key);
  if (!found) {
    throw new AppError(
      400,
      `Unknown COT asset: ${key}. Valid COT assets: ${reg.cot.map((i) => i.key).sort().join(', ')}`,
      'UNKNOWN_COT_ASSET',
    );
  }
  return found;
}
