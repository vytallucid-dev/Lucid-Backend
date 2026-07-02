import { Indicator, Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { AppError } from '@core/middleware/error-handler';
import { nseClient } from '@core/clients/nse/nse.client';
import { NseFiiDiiResponse, NseFiiDiiRow } from '@core/clients/nse/types';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';

const FII_FLOW_INDICATOR_CODE = 'IND_NIFTY_06_FII_FLOW';
const DII_ABSORPTION_INDICATOR_CODE = 'IND_NIFTY_07_DII_ABSORPTION';
const DII_FLOW_INDICATOR_CODE = 'IND_NIFTY_14_DII_FLOW';
const FII_DII_PATH = '/api/fiidiiTradeReact';

export interface ScrapeNseFiiDiiParams {
  triggerType: 'cron' | 'manual' | 'backfill';
  triggeredBy?: string | null;
}

export interface FiiDiiUpsertResult {
  indicatorCode: string;
  action: 'inserted' | 'revised' | 'skipped';
  value: number;
}

export interface ScrapeNseFiiDiiResult {
  logId: string;
  status: 'success' | 'failed';
  observationDate: string | null;
  fii: FiiDiiUpsertResult | null;
  dii: FiiDiiUpsertResult | null;
  diiFlow: FiiDiiUpsertResult | null;
  errors?: unknown[];
}

const NSE_MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

function parseNseDate(dateStr: string): Date {
  const segments = dateStr.split('-');
  if (segments.length !== 3) {
    throw new AppError(
      502,
      `NSE FII/DII date format unexpected: ${dateStr}`,
      'NSE_DATE_PARSE_FAILED',
      { dateStr },
    );
  }
  const [day, monthStr, year] = segments;
  const month = NSE_MONTHS[monthStr];
  if (month === undefined || !/^\d+$/.test(day) || !/^\d{4}$/.test(year)) {
    throw new AppError(
      502,
      `NSE FII/DII date format unexpected: ${dateStr}`,
      'NSE_DATE_PARSE_FAILED',
      { dateStr },
    );
  }
  return new Date(Date.UTC(Number(year), month, Number(day)));
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseCroreValue(raw: string, fieldName: string): number {
  const cleaned = raw.replace(/,/g, '').trim();
  const num = parseFloat(cleaned);
  if (!Number.isFinite(num)) {
    throw new AppError(
      502,
      `NSE FII/DII ${fieldName} not a finite number: '${raw}'`,
      'NSE_VALUE_PARSE_FAILED',
      { fieldName, raw },
    );
  }
  return num;
}

function findRow(
  rows: NseFiiDiiRow[],
  matcher: (cat: string) => boolean,
  label: string,
): NseFiiDiiRow {
  const row = rows.find((r) => matcher(r.category?.toUpperCase().replace(/\*/g, '').trim() ?? ''));
  if (!row) {
    throw new AppError(
      502,
      `${label} row not found in NSE FII/DII response`,
      'NSE_FIIDII_ROW_MISSING',
      { label, availableCategories: rows.map((r) => r.category) },
    );
  }
  return row;
}

async function loadIndicators(): Promise<{
  fiiInd: Indicator;
  diiInd: Indicator;
  diiFlowInd: Indicator;
}> {
  const fiiInd = await prisma.indicator.findUnique({
    where: { code: FII_FLOW_INDICATOR_CODE },
  });
  const diiInd = await prisma.indicator.findUnique({
    where: { code: DII_ABSORPTION_INDICATOR_CODE },
  });
  const diiFlowInd = await prisma.indicator.findUnique({
    where: { code: DII_FLOW_INDICATOR_CODE },
  });

  if (!fiiInd) {
    throw new AppError(
      404,
      `Indicator not found: ${FII_FLOW_INDICATOR_CODE}`,
      'INDICATOR_NOT_FOUND',
    );
  }
  if (!diiInd) {
    throw new AppError(
      404,
      `Indicator not found: ${DII_ABSORPTION_INDICATOR_CODE}`,
      'INDICATOR_NOT_FOUND',
    );
  }
  if (!diiFlowInd) {
    throw new AppError(
      404,
      `Indicator not found: ${DII_FLOW_INDICATOR_CODE}`,
      'INDICATOR_NOT_FOUND',
    );
  }
  if (fiiInd.dataSource !== 'nse_scrape') {
    throw new AppError(
      400,
      `${FII_FLOW_INDICATOR_CODE} expected data_source=nse_scrape, got ${fiiInd.dataSource}`,
      'INVALID_DATA_SOURCE',
    );
  }
  if (diiInd.dataSource !== 'derived') {
    throw new AppError(
      400,
      `${DII_ABSORPTION_INDICATOR_CODE} expected data_source=derived, got ${diiInd.dataSource}`,
      'INVALID_DATA_SOURCE',
    );
  }
  if (diiFlowInd.dataSource !== 'nse_scrape') {
    throw new AppError(
      400,
      `${DII_FLOW_INDICATOR_CODE} expected data_source=nse_scrape, got ${diiFlowInd.dataSource}`,
      'INVALID_DATA_SOURCE',
    );
  }
  return { fiiInd, diiInd, diiFlowInd };
}

/**
 * Atomic three-upsert transaction with vintage-aware logic.
 * Replicates dataPointsRepository.upsert behaviour but for three rows in one txn:
 *   Ind 6  (FII net flow)      — every day, source nse_scrape
 *   Ind 7  (DII absorption)    — every day, source derived (0 on FII-buyer days)
 *   Ind 14 (DII net flow)      — every day, source nse_scrape (display-only)
 */
async function persistFiiDii(
  fiiInd: Indicator,
  diiInd: Indicator,
  diiFlowInd: Indicator,
  observationDate: Date,
  fiiNet: number,
  diiAbsorption: number,
  diiNet: number,
  diiBuy: number,
  diiSell: number,
  fiiSell: number,
  fiiWasNetSeller: boolean,
  fiiRow: NseFiiDiiRow,
  diiRow: NseFiiDiiRow,
  logId: string,
): Promise<{
  fii: FiiDiiUpsertResult;
  dii: FiiDiiUpsertResult;
  diiFlow: FiiDiiUpsertResult;
}> {
  return prisma.$transaction(async (tx) => {
    const handle = async (
      indicatorId: string,
      indicatorCode: string,
      value: number,
      source: 'nse_scrape' | 'derived',
      sourceMetadata: Prisma.InputJsonValue,
    ): Promise<FiiDiiUpsertResult> => {
      const incoming = new Prisma.Decimal(value);
      const existing = await tx.dataPoint.findFirst({
        where: { indicatorId, observationDate, isCurrent: true },
      });

      if (existing) {
        const existingDecimal = new Prisma.Decimal(existing.value.toString());
        if (existingDecimal.equals(incoming)) {
          return { indicatorCode, action: 'skipped', value };
        }
        await tx.dataPoint.update({
          where: { id: existing.id },
          data: { isCurrent: false },
        });
        await tx.dataPoint.create({
          data: {
            indicatorId,
            observationDate,
            value: incoming,
            isCurrent: true,
            source,
            sourceMetadata,
            fetchedVia: logId,
            dataQualityFlag: 'revised',
          },
        });
        return { indicatorCode, action: 'revised', value };
      }

      await tx.dataPoint.create({
        data: {
          indicatorId,
          observationDate,
          value: incoming,
          isCurrent: true,
          source,
          sourceMetadata,
          fetchedVia: logId,
        },
      });
      return { indicatorCode, action: 'inserted', value };
    };

    const fiiResult = await handle(fiiInd.id, fiiInd.code, fiiNet, 'nse_scrape', {
      endpoint: FII_DII_PATH,
      category: fiiRow.category,
      buyValue: fiiRow.buyValue,
      sellValue: fiiRow.sellValue,
      netValue: fiiRow.netValue,
      rawDate: fiiRow.date,
    });

    // Ind 7 — DII absorption. Stored EVERY day now (never null):
    //   FII net seller → ratio = dii_net / abs(fii_sell), fii_was_net_seller = true.
    //   FII net buyer  → 0 (nothing to absorb), fii_was_net_seller = false.
    // The rolling_ratio_excluding handler averages ONLY fii_was_net_seller === true
    // days, so the buyer-day 0s are display-only and never enter the rolling average.
    const diiResult = await handle(diiInd.id, diiInd.code, diiAbsorption, 'derived', {
      formula: 'dii_net / abs(fii_sell)',
      fii_was_net_seller: fiiWasNetSeller,
      dii_net_crore: diiNet,
      dii_buy_crore: diiBuy,
      dii_sell_crore: diiSell,
      fii_sell_crore: fiiSell,
      derivedFrom: FII_FLOW_INDICATOR_CODE,
    });

    // Ind 14 — DII net flow (display-only, NOT scored). Written unconditionally on
    // EVERY day, mirroring Ind 6 (FII net flow). value = diiNet (signed).
    const diiFlowResult = await handle(diiFlowInd.id, diiFlowInd.code, diiNet, 'nse_scrape', {
      endpoint: FII_DII_PATH,
      category: diiRow.category,
      dii_buy_crore: diiBuy,
      dii_sell_crore: diiSell,
      dii_net_crore: diiNet,
      rawDate: diiRow.date,
    });

    return { fii: fiiResult, dii: diiResult, diiFlow: diiFlowResult };
  });
}

/**
 * Scrape FII/DII cash flow data from NSE, upsert Ind 6 (FII net flow) and
 * Ind 7 (DII absorption ratio) in a single transaction. All-or-nothing.
 */
export async function scrapeNseFiiDii(
  params: ScrapeNseFiiDiiParams,
): Promise<ScrapeNseFiiDiiResult> {
  const { fiiInd, diiInd, diiFlowInd } = await loadIndicators();

  const log = await dataFetchLogRepository.start({
    jobName: 'scrape_nse_fii_dii',
    triggerType: params.triggerType,
    triggeredBy: params.triggeredBy ?? null,
    metadata: {
      endpoint: FII_DII_PATH,
      indicatorCodes: [
        FII_FLOW_INDICATOR_CODE,
        DII_ABSORPTION_INDICATOR_CODE,
        DII_FLOW_INDICATOR_CODE,
      ],
    },
  });

  try {
    const response = await nseClient.get<NseFiiDiiResponse>(FII_DII_PATH);

    if (!Array.isArray(response)) {
      throw new AppError(502, 'NSE FII/DII response is not an array', 'NSE_INVALID_RESPONSE', {
        responsePreview: JSON.stringify(response).slice(0, 200),
      });
    }

    if (response.length === 0) {
      throw new AppError(
        502,
        'NSE FII/DII response is empty (possible holiday or pre-publication)',
        'NSE_FIIDII_EMPTY',
      );
    }

    const fiiRow = findRow(
      response,
      (cat) => cat.includes('FII') || cat.includes('FPI'),
      'FII/FPI',
    );
    const diiRow = findRow(response, (cat) => cat.includes('DII'), 'DII');

    if (fiiRow.date !== diiRow.date) {
      logger.warn(
        { fiiDate: fiiRow.date, diiDate: diiRow.date },
        'NSE FII/DII: FII and DII dates differ — using FII date',
      );
    }

    const observationDate = parseNseDate(fiiRow.date);

    const fiiNet = parseCroreValue(fiiRow.netValue, 'fii.netValue');
    const diiBuy = parseCroreValue(diiRow.buyValue, 'dii.buyValue');
    const diiSell = parseCroreValue(diiRow.sellValue, 'dii.sellValue');
    // Use NSE's own precomputed DII net (buy − sell) directly — avoids rounding
    // drift from recomputing buy−sell ourselves.
    const diiNet = parseCroreValue(diiRow.netValue, 'dii.netValue');
    const fiiSell = parseCroreValue(fiiRow.sellValue, 'fii.sellValue');

    const fiiWasNetSeller = fiiNet < 0;

    // Absorption numerator is DII NET (buy − sell), NOT gross buy. Two regimes:
    //   Situation A — FII net seller: ratio = diiNet / abs(fiiSell). Scoreable.
    //     diiNet may be negative (DII also net selling → "both fleeing").
    //   Situation B — FII net buyer: nothing to absorb → absorption = 0 (a real
    //     stored value, not null). Display/series-completeness only; excluded from
    //     the rolling average via fii_was_net_seller = false.
    let diiAbsorption: number;
    if (fiiWasNetSeller) {
      if (Math.abs(fiiSell) < 0.01) {
        throw new AppError(
          502,
          'FII sell value too small to compute absorption ratio',
          'INVALID_FIIDII_INPUTS',
          { fiiSell },
        );
      }
      diiAbsorption = diiNet / Math.abs(fiiSell);
    } else {
      diiAbsorption = 0;
    }

    const persisted = await persistFiiDii(
      fiiInd,
      diiInd,
      diiFlowInd,
      observationDate,
      fiiNet,
      diiAbsorption,
      diiNet,
      diiBuy,
      diiSell,
      fiiSell,
      fiiWasNetSeller,
      fiiRow,
      diiRow,
      log.id,
    );

    const totalInserted =
      (persisted.fii.action === 'inserted' ? 1 : 0) +
      (persisted.dii.action === 'inserted' ? 1 : 0) +
      (persisted.diiFlow.action === 'inserted' ? 1 : 0);
    const totalRevised =
      (persisted.fii.action === 'revised' ? 1 : 0) +
      (persisted.dii.action === 'revised' ? 1 : 0) +
      (persisted.diiFlow.action === 'revised' ? 1 : 0);
    const totalSkipped =
      (persisted.fii.action === 'skipped' ? 1 : 0) +
      (persisted.dii.action === 'skipped' ? 1 : 0) +
      (persisted.diiFlow.action === 'skipped' ? 1 : 0);

    await dataFetchLogRepository.complete({
      logId: log.id,
      status: 'success',
      rowsInserted: totalInserted,
      rowsUpdated: totalRevised,
      rowsSkipped: totalSkipped,
    });

    logger.info(
      {
        observationDate: toIsoDate(observationDate),
        fii: persisted.fii,
        dii: persisted.dii,
        diiFlow: persisted.diiFlow,
        fiiWasNetSeller,
      },
      'NSE FII/DII scrape complete',
    );

    return {
      logId: log.id,
      status: 'success',
      observationDate: toIsoDate(observationDate),
      fii: persisted.fii,
      dii: persisted.dii,
      diiFlow: persisted.diiFlow,
    };
  } catch (err) {
    const errorPayload = {
      message: err instanceof Error ? err.message : String(err),
      code: err instanceof AppError ? err.code : 'UNKNOWN',
    };
    logger.error({ ...errorPayload }, 'NSE FII/DII scrape failed');

    await dataFetchLogRepository.complete({
      logId: log.id,
      status: 'failed',
      errors: [errorPayload] as unknown as object,
    });

    return {
      logId: log.id,
      status: 'failed',
      observationDate: null,
      fii: null,
      dii: null,
      diiFlow: null,
      errors: [errorPayload],
    };
  }
}
