import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { cftcClient } from '@core/clients/cftc/cftc.client';
import type { CftcLegacyRow } from '@core/clients/cftc/types';
import { cotDataRepository } from '@core/repositories/cot-data.repository';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';
import {
  classifyNetPositioning,
  classifyChangePercent,
} from '@core/scoring/handlers/cot/cot-label.helpers';
import {
  computeCotDerivedFields,
  computeReleaseDate,
  parseCftcReportDate,
  safeParseInt,
} from './cftc-cot-calculations';

const JOB_NAME = 'cftc_cot_weekly_fetch';
const TRADER_CATEGORY = 'Non-Commercials';

export interface FetchCftcCotResult {
  logId: string;
  status: 'success' | 'partial' | 'failed';
  totalRowsFetched: number;
  matchedAssetsCount: number;
  unmatchedRowsCount: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsSkipped: number;
  errors: unknown[];
}

interface AssetMetadataLike {
  cotContractCode?: string;
}

function extractContractCode(metadata: Prisma.JsonValue | null): string | null {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  const cc = (metadata as AssetMetadataLike).cotContractCode;
  return typeof cc === 'string' && cc.length > 0 ? cc : null;
}

export async function fetchCftcCotData(
  triggerType: 'cron' | 'manual' | 'backfill',
  triggeredBy?: string | null,
  options?: { daysBack?: number },
): Promise<FetchCftcCotResult> {
  const daysBack = options?.daysBack ?? 60;

  const log = await dataFetchLogRepository.start({
    jobName: JOB_NAME,
    triggerType,
    triggeredBy: triggeredBy ?? null,
    metadata: { endpoint: 'legacy_futures_only', daysBack },
  });

  let totalRowsFetched = 0;
  let matchedAssetsCount = 0;
  let unmatchedRowsCount = 0;
  let rowsInserted = 0;
  let rowsUpdated = 0;
  let rowsSkipped = 0;
  const errors: unknown[] = [];

  try {
    const assets = await prisma.asset.findMany({
      where: {
        toolScope: { has: 'edgefinder' },
        metadata: { not: Prisma.JsonNull },
      },
    });

    const codeToAssetId = new Map<string, string>();
    for (const a of assets) {
      const cc = extractContractCode(a.metadata);
      if (cc) codeToAssetId.set(cc, a.id);
    }

    if (codeToAssetId.size === 0) {
      logger.warn(
        { jobName: JOB_NAME },
        'No EdgeFinder assets with cotContractCode metadata found',
      );
    }

    const fetchResult = await cftcClient.fetchRecentLegacyData({
      daysBack,
      contractCodes: Array.from(codeToAssetId.keys()),
    });
    totalRowsFetched = fetchResult.totalRowsReturned;

    for (const row of fetchResult.rows) {
      try {
        const outcome = await ingestRow(row, codeToAssetId);
        if (outcome === 'unmatched') {
          unmatchedRowsCount += 1;
        } else if (outcome === 'skipped_invalid') {
          rowsSkipped += 1;
        } else {
          matchedAssetsCount += 1;
          if (outcome === 'inserted') rowsInserted += 1;
          else if (outcome === 'revised') rowsUpdated += 1;
          else rowsSkipped += 1;
        }
      } catch (err) {
        const payload = {
          contractCode: row.cftc_contract_market_code,
          reportDate: row.report_date_as_yyyy_mm_dd,
          message: err instanceof Error ? err.message : String(err),
        };
        logger.error(payload, 'CFTC: failed to ingest row');
        errors.push(payload);
      }
    }

    const status: 'success' | 'partial' = errors.length === 0 ? 'success' : 'partial';

    await dataFetchLogRepository.complete({
      logId: log.id,
      status,
      rowsInserted,
      rowsUpdated,
      rowsSkipped,
      errors: errors.length > 0 ? (errors as unknown as object) : undefined,
      metadata: {
        endpoint: 'legacy_futures_only',
        daysBack,
        totalRowsFetched,
        matchedAssetsCount,
        unmatchedRowsCount,
        coveredContractCodes: Array.from(codeToAssetId.keys()),
      },
    });

    return {
      logId: log.id,
      status,
      totalRowsFetched,
      matchedAssetsCount,
      unmatchedRowsCount,
      rowsInserted,
      rowsUpdated,
      rowsSkipped,
      errors,
    };
  } catch (err) {
    const errorPayload = {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    };
    logger.error({ ...errorPayload, jobName: JOB_NAME }, 'CFTC weekly fetch failed');

    await dataFetchLogRepository.complete({
      logId: log.id,
      status: 'failed',
      rowsInserted,
      rowsUpdated,
      rowsSkipped,
      errors: [errorPayload] as unknown as object,
      metadata: {
        endpoint: 'legacy_futures_only',
        daysBack,
        totalRowsFetched,
        matchedAssetsCount,
        unmatchedRowsCount,
      },
    });

    return {
      logId: log.id,
      status: 'failed',
      totalRowsFetched,
      matchedAssetsCount,
      unmatchedRowsCount,
      rowsInserted,
      rowsUpdated,
      rowsSkipped,
      errors: [errorPayload],
    };
  }
}

