import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import type { DatedValue } from '../compass-staleness';

/**
 * Policy rates that arrive through the admin panel rather than from BIS.
 *
 * ── WHY THE BoE IS NOT AUTOMATED ────────────────────────────────────────────
 * BIS `WS_CBPOL` is the source for the Fed, the BoJ and the ECB, and its bulk
 * file does not carry a UK series this system reads (`BisArea` is US | JP | XM).
 * The Bank Rate changes roughly eight times a year on a published schedule, so
 * a scraper would be more moving parts, more failure modes and one more thing
 * to notice breaking — in exchange for saving eight keystrokes a year. It is
 * entered by hand through the same admin path as every other rate decision.
 *
 * ── WHAT THIS READS ─────────────────────────────────────────────────────────
 * The EdgeFinder `UK_BOE_RATE` data points, which already exist and are
 * already maintained. Since rate decisions were normalised to store levels
 * like every other indicator, `value` IS the announced Bank Rate — which is
 * what Compass needs: the anchor a 2-year yield is interpreted against. It
 * previously had to read `sourceMetadata.rate_level`, because the column held
 * a bps change.
 *
 * One entry, two consumers, no duplicate data path. Nothing is written here.
 *
 * ── STALENESS ───────────────────────────────────────────────────────────────
 * A policy rate is a step function: it is genuinely valid until the next
 * decision, so time passing is not by itself staleness. What IS staleness is a
 * meeting having happened with nothing entered. At ~8 meetings a year the gap
 * between them is around 32 trading days, so a limit past that means a decision
 * has almost certainly come and gone unrecorded. See BOE_STALE_LIMIT_DAYS.
 */

/**
 * Trading days after which a hand-entered Bank Rate reads as stale.
 *
 * ~8 meetings a year is a meeting roughly every 32 trading days. 55 is
 * comfortably past one full inter-meeting gap without tripping on a normal
 * one — a rate held through two consecutive meetings still reads fresh if both
 * were entered, and a single missed meeting shows up within weeks of the date
 * it should have been recorded.
 */
export const BOE_STALE_LIMIT_DAYS = 55;

/**
 * The `rate_level` history of a manually entered rate-decision indicator, as a
 * DatedValue series — the same shape the BIS client returns, so the readings
 * builder treats both sources identically and neither gets special-cased at
 * the point of use.
 */
export async function manualPolicyRateSeries(indicatorCode: string): Promise<DatedValue[]> {
  const indicator = await prisma.indicator.findUnique({
    where: { code: indicatorCode },
    select: { id: true },
  });
  if (!indicator) {
    logger.warn({ indicatorCode }, 'Compass readings: manual policy-rate indicator not found');
    return [];
  }

  const rows = await prisma.dataPoint.findMany({
    where: { indicatorId: indicator.id, isCurrent: true },
    orderBy: { observationDate: 'asc' },
    select: { observationDate: true, value: true },
  });

  const out: DatedValue[] = [];
  for (const r of rows) {
    if (r.value === null) continue;
    const value = Number(r.value);
    if (!Number.isFinite(value)) continue;
    out.push({ date: r.observationDate, value });
  }

  if (out.length === 0) {
    logger.warn({ indicatorCode }, 'Compass readings: manual policy-rate indicator has no history');
  }
  return out;
}
