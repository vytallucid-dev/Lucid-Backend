/// <reference types="node" />
/* eslint-disable no-console */

/**
 * DXY clean cutover: FRED broad-index → EODHD ICE DXY.
 *
 * The existing IND_NIFTY_10_DXY data points are FRED broad-index scale (~118).
 * EODHD DXY (DXY.INDX) is ICE scale (~98). Mixing the two in the 10-day rolling
 * window would corrupt the % change calc, so this does a CLEAN cutover:
 *
 *   1. Fetch fresh EODHD DXY history (~45 days — ample for the 10-day window).
 *   2. Hard-delete ALL existing DXY data points (and their scores, which FK to
 *      them — they are recomputed by the scorecard assembly cron).
 *   3. Re-insert the EODHD points as fresh, current data points (source 'eodhd').
 *
 * The EODHD fetch runs BEFORE the delete so a failed/empty fetch never destroys
 * existing data. Run ONCE, manually, after deploy (and after the migrations that
 * add the 'eodhd' enum value + flip the indicator's data_source):
 *
 *   npm run cutover:dxy
 *
 * Idempotent enough to re-run: it always clears then re-backfills DXY.
 *
 * Only DXY needs this. Brent and USD/INR keep their history (same scale before
 * and after the EODHD switch).
 */

import { prisma, disconnectDatabase } from '@core/db/prisma';
import { eodhdClient } from '@core/clients/eodhd/eodhd.client';
import { dataPointsRepository } from '@core/repositories/data-points.repository';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';

const INDICATOR_CODE = 'IND_NIFTY_10_DXY';
const EODHD_SYMBOL = 'DXY.INDX';
const BACKFILL_DAYS = 45; // ~31 trading days — comfortably covers the 10-day window

function fromDateIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  console.log(`\n=== DXY cutover (FRED broad-index → EODHD ICE) ===\n`);

  const indicator = await prisma.indicator.findUnique({
    where: { code: INDICATOR_CODE },
    select: { id: true, code: true, dataSource: true, sourceSeriesId: true },
  });

  if (!indicator) {
    throw new Error(
      `Indicator ${INDICATOR_CODE} not found. Run the seed first.`,
    );
  }
  if (indicator.dataSource !== 'eodhd') {
    throw new Error(
      `Indicator ${INDICATOR_CODE} has data_source='${indicator.dataSource}', expected 'eodhd'. ` +
        `Apply the migrations (prisma migrate deploy) before running the cutover.`,
    );
  }

  // 1. Fetch fresh EODHD history FIRST — never delete before we have replacement data.
  const fromIso = fromDateIso(BACKFILL_DAYS);
  console.log(`Fetching ${EODHD_SYMBOL} from EODHD (from=${fromIso})...`);
  const points = await eodhdClient.fetchEodSeries(EODHD_SYMBOL, fromIso);

  if (points.length === 0) {
    throw new Error(
      `EODHD returned 0 points for ${EODHD_SYMBOL}. Aborting WITHOUT deleting existing data.`,
    );
  }
  console.log(
    `Received ${points.length} points (${points[0].date} → ${points[points.length - 1].date}).`,
  );

  // Traceability row for the inserted points' fetched_via.
  const log = await dataFetchLogRepository.start({
    jobName: 'cutover_dxy_eodhd',
    triggerType: 'backfill',
    triggeredBy: null,
    metadata: { indicatorCode: indicator.code, symbol: EODHD_SYMBOL, from: fromIso },
  });

  try {
    // 2. Hard-delete existing scores (FK to data points) then the data points.
    const deletedScores = await prisma.score.deleteMany({
      where: { indicatorId: indicator.id },
    });
    const deletedPoints = await prisma.dataPoint.deleteMany({
      where: { indicatorId: indicator.id },
    });
    console.log(
      `Deleted ${deletedPoints.count} data points and ${deletedScores.count} dependent scores.`,
    );

    // 3. Insert the EODHD points as fresh, current data points (chaining previous_value).
    let inserted = 0;
    let skipped = 0;
    let lastSeenValue: number | null = null;

    for (const point of points) {
      if (!Number.isFinite(point.value)) {
        skipped += 1;
        continue;
      }
      const observationDate = new Date(`${point.date}T00:00:00.000Z`);
      const result = await dataPointsRepository.upsert({
        indicatorId: indicator.id,
        observationDate,
        value: point.value,
        forecastValue: null,
        previousValue: lastSeenValue,
        source: 'eodhd',
        sourceMetadata: { provider: 'eodhd', symbol: EODHD_SYMBOL, endpoint: 'eod', cutover: true },
        fetchedVia: log.id,
      });
      if (result.action === 'skipped') skipped += 1;
      else inserted += 1;
      lastSeenValue = point.value;
    }

    await dataFetchLogRepository.complete({
      logId: log.id,
      status: 'success',
      rowsInserted: inserted,
      rowsUpdated: 0,
      rowsSkipped: skipped + deletedPoints.count, // record what was cleared for audit
      metadata: {
        indicatorCode: indicator.code,
        symbol: EODHD_SYMBOL,
        from: fromIso,
        deletedDataPoints: deletedPoints.count,
        deletedScores: deletedScores.count,
        inserted,
        skipped,
      },
    });

    console.log(`\n✅ Cutover complete: inserted ${inserted} fresh EODHD points (skipped ${skipped}).`);
    console.log(`   Scores will be recomputed on the next scorecard assembly run.\n`);
  } catch (err) {
    await dataFetchLogRepository.complete({
      logId: log.id,
      status: 'failed',
      errors: [
        { message: err instanceof Error ? err.message : String(err) },
      ] as unknown as object,
    });
    throw err;
  }
}

main()
  .then(async () => {
    await disconnectDatabase();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\n❌ DXY cutover failed:', err instanceof Error ? err.message : err);
    await disconnectDatabase();
    process.exit(1);
  });