type IngestOutcome =
  | 'inserted'
  | 'revised'
  | 'skipped'
  | 'unmatched'
  | 'skipped_invalid';

async function ingestRow(
  row: CftcLegacyRow,
  codeToAssetId: Map<string, string>,
): Promise<IngestOutcome> {
  const contractCode = row.cftc_contract_market_code;
  const assetId = codeToAssetId.get(contractCode);

  if (!assetId) {
    logger.debug(
      { contractCode, market: row.market_and_exchange_names },
      'CFTC: row contract code not in coverage set',
    );
    return 'unmatched';
  }

  const longAll = safeParseInt(row.noncomm_positions_long_all);
  const shortAll = safeParseInt(row.noncomm_positions_short_all);
  const changeLong = safeParseInt(row.change_in_noncomm_long_all);
  const changeShort = safeParseInt(row.change_in_noncomm_short_all);

  if (longAll === null || shortAll === null || changeLong === null || changeShort === null) {
    logger.warn(
      {
        contractCode,
        reportDate: row.report_date_as_yyyy_mm_dd,
        longAll,
        shortAll,
        changeLong,
        changeShort,
      },
      'CFTC: row has unparseable numeric fields — skipping',
    );
    return 'skipped_invalid';
  }

  const derived = computeCotDerivedFields(longAll, shortAll, changeLong, changeShort);
  const reportDate = parseCftcReportDate(row.report_date_as_yyyy_mm_dd);
  const releaseDate = computeReleaseDate(reportDate);
  const netPositioningLabel = classifyNetPositioning(derived.longPct);
  const changeLabel = classifyChangePercent(derived.weeklyChangePct ?? 0);

  const result = await cotDataRepository.upsert({
    assetId,
    contractCode,
    reportDate,
    releaseDate,
    traderCategory: TRADER_CATEGORY,
    longContracts: derived.longContracts,
    shortContracts: derived.shortContracts,
    longPct: derived.longPct,
    shortPct: derived.shortPct,
    changeInLongContracts: derived.changeInLongContracts,
    changeInShortContracts: derived.changeInShortContracts,
    changeInLongPct: derived.changeInLongPct,
    changeInShortPct: derived.changeInShortPct,
    weeklyChangePct: derived.weeklyChangePct,
    netPositioningLabel,
    changeLabel,
    source: 'cftc',
    rawPayload: row as unknown as Prisma.InputJsonValue,
  });

  logger.debug(
    {
      contractCode,
      reportDate: reportDate.toISOString(),
      action: result.action,
      longPct: derived.longPct,
      weeklyChangePct: derived.weeklyChangePct,
      netPositioningLabel,
      changeLabel,
    },
    'CFTC: row ingested',
  );

  return result.action;
}
