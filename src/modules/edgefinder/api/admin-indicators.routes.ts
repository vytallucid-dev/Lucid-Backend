import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '@core/db/prisma';
import { AppError } from '@core/middleware/error-handler';

export const adminIndicatorsRouter = Router();

// ============================================================================
// GET /api/admin/indicators/list
// Returns all EdgeFinder indicators with latest data point metadata.
// ============================================================================

const listQuerySchema = z.object({
  tool: z.enum(['nifty', 'edgefinder']).optional().default('edgefinder'),
  country: z.string().optional(),
  uiGroup: z.string().optional(),
  isActive: z
    .string()
    .transform((s) => s === 'true' || s === '1')
    .optional(),
});

adminIndicatorsRouter.get('/list', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, 'Invalid query params', 'VALIDATION_ERROR', parsed.error.flatten());
    }

    const { tool, country, uiGroup, isActive } = parsed.data;

    const indicators = await prisma.indicator.findMany({
      where: {
        tool,
        ...(country !== undefined ? { country } : {}),
        ...(uiGroup !== undefined ? { uiGroup } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
      },
      orderBy:
        tool === 'nifty'
          ? [{ displayOrder: 'asc' }, { code: 'asc' }]
          : [{ country: 'asc' }, { uiGroup: 'asc' }, { code: 'asc' }],
      include: {
        dataPoints: {
          where: { isCurrent: true },
          orderBy: { observationDate: 'desc' },
          take: 1,
          select: {
            observationDate: true,
            value: true,
            source: true,
            createdAt: true,
          },
        },
      },
    });

    // ── COT freshness: for cftc indicators, data lives in cot_data not data_points.
    // Build a map of indicator.code → latest cot_data row so those indicators
    // don't always show "Never Fetched" in the card list.
    const cotIndicators = indicators.filter((i) => i.dataSource === 'cftc');
    type LatestCotRow = { reportDate: Date; createdAt: Date; longPct: unknown };
    const cotLatestByCode = new Map<string, LatestCotRow>();

    if (cotIndicators.length > 0) {
      const countryCodes = cotIndicators.map((i) => i.country).filter(Boolean) as string[];
      // XAU → XAUUSD; all other currency codes match asset.code directly.
      const expandedCodes = [
        ...countryCodes,
        ...countryCodes.map((c) => `${c}USD`),
      ];

      const assets = await prisma.asset.findMany({
        where: { code: { in: expandedCodes }, toolScope: { has: 'edgefinder' } },
        select: { id: true, code: true },
      });
      const assetByCode = new Map(assets.map((a) => [a.code, a]));

      if (assets.length > 0) {
        const cotRows = await prisma.cotData.findMany({
          where: { assetId: { in: assets.map((a) => a.id) }, isCurrent: true },
          orderBy: { reportDate: 'desc' },
          distinct: ['assetId'],
          select: { assetId: true, reportDate: true, createdAt: true, longPct: true },
        });
        const cotByAssetId = new Map(cotRows.map((r) => [r.assetId, r]));

        for (const ind of cotIndicators) {
          if (!ind.country) continue;
          // Exact match (USD/EUR/GBP/JPY) or commodity fallback (XAU → XAUUSD)
          const asset = assetByCode.get(ind.country) ?? assetByCode.get(`${ind.country}USD`);
          if (!asset) continue;
          const row = cotByAssetId.get(asset.id);
          if (row) cotLatestByCode.set(ind.code, row);
        }
      }
    }

    const data = indicators.map((ind) => {
      const latestDp = ind.dataPoints[0] ?? null;
      const cotRow = cotLatestByCode.get(ind.code) ?? null;
      return {
        id: ind.id,
        code: ind.code,
        name: ind.name,
        country: ind.country,
        uiGroup: ind.uiGroup,
        compositeGroup: ind.compositeGroup,
        displayOrder: ind.displayOrder,
        frequency: ind.frequency,
        dataSource: ind.dataSource,
        sourceSeriesId: ind.sourceSeriesId,
        isActive: ind.isActive,
        description: ind.description,
        latestDataPoint: latestDp
          ? {
              observationDate: latestDp.observationDate.toISOString().slice(0, 10),
              value: Number(latestDp.value),
              source: latestDp.source,
              fetchedAt: latestDp.createdAt.toISOString(),
            }
          : cotRow
            ? {
                observationDate: cotRow.reportDate.toISOString().slice(0, 10),
                value: cotRow.longPct !== null ? Number(cotRow.longPct) : 0,
                source: 'cftc',
                fetchedAt: cotRow.createdAt.toISOString(),
              }
            : null,
      };
    });

    res.json({ success: true, count: data.length, data });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// GET /api/admin/indicators/:code/latest
// Returns the latest data point(s) for a specific indicator.
// ============================================================================

const latestQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^\d+$/)
    .transform((s) => Math.min(parseInt(s, 10), 100))
    .optional()
    .default('10'),
});

