import { Indicator, Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { AppError } from '@core/middleware/error-handler';
import { nseClient } from '@core/clients/nse/nse.client';
import { NseFiiDiiResponse, NseFiiDiiRow } from '@core/clients/nse/types';
import { dataFetchLogRepository } from '@core/repositories/data-fetch-log.repository';

const FII_FLOW_INDICATOR_CODE = 'IND_NIFTY_06_FII_FLOW';
const DII_ABSORPTION_INDICATOR_CODE = 'IND_NIFTY_07_DII_ABSORPTION';
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

async function loadIndicators(): Promise<{ fiiInd: Indicator; diiInd: Indicator }> {
  const fiiInd = await prisma.indicator.findUnique({
    where: { code: FII_FLOW_INDICATOR_CODE },
  });
  const diiInd = await prisma.indicator.findUnique({
    where: { code: DII_ABSORPTION_INDICATOR_CODE },
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
  return { fiiInd, diiInd };
}

/**
 * Atomic two-upsert transaction with vintage-aware logic.
 * Replicates dataPointsRepository.upsert behaviour but for two rows in one txn.
 */
async function persistFiiDii(
  fiiInd: Indicator,
  diiInd: Indicator,
  observationDate: Date,
  fiiNet: number,
  diiAbsorption: number,
  fiiWasNetSeller: boolean,
  fiiRow: NseFiiDiiRow,
  diiRow: NseFiiDiiRow,
  logId: string,
): Promise<{
  fii: FiiDiiUpsertResult;
  dii: FiiDiiUpsertResult;
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

    const diiResult = await handle(diiInd.id, diiInd.code, diiAbsorption, 'derived', {
      formula: fiiWasNetSeller
        ? 'dii_buy / abs(fii_sell)'
        : 'dii_buy / fii_buy (FII net-buyer proxy)',
      fii_was_net_seller: fiiWasNetSeller,
      dii_buy_crore: parseCroreValue(diiRow.buyValue, 'dii.buyValue'),
      fii_sell_crore: parseCroreValue(fiiRow.sellValue, 'fii.sellValue'),
      fii_buy_crore: parseCroreValue(fiiRow.buyValue, 'fii.buyValue'),
      derivedFrom: FII_FLOW_INDICATOR_CODE,
    });

    return { fii: fiiResult, dii: diiResult };
  });
}

/**
 * Scrape FII/DII cash flow data from NSE, upsert Ind 6 (FII net flow) and
 * Ind 7 (DII absorption ratio) in a single transaction. All-or-nothing.
 */
export async function scrapeNseFiiDii(
  params: ScrapeNseFiiDiiParams,
): Promise<ScrapeNseFiiDiiResult> {
  const { fiiInd, diiInd } = await loadIndicators();

  const log = await dataFetchLogRepository.start({
    jobName: 'scrape_nse_fii_dii',
    triggerType: params.triggerType,
    triggeredBy: params.triggeredBy ?? null,
    metadata: {
      endpoint: FII_DII_PATH,
      indicatorCodes: [FII_FLOW_INDICATOR_CODE, DII_ABSORPTION_INDICATOR_CODE],
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
    const fiiSell = parseCroreValue(fiiRow.sellValue, 'fii.sellValue');
    const fiiBuy = parseCroreValue(fiiRow.buyValue, 'fii.buyValue');

    const fiiWasNetSeller = fiiNet < 0;

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
      diiAbsorption = diiBuy / Math.abs(fiiSell);
    } else {
      if (fiiBuy < 0.01) {
        throw new AppError(
          502,
          'FII buy value too small to compute proxy ratio',
          'INVALID_FIIDII_INPUTS',
          { fiiBuy },
        );
      }
      diiAbsorption = diiBuy / fiiBuy;
    }

    const persisted = await persistFiiDii(
      fiiInd,
      diiInd,
      observationDate,
      fiiNet,
      diiAbsorption,
      fiiWasNetSeller,
      fiiRow,
      diiRow,
      log.id,
    );

    const totalInserted =
      (persisted.fii.action === 'inserted' ? 1 : 0) +
      (persisted.dii.action === 'inserted' ? 1 : 0);
    const totalRevised =
      (persisted.fii.action === 'revised' ? 1 : 0) +
      (persisted.dii.action === 'revised' ? 1 : 0);
    const totalSkipped =
      (persisted.fii.action === 'skipped' ? 1 : 0) +
      (persisted.dii.action === 'skipped' ? 1 : 0);

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
      errors: [errorPayload],
    };
  }
}
