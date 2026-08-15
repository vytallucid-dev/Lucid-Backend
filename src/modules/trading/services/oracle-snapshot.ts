// ─────────────────────────────────────────────────────────────────────────────
// Oracle score snapshots for the journal.
//
// A snapshot is the Oracle's score for an instrument ON a specific calendar
// date, read once at write time and stored. It is never looked up live and
// never recomputed: a later revision to the Oracle's own history must not
// silently rewrite what a past trade was taken against.
//
// Where no score row exists for that date — a date before scoring began, an
// instrument with no score, a gap, a non-trading day — this returns null. It
// never carries a nearby date's score forward and never fabricates a value.
//
// Instrument resolution goes through the EdgeFinder instrument registry rather
// than a list kept here, so an instrument added to the `assets` table is
// snapshot-able with no change to this file. Two score homes:
//   - forex pairs        → edgefinder_pair_scores  (score_date)
//   - everything else    → edgefinder_scorecards   (observation_date)
// ─────────────────────────────────────────────────────────────────────────────
import { prisma } from '@core/db/prisma';
import { getInstrumentRegistry } from '@modules/edgefinder/api/instrument-registry';

/** Where an entry-side score came from. Exit-side scores are always snapshots. */
export type OracleScoreSource = 'snapshot' | 'legacy' | 'manual';

export interface OracleSnapshot {
  /** The score for `date`, or null when no score row exists for it. */
  score: number | null;
  /** The UTC calendar date the score is addressed to. */
  date: Date;
  /** When this snapshot was taken. */
  capturedAt: Date;
}

/**
 * The UTC calendar date of an instant, as midnight UTC — the shape the score
 * tables' DATE columns compare against.
 *
 * UTC, not the user's clock, because it is what every other date the trading
 * serializers emit already uses (serialize.ts `ymd()`), and because the score
 * rows themselves are UTC-dated. The chosen date is stored alongside the score
 * so the UI can state which day the number belongs to rather than leaving the
 * reader to infer it from a locale-formatted timestamp.
 */
export function toScoreDate(instant: Date): Date {
  return new Date(
    Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()),
  );
}

/** True when both instants fall on the same UTC calendar date. */
export function sameScoreDate(a: Date | null | undefined, b: Date | null | undefined): boolean {
  if (!a || !b) return a == null && b == null;
  return toScoreDate(a).getTime() === toScoreDate(b).getTime();
}

/**
 * The Oracle score for a journal instrument on a given calendar date, or null.
 *
 * `symbol` is a journal pair symbol (trades.pair) — EURUSD, XAUUSD, NAS100.
 * That value is the asset's own `code`, which is what both score tables key
 * off; the public "Gold" scorecard key is an API-surface alias and is
 * deliberately not involved here.
 */
export async function oracleScoreOn(symbol: string, date: Date): Promise<number | null> {
  const scoreDate = toScoreDate(date);
  const registry = await getInstrumentRegistry();

  const instrument = registry.byCode.get(symbol);
  // Not an EdgeFinder-scoped instrument at all (a pair the user invented in
  // the Trading Hub, say). No score can exist — null, not an error.
  if (!instrument) return null;

  const asset = await prisma.asset.findFirst({ where: { code: instrument.code }, select: { id: true } });
  if (!asset) return null;

  if (instrument.assetClass === 'forex_pair') {
    const row = await prisma.edgefinderPairScore.findFirst({
      where: { pairId: asset.id, isCurrent: true, scoreDate },
      orderBy: { vintageDate: 'desc' },
      select: { totalScore: true },
    });
    return row ? row.totalScore : null;
  }

  // Non-FX: the asset scorecard, but only for assets that actually carry one
  // (hasMapRows). DXY, for instance, is EdgeFinder-scoped yet holds no map
  // rows — it is a Compass input, not a scored subject.
  if (!instrument.hasMapRows) return null;
  const row = await prisma.edgefinderScorecard.findFirst({
    where: { assetId: asset.id, isCurrent: true, observationDate: scoreDate },
    orderBy: { vintageDate: 'desc' },
    select: { totalScore: true },
  });
  return row ? row.totalScore : null;
}

/** `oracleScoreOn`, packaged with the date it addressed and the capture time. */
export async function snapshotOracleScore(symbol: string, date: Date): Promise<OracleSnapshot> {
  return {
    score: await oracleScoreOn(symbol, date),
    date: toScoreDate(date),
    capturedAt: new Date(),
  };
}