adminIndicatorsRouter.get(
  '/:code/latest',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const code = req.params.code;
      const parsed = latestQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError(400, 'Invalid query params', 'VALIDATION_ERROR', parsed.error.flatten());
      }
      const limit = typeof parsed.data.limit === 'number' ? parsed.data.limit : parseInt(parsed.data.limit as string, 10);

      const indicator = await prisma.indicator.findUnique({
        where: { code: code as string },
        select: { id: true, code: true, name: true, unit: true, frequency: true, dataSource: true, compositeGroup: true, country: true, uiGroup: true },
      });
      if (!indicator) {
        throw new AppError(404, `Indicator not found: ${code}`, 'INDICATOR_NOT_FOUND');
      }

      const dataPoints = await prisma.dataPoint.findMany({
        where: { indicatorId: indicator.id, isCurrent: true },
        orderBy: { observationDate: 'desc' },
        take: limit,
        select: {
          id: true,
          observationDate: true,
          value: true,
          forecastValue: true,
          previousValue: true,
          isCurrent: true,
          source: true,
          dataQualityFlag: true,
          sourceMetadata: true,
          notes: true,
          createdAt: true,
        },
      });

      const data = dataPoints.map((dp) => ({
        id: dp.id,
        observationDate: dp.observationDate.toISOString().slice(0, 10),
        value: Number(dp.value),
        forecastValue: dp.forecastValue !== null ? Number(dp.forecastValue) : null,
        previousValue: dp.previousValue !== null ? Number(dp.previousValue) : null,
        isCurrent: dp.isCurrent,
        source: dp.source,
        dataQualityFlag: dp.dataQualityFlag,
        sourceMetadata: dp.sourceMetadata,
        notes: dp.notes,
        fetchedAt: dp.createdAt.toISOString(),
      }));

      res.json({
        success: true,
        indicator: {
          code: indicator.code,
          name: indicator.name,
          unit: indicator.unit,
          frequency: indicator.frequency,
          dataSource: indicator.dataSource,
          compositeGroup: indicator.compositeGroup,
          country: indicator.country,
          uiGroup: indicator.uiGroup,
        },
        count: data.length,
        data,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ============================================================================
// GET /api/admin/indicators/:code/cot-data
// Returns recent COT rows for CFTC-sourced indicators.
// The data lives in cot_data (keyed by assetId), not data_points.
// The link: indicator.country == asset.code (USD/EUR/GBP/JPY/XAU).
// ============================================================================

interface AssetMetaLike {
  cotContractCode?: string;
  cotTraderCategory?: string;
}

adminIndicatorsRouter.get(
  '/:code/cot-data',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const code = req.params.code;

      const indicator = await prisma.indicator.findUnique({
        where: { code: code as string },
        select: { id: true, code: true, name: true, dataSource: true, country: true, frequency: true },
      });
      if (!indicator) {
        throw new AppError(404, `Indicator not found: ${code}`, 'INDICATOR_NOT_FOUND');
      }
      if (indicator.dataSource !== 'cftc') {
        throw new AppError(400, `Indicator ${code} is not CFTC-sourced`, 'INVALID_DATA_SOURCE');
      }
      if (!indicator.country) {
        throw new AppError(400, `Indicator ${code} has no country set`, 'MISSING_COUNTRY');
      }

      // Resolve the asset whose code matches the indicator's currency country.
      // For currencies: country 'USD' → asset code 'USD' (exact match).
      // For commodities: country 'XAU' → asset code 'XAUUSD' (startsWith fallback).
      let asset = await prisma.asset.findFirst({
        where: { code: indicator.country, toolScope: { has: 'edgefinder' } },
        select: { id: true, code: true, metadata: true },
      });
      if (!asset) {
        asset = await prisma.asset.findFirst({
          where: {
            code: { startsWith: indicator.country },
            toolScope: { has: 'edgefinder' },
          },
          select: { id: true, code: true, metadata: true },
        });
      }
      if (!asset) {
        throw new AppError(404, `Asset not found for country: ${indicator.country}`, 'ASSET_NOT_FOUND');
      }

      const meta = (asset.metadata ?? {}) as AssetMetaLike;
      const contractCode = meta.cotContractCode ?? null;
      if (!contractCode) {
        throw new AppError(500, `Asset ${asset.code} has no cotContractCode in metadata`, 'MISSING_CONTRACT_CODE');
      }

      const rows = await prisma.cotData.findMany({
        where: { assetId: asset.id, isCurrent: true },
        orderBy: { reportDate: 'desc' },
        take: 12,
        select: {
          id: true,
          reportDate: true,
          releaseDate: true,
          longContracts: true,
          shortContracts: true,
          longPct: true,
          shortPct: true,
          changeInLongContracts: true,
          changeInShortContracts: true,
          weeklyChangePct: true,
          netPositioningLabel: true,
          changeLabel: true,
          createdAt: true,
        },
      });

      const data = rows.map((r) => ({
        id: r.id,
        reportDate: r.reportDate.toISOString().slice(0, 10),
        releaseDate: r.releaseDate.toISOString().slice(0, 10),
        longContracts: r.longContracts,
        shortContracts: r.shortContracts,
        longPct: r.longPct !== null ? Number(r.longPct) : null,
        shortPct: r.shortPct !== null ? Number(r.shortPct) : null,
        changeInLongContracts: r.changeInLongContracts,
        changeInShortContracts: r.changeInShortContracts,
        weeklyChangePct: r.weeklyChangePct !== null ? Number(r.weeklyChangePct) : null,
        netPositioningLabel: r.netPositioningLabel,
        changeLabel: r.changeLabel,
        fetchedAt: r.createdAt.toISOString(),
      }));

      res.json({
        success: true,
        indicator: { code: indicator.code, name: indicator.name, country: indicator.country },
        contractCode,
        count: data.length,
        data,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ============================================================================
// GET /api/admin/indicators/:code/field-spec
// Returns the scoring rules and metadata for a specific indicator.
// ============================================================================

adminIndicatorsRouter.get(
  '/:code/field-spec',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const code = req.params.code;

      const indicator = await prisma.indicator.findUnique({
        where: { code: code as string },
        include: {
          scoringRules: {
            orderBy: { version: 'desc' },
            select: {
              id: true,
              version: true,
              ruleType: true,
              ruleDefinition: true,
              effectiveFrom: true,
              effectiveTo: true,
              notes: true,
              createdAt: true,
            },
          },
        },
      });
      if (!indicator) {
        throw new AppError(404, `Indicator not found: ${code}`, 'INDICATOR_NOT_FOUND');
      }

      const scoringRules = indicator.scoringRules.map((r) => ({
        id: r.id,
        version: r.version,
        ruleType: r.ruleType,
        ruleDefinition: r.ruleDefinition,
        effectiveFrom: r.effectiveFrom.toISOString().slice(0, 10),
        effectiveTo: r.effectiveTo ? r.effectiveTo.toISOString().slice(0, 10) : null,
        notes: r.notes,
        createdAt: r.createdAt.toISOString(),
      }));

      res.json({
        success: true,
        data: {
          id: indicator.id,
          code: indicator.code,
          name: indicator.name,
          category: indicator.category,
          tool: indicator.tool,
          frequency: indicator.frequency,
          unit: indicator.unit,
          dataSource: indicator.dataSource,
          sourceSeriesId: indicator.sourceSeriesId,
          country: indicator.country,
          uiGroup: indicator.uiGroup,
          displayOrder: indicator.displayOrder,
          compositeGroup: indicator.compositeGroup,
          isActive: indicator.isActive,
          description: indicator.description,
          scoringRules,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);
