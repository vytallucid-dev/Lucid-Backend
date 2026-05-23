You are implementing Phase 6E of the lucid-backend project: public read API for the NIFTY scorecard, plus an admin logs endpoint with pagination. This is what the Next.js frontend will consume.

The frontend's expected data shapes (snake_case, integer indicator IDs, nested array, pre-formatted values) were determined by surveying the actual frontend codebase. Match these exactly. Translation happens server-side so the frontend wires in with zero shape changes.

HARD RULES — DO NOT VIOLATE:
1. Create ONLY the files listed below. Do not create extras.
2. Modify only the files explicitly listed.
3. Do not install npm packages.
4. Do not run npm install, do not run migrations, do not run the server, do not run tests.
5. Match the architectural decisions exactly. Do not improvise.
6. If anything is ambiguous, STOP and ask before guessing.
7. snake_case for ALL API response field names (this is a deliberate departure from project convention — frontend expects snake_case). TypeScript types can be camelCase internally but the serialized JSON output MUST be snake_case.
8. Every async function has explicit Promise<T> return type.
9. No `any` types. Use `unknown` with type guards.
10. After all files are created, output ONLY: (a) list of files created/modified, (b) commands the user needs to run manually, (c) anything unclear.

---

### CONTEXT — Response shape contract

The frontend has 1291-line types in `nifty-demo-data.ts` defining the exact shape. We must match those shapes for the scorecard, indicator, and ind9 sub-indicators payloads. See the public-api.types.ts spec below — types are written as TypeScript interfaces with snake_case fields so that JSON.stringify produces snake_case output naturally.

Indicators in the response use integer IDs (1-13) derived from `displayOrder`, NOT the string codes. Frontend identifies them as `id: 1` through `id: 13`. We still expose `code` for admin/debugging.

---

### CREATE FILE: `src/modules/nifty/types/public-api.types.ts`

```typescript
/**
 * Public API types for the NIFTY frontend. Field names use snake_case
 * to match the frontend's existing TypeScript interfaces exactly. This is a
 * deliberate departure from the rest of the codebase's camelCase convention
 * — it eliminates frontend translation logic.
 *
 * Reference: lucid-frontend/src/lib/nifty-demo-data.ts lines 3-145
 */

export type PublicBand =
  | 'Strong Bullish'
  | 'Bullish'
  | 'Neutral'
  | 'Caution'
  | 'Bearish'
  | 'Strong Bearish';

export type PublicCompositionFlag =
  | 'INFLATION_LED'
  | 'DEMAND_DESTRUCTION'
  | 'MIXED'
  | 'INFLATION_HOT'
  | 'DEMAND_REACCEL'
  | null;

export type PublicComposite = 'Domestic' | 'External';

export type PublicIndicatorScore = -2 | -1 | 0 | 1 | 2;

export type PublicRegimeBucket =
  | 'BULL'
  | 'BEAR_DEEP'
  | 'BEAR_LIGHT'
  | 'TOP_CORRECTION'
  | 'MIXED';

export interface PublicIndicator {
  id: number; // 1-13 (from displayOrder)
  code: string; // 'IND_NIFTY_01_PMI_MFG'
  name: string; // 'PMI Manufacturing'
  short: string; // 'PMI Mfg'
  composite: PublicComposite;
  score: PublicIndicatorScore | null;
  value: string; // pre-formatted display string e.g. '54.6', '₹2.10T', 'Raw -6'
  magnitude: string; // narrative context line e.g. 'vs prior 3.40%'
  trajectory_3m_avg?: string; // only set for Ind 3 (India CPI)
  last_change_date: string; // ISO 'YYYY-MM-DD'
  prev_score?: PublicIndicatorScore;
  outcome: 'scored' | 'carry_forward' | 'insufficient_data';
  flags: string[];
  reason?: string; // only set when outcome is insufficient_data
}

export interface PublicScorecard {
  id: string; // scorecard UUID
  date: string; // ISO 'YYYY-MM-DD'
  phase?: string; // analyst-supplied, undefined for v1
  bucket?: PublicRegimeBucket; // analyst-supplied, undefined for v1
  indicators: PublicIndicator[]; // exactly 13, in id order 1..13
  domestic_composite: number;
  external_composite: number;
  net_score: number;
  band: PublicBand;
  ind9_raw_composite: number | null;
  ind9_sub_indicators: Record<string, PublicIndicatorScore>; // empty object until EdgeFinder
  composition_flag: PublicCompositionFlag;
  peak_score_active: boolean;
  peak_score_peak_date?: string;
  peak_score_peak_value?: number;
  velocity_short?: number;
  conflict_flag: boolean;
  notes?: string;
  catalysts: string[]; // empty array until analyst-supplied
  missing_indicators: string[]; // indicator codes that returned insufficient_data
}

export interface PublicScorecardHistoryItem {
  // Lightweight scorecard for history list views (no indicators array)
  id: string;
  date: string;
  net_score: number;
  domestic_composite: number;
  external_composite: number;
  band: PublicBand;
  conflict_flag: boolean;
  composition_flag: PublicCompositionFlag;
  peak_score_active: boolean;
  ind9_raw_composite: number | null;
}

export interface PublicIndicatorMetadata {
  id: number;
  code: string;
  name: string;
  short: string;
  composite: PublicComposite;
  output_range: string; // e.g. '-2/-1/0/+1/+2' or '-1/0/+1'
  cadence: string; // 'daily', 'monthly', 'event_driven'
  data_source: string; // 'fred', 'manual', 'nse_scrape', 'derived'
  unit: string | null;
  description: string | null;
  last_updated: string | null; // ISO date of most recent data point
  is_active: boolean;
}

export interface PublicIndicatorDetail extends PublicIndicatorMetadata {
  latest_score: PublicIndicatorScore | null;
  latest_value: string | null;
  latest_value_raw: number | null;
  latest_observation_date: string | null;
  recent_scores?: Array<{
    date: string;
    score: PublicIndicatorScore;
    value: string;
    flags: string[];
  }>;
  recent_data_points?: Array<{
    date: string;
    value: number;
    source: string;
    is_revised: boolean;
  }>;
}

export interface PublicAdminLogEntry {
  id: string;
  job_name: string;
  trigger_type: string;
  status: string;
  started_at: string; // ISO datetime
  completed_at: string | null;
  duration_ms: number | null;
  rows_inserted: number;
  rows_updated: number;
  rows_skipped: number;
  target_date_from: string | null;
  target_date_to: string | null;
  metadata: Record<string, unknown> | null;
  errors: unknown[] | null;
}

export interface PublicAdminLogsResponse {
  total: number;
  limit: number;
  offset: number;
  items: PublicAdminLogEntry[];
}
```

---

### CREATE FILE: `src/modules/nifty/services/public-api.formatters.ts`

```typescript
/**
 * Formatters for translating raw data into frontend display strings.
 * The frontend expects pre-formatted `value` and `magnitude` strings,
 * not raw numbers — this layer produces them.
 */

import type { Indicator } from '@prisma/client';

const INDIAN_RUPEE = '₹';
const USD = '$';

/**
 * Format a numeric value for display, indicator-specific.
 * Examples:
 *   PMI: 54.6 → '54.6'
 *   CPI: 3.48 → '3.48%'
 *   FII Flow: 1329.17 → '₹1,329 Cr'
 *   Brent: 106.11 → '$106.1'
 *   VIX: 18.79 → '18.79'
 *   Ind 9 (raw): 0 → 'Raw 0'
 *   Ind 13: 12.43 → '12.4%'
 */
export function formatIndicatorValue(
  indicatorCode: string,
  value: number | null,
): string {
  if (value === null || !Number.isFinite(value)) return '—';

  switch (indicatorCode) {
    case 'IND_NIFTY_01_PMI_MFG':
    case 'IND_NIFTY_02_PMI_SVC':
    case 'IND_NIFTY_08_VIX':
      return value.toFixed(2);

    case 'IND_NIFTY_03_CPI':
    case 'IND_NIFTY_05_IIP':
      return `${value.toFixed(2)}%`;

    case 'IND_NIFTY_04_RBI_RATE':
      return `${value.toFixed(2)}%`;

    case 'IND_NIFTY_06_FII_FLOW': {
      const sign = value < 0 ? '-' : '';
      const absVal = Math.abs(value);
      return `${sign}${INDIAN_RUPEE}${absVal.toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr`;
    }

    case 'IND_NIFTY_07_DII_ABSORPTION':
      return value.toFixed(3);

    case 'IND_NIFTY_09_USD_WEAKNESS': {
      const sign = value > 0 ? '+' : '';
      return `Raw ${sign}${Math.round(value)}`;
    }

    case 'IND_NIFTY_10_DXY':
      return value.toFixed(2);

    case 'IND_NIFTY_11_BRENT':
      return `${USD}${value.toFixed(2)}`;

    case 'IND_NIFTY_12_USDINR':
      return value.toFixed(2);

    case 'IND_NIFTY_13_FII_LS_RATIO':
      return `${value.toFixed(1)}%`;

    default:
      return value.toString();
  }
}

/**
 * Generate a magnitude / context narrative for an indicator.
 * Compares current value to prior data point and provides directional context.
 */
export function formatMagnitude(
  indicatorCode: string,
  currentValue: number | null,
  priorValue: number | null,
): string {
  if (currentValue === null) return 'No data';
  if (priorValue === null) return 'No prior reading';

  const delta = currentValue - priorValue;
  const direction = delta > 0 ? '+' : delta < 0 ? '' : '±';
  const absDelta = Math.abs(delta);

  switch (indicatorCode) {
    case 'IND_NIFTY_01_PMI_MFG':
    case 'IND_NIFTY_02_PMI_SVC':
      return `vs prior ${priorValue.toFixed(1)} (${direction}${absDelta.toFixed(1)} MoM)`;

    case 'IND_NIFTY_03_CPI':
    case 'IND_NIFTY_05_IIP':
      return `vs prior ${priorValue.toFixed(2)}% (${direction}${absDelta.toFixed(2)} pp MoM)`;

    case 'IND_NIFTY_06_FII_FLOW': {
      const sign = currentValue < 0 ? 'net sell' : 'net buy';
      return `${sign} (vs prior ${INDIAN_RUPEE}${Math.abs(priorValue).toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr)`;
    }

    case 'IND_NIFTY_08_VIX':
      return `vs prior ${priorValue.toFixed(2)} (${direction}${absDelta.toFixed(2)} pts)`;

    case 'IND_NIFTY_09_USD_WEAKNESS':
      return `composite from 14 sub-indicators`;

    case 'IND_NIFTY_10_DXY':
      return `10-day change`;

    case 'IND_NIFTY_11_BRENT':
      return `10-day change`;

    case 'IND_NIFTY_12_USDINR':
      return `10-day change vs ${priorValue.toFixed(2)}`;

    case 'IND_NIFTY_13_FII_LS_RATIO':
      return `FII long share of futures`;

    default:
      return `vs prior ${priorValue.toFixed(2)}`;
  }
}

/**
 * Map indicator dataSource to a friendly display string.
 */
export function describeDataSource(dataSource: string): string {
  const mapping: Record<string, string> = {
    fred: 'FRED API',
    manual: 'Manual',
    nse_scrape: 'NSE scrape',
    derived: 'Derived',
    edgefinder: 'EdgeFinder',
  };
  return mapping[dataSource] ?? dataSource;
}

/**
 * Compose output_range string from indicator metadata.
 */
export function indicatorOutputRange(indicatorCode: string): string {
  // Indicators that can score ±2 per v2.0 spec
  const fiveTier = new Set([
    'IND_NIFTY_03_CPI',
    'IND_NIFTY_06_FII_FLOW',
    'IND_NIFTY_09_USD_WEAKNESS',
    'IND_NIFTY_12_USDINR',
  ]);
  return fiveTier.has(indicatorCode) ? '-2/-1/0/+1/+2' : '-1/0/+1';
}

export function indicatorShortName(name: string): string {
  // Short names follow the seed mapping. Hard-coded mapping for the 13.
  const shortMap: Record<string, string> = {
    'PMI Manufacturing': 'PMI Mfg',
    'PMI Services': 'PMI Svc',
    'India CPI': 'India CPI',
    'RBI Rate': 'RBI Rate',
    'India IIP': 'IIP',
    'FII Net Cash Flow': 'FII Flow',
    'DII Absorption Ratio': 'DII Abs',
    'India VIX': 'India VIX',
    'USD Weakness': 'USD Wkns',
    'DXY 10-day': 'DXY Trend',
    'Brent Crude 10-day': 'Brent',
    'USD/INR 10-day': 'INR/USD',
    'FII L/S Futures': 'FII L/S',
  };
  return shortMap[name] ?? name;
}
```

---

### CREATE FILE: `src/modules/nifty/services/public-api.service.ts`

```typescript
import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { AppError } from '@core/middleware/error-handler';
import {
  PublicScorecard,
  PublicScorecardHistoryItem,
  PublicIndicator,
  PublicIndicatorMetadata,
  PublicIndicatorDetail,
  PublicIndicatorScore,
  PublicBand,
  PublicComposite,
  PublicCompositionFlag,
  PublicAdminLogsResponse,
  PublicAdminLogEntry,
} from '../types/public-api.types';
import {
  formatIndicatorValue,
  formatMagnitude,
  describeDataSource,
  indicatorOutputRange,
  indicatorShortName,
} from './public-api.formatters';

const DOMESTIC_CODES = new Set([
  'IND_NIFTY_01_PMI_MFG',
  'IND_NIFTY_02_PMI_SVC',
  'IND_NIFTY_03_CPI',
  'IND_NIFTY_04_RBI_RATE',
  'IND_NIFTY_05_IIP',
  'IND_NIFTY_07_DII_ABSORPTION',
]);

const HISTORY_DEFAULT_LIMIT = 100;
const HISTORY_MAX_LIMIT = 365;
const LOGS_DEFAULT_LIMIT = 25;
const LOGS_MAX_LIMIT = 100;
const INDICATOR_HISTORY_DAYS = 30;

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toIsoDateTime(d: Date): string {
  return d.toISOString();
}

function asScore(value: number): PublicIndicatorScore {
  if (value === -2 || value === -1 || value === 0 || value === 1 || value === 2) {
    return value;
  }
  // Defensive — should never happen given DB constraints
  throw new Error(`Invalid score value: ${value}`);
}

function compositeFor(indicatorCode: string): PublicComposite {
  return DOMESTIC_CODES.has(indicatorCode) ? 'Domestic' : 'External';
}

/**
 * Resolve a scorecard's indicators array by joining:
 *  - The indicatorBreakdown JSON stored on the scorecard
 *  - The indicators table (for name, displayOrder)
 *  - The latest data_point per indicator (for raw value used by formatter)
 *  - The prior data_point (for magnitude diff)
 *  - The prior score (for prev_score)
 */
async function resolveIndicators(
  observationDate: Date,
  indicatorBreakdown: Record<string, unknown>,
): Promise<PublicIndicator[]> {
  const indicators = await prisma.indicator.findMany({
    where: { tool: 'nifty', isActive: true },
    orderBy: { displayOrder: 'asc' },
  });

  const results: PublicIndicator[] = [];

  for (const ind of indicators) {
    const breakdownEntry = (indicatorBreakdown[ind.code] ?? null) as {
      score: number | null;
      outcome: 'scored' | 'carry_forward' | 'insufficient_data';
      flags: string[];
      reason?: string;
    } | null;

    // Latest data_point for value display
    const currentDp = await prisma.dataPoint.findFirst({
      where: {
        indicatorId: ind.id,
        isCurrent: true,
        observationDate: { lte: observationDate },
      },
      orderBy: { observationDate: 'desc' },
    });

    // Prior data_point for magnitude
    const priorDp = currentDp
      ? await prisma.dataPoint.findFirst({
          where: {
            indicatorId: ind.id,
            isCurrent: true,
            observationDate: { lt: currentDp.observationDate },
          },
          orderBy: { observationDate: 'desc' },
        })
      : null;

    // Prior score for prev_score
    const priorScore = await prisma.score.findFirst({
      where: {
        indicatorId: ind.id,
        observationDate: { lt: observationDate },
      },
      orderBy: { observationDate: 'desc' },
    });

    const currentValue = currentDp ? Number(currentDp.value) : null;
    const priorValue = priorDp ? Number(priorDp.value) : null;

    const formattedValue = formatIndicatorValue(ind.code, currentValue);
    const magnitudeText = formatMagnitude(ind.code, currentValue, priorValue);
    const score = breakdownEntry?.score ?? null;
    const lastChangeDate = currentDp ? toIsoDate(currentDp.observationDate) : '';

    // Extract trajectory_3m_avg for CPI from the score's computationMetadata
    let trajectory3mAvg: string | undefined;
    if (ind.code === 'IND_NIFTY_03_CPI') {
      const cpiScore = await prisma.score.findFirst({
        where: { indicatorId: ind.id, observationDate },
        orderBy: { computedAt: 'desc' },
      });
      const cpiMeta = (cpiScore?.computationMetadata ?? {}) as {
        threeMonthAvg?: number;
      };
      if (typeof cpiMeta.threeMonthAvg === 'number') {
        trajectory3mAvg = `${cpiMeta.threeMonthAvg.toFixed(2)}%`;
      }
    }

    const item: PublicIndicator = {
      id: ind.displayOrder ?? 0,
      code: ind.code,
      name: ind.name,
      short: indicatorShortName(ind.name),
      composite: compositeFor(ind.code),
      score: score !== null ? asScore(score) : null,
      value: formattedValue,
      magnitude: magnitudeText,
      last_change_date: lastChangeDate,
      outcome: breakdownEntry?.outcome ?? 'insufficient_data',
      flags: breakdownEntry?.flags ?? [],
      ...(breakdownEntry?.reason ? { reason: breakdownEntry.reason } : {}),
      ...(trajectory3mAvg ? { trajectory_3m_avg: trajectory3mAvg } : {}),
      ...(priorScore !== null ? { prev_score: asScore(priorScore.score) } : {}),
    };

    results.push(item);
  }

  return results;
}

async function mapScorecardToPublic(
  scorecard: {
    id: string;
    observationDate: Date;
    netScore: number;
    domesticScore: number;
    externalScore: number;
    band: string | null;
    ratingLabel: string;
    conflictFlag: boolean;
    ind9RawComposite: number | null;
    compositionFlag: string | null;
    indicatorBreakdown: Prisma.JsonValue;
    specialFlags: Prisma.JsonValue;
  },
): Promise<PublicScorecard> {
  const breakdown = (scorecard.indicatorBreakdown ?? {}) as Record<string, unknown>;
  const specialFlags = (scorecard.specialFlags ?? {}) as {
    missingIndicators?: string[];
  };
  const indicators = await resolveIndicators(scorecard.observationDate, breakdown);
  const band = (scorecard.band ?? scorecard.ratingLabel) as PublicBand;

  return {
    id: scorecard.id,
    date: toIsoDate(scorecard.observationDate),
    indicators,
    domestic_composite: scorecard.domesticScore,
    external_composite: scorecard.externalScore,
    net_score: scorecard.netScore,
    band,
    ind9_raw_composite: scorecard.ind9RawComposite,
    ind9_sub_indicators: {}, // Populated when EdgeFinder lands
    composition_flag: scorecard.compositionFlag as PublicCompositionFlag,
    peak_score_active: false, // Phase 6C will populate
    conflict_flag: scorecard.conflictFlag,
    catalysts: [],
    missing_indicators: specialFlags.missingIndicators ?? [],
  };
}

export async function getLatestScorecard(): Promise<PublicScorecard> {
  const scorecard = await prisma.niftyScorecard.findFirst({
    where: { isCurrent: true },
    orderBy: { observationDate: 'desc' },
  });

  if (!scorecard) {
    throw new AppError(
      404,
      'No scorecards exist yet. Run /api/admin/scorecard/assemble first.',
      'NO_SCORECARDS',
    );
  }

  return mapScorecardToPublic(scorecard);
}

export async function getScorecardByDate(
  observationDate: Date,
): Promise<PublicScorecard> {
  const scorecard = await prisma.niftyScorecard.findFirst({
    where: { observationDate, isCurrent: true },
    orderBy: { vintageDate: 'desc' },
  });

  if (!scorecard) {
    throw new AppError(
      404,
      `No scorecard for ${toIsoDate(observationDate)}`,
      'SCORECARD_NOT_FOUND',
    );
  }

  return mapScorecardToPublic(scorecard);
}

export interface ScorecardHistoryParams {
  from?: Date;
  to?: Date;
  limit?: number;
  includeBreakdown?: boolean;
}

export async function getScorecardHistory(
  params: ScorecardHistoryParams,
): Promise<{
  items: PublicScorecard[] | PublicScorecardHistoryItem[];
  count: number;
  limit: number;
}> {
  const limit = Math.min(params.limit ?? HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT);

  const where: Prisma.NiftyScorecardWhereInput = {
    isCurrent: true,
    ...(params.from || params.to
      ? {
          observationDate: {
            ...(params.from ? { gte: params.from } : {}),
            ...(params.to ? { lte: params.to } : {}),
          },
        }
      : {}),
  };

  const scorecards = await prisma.niftyScorecard.findMany({
    where,
    orderBy: { observationDate: 'desc' },
    take: limit,
  });

  if (params.includeBreakdown) {
    const full: PublicScorecard[] = [];
    for (const sc of scorecards) {
      full.push(await mapScorecardToPublic(sc));
    }
    return { items: full, count: full.length, limit };
  }

  const items: PublicScorecardHistoryItem[] = scorecards.map((sc) => ({
    id: sc.id,
    date: toIsoDate(sc.observationDate),
    net_score: sc.netScore,
    domestic_composite: sc.domesticScore,
    external_composite: sc.externalScore,
    band: (sc.band ?? sc.ratingLabel) as PublicBand,
    conflict_flag: sc.conflictFlag,
    composition_flag: sc.compositionFlag as PublicCompositionFlag,
    peak_score_active: false,
    ind9_raw_composite: sc.ind9RawComposite,
  }));

  return { items, count: items.length, limit };
}

export async function getIndicators(): Promise<PublicIndicatorMetadata[]> {
  const indicators = await prisma.indicator.findMany({
    where: { tool: 'nifty' },
    orderBy: { displayOrder: 'asc' },
  });

  const results: PublicIndicatorMetadata[] = [];
  for (const ind of indicators) {
    const latest = await prisma.dataPoint.findFirst({
      where: { indicatorId: ind.id, isCurrent: true },
      orderBy: { observationDate: 'desc' },
    });

    results.push({
      id: ind.displayOrder ?? 0,
      code: ind.code,
      name: ind.name,
      short: indicatorShortName(ind.name),
      composite: compositeFor(ind.code),
      output_range: indicatorOutputRange(ind.code),
      cadence: ind.cadence ?? 'unknown',
      data_source: describeDataSource(ind.dataSource),
      unit: ind.unit,
      description: ind.description,
      last_updated: latest ? toIsoDate(latest.observationDate) : null,
      is_active: ind.isActive,
    });
  }

  return results;
}

export interface IndicatorDetailParams {
  code: string;
  includeHistory?: boolean;
}

export async function getIndicatorDetail(
  params: IndicatorDetailParams,
): Promise<PublicIndicatorDetail> {
  const ind = await prisma.indicator.findUnique({ where: { code: params.code } });
  if (!ind) {
    throw new AppError(404, `Indicator not found: ${params.code}`, 'INDICATOR_NOT_FOUND');
  }

  const latestDp = await prisma.dataPoint.findFirst({
    where: { indicatorId: ind.id, isCurrent: true },
    orderBy: { observationDate: 'desc' },
  });

  const latestScore = await prisma.score.findFirst({
    where: { indicatorId: ind.id },
    orderBy: { observationDate: 'desc' },
  });

  const detail: PublicIndicatorDetail = {
    id: ind.displayOrder ?? 0,
    code: ind.code,
    name: ind.name,
    short: indicatorShortName(ind.name),
    composite: compositeFor(ind.code),
    output_range: indicatorOutputRange(ind.code),
    cadence: ind.cadence ?? 'unknown',
    data_source: describeDataSource(ind.dataSource),
    unit: ind.unit,
    description: ind.description,
    last_updated: latestDp ? toIsoDate(latestDp.observationDate) : null,
    is_active: ind.isActive,
    latest_score: latestScore !== null ? asScore(latestScore.score) : null,
    latest_value: latestDp
      ? formatIndicatorValue(ind.code, Number(latestDp.value))
      : null,
    latest_value_raw: latestDp ? Number(latestDp.value) : null,
    latest_observation_date: latestDp ? toIsoDate(latestDp.observationDate) : null,
  };

  if (params.includeHistory) {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - INDICATOR_HISTORY_DAYS);

    const recentScores = await prisma.score.findMany({
      where: {
        indicatorId: ind.id,
        observationDate: { gte: since },
      },
      orderBy: { observationDate: 'desc' },
      take: INDICATOR_HISTORY_DAYS,
    });

    const recentDataPoints = await prisma.dataPoint.findMany({
      where: {
        indicatorId: ind.id,
        isCurrent: true,
        observationDate: { gte: since },
      },
      orderBy: { observationDate: 'desc' },
      take: INDICATOR_HISTORY_DAYS,
    });

    detail.recent_scores = recentScores.map((s) => ({
      date: toIsoDate(s.observationDate),
      score: asScore(s.score),
      value: '', // Could join with data_point here if needed
      flags: s.flag ? s.flag.split(',') : [],
    }));

    detail.recent_data_points = recentDataPoints.map((dp) => ({
      date: toIsoDate(dp.observationDate),
      value: Number(dp.value),
      source: dp.source,
      is_revised: dp.dataQualityFlag === 'revised',
    }));
  }

  return detail;
}

export interface AdminLogsQueryParams {
  jobName?: string;
  status?: string;
  triggerType?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

export async function getAdminLogs(
  params: AdminLogsQueryParams,
): Promise<PublicAdminLogsResponse> {
  const limit = Math.min(params.limit ?? LOGS_DEFAULT_LIMIT, LOGS_MAX_LIMIT);
  const offset = Math.max(params.offset ?? 0, 0);

  const where: Prisma.DataFetchLogWhereInput = {
    ...(params.jobName ? { jobName: { contains: params.jobName, mode: 'insensitive' } } : {}),
    ...(params.status ? { status: params.status } : {}),
    ...(params.triggerType ? { triggerType: params.triggerType } : {}),
    ...(params.from || params.to
      ? {
          startedAt: {
            ...(params.from ? { gte: params.from } : {}),
            ...(params.to ? { lte: params.to } : {}),
          },
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.dataFetchLog.count({ where }),
    prisma.dataFetchLog.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      take: limit,
      skip: offset,
    }),
  ]);

  const items: PublicAdminLogEntry[] = rows.map((row) => ({
    id: row.id,
    job_name: row.jobName,
    trigger_type: row.triggerType,
    status: row.status,
    started_at: toIsoDateTime(row.startedAt),
    completed_at: row.completedAt ? toIsoDateTime(row.completedAt) : null,
    duration_ms: row.completedAt
      ? row.completedAt.getTime() - row.startedAt.getTime()
      : null,
    rows_inserted: row.rowsInserted ?? 0,
    rows_updated: row.rowsUpdated ?? 0,
    rows_skipped: row.rowsSkipped ?? 0,
    target_date_from: row.targetDateFrom ? toIsoDate(row.targetDateFrom) : null,
    target_date_to: row.targetDateTo ? toIsoDate(row.targetDateTo) : null,
    metadata: (row.metadata ?? null) as Record<string, unknown> | null,
    errors: (row.errors ?? null) as unknown[] | null,
  }));

  return { total, limit, offset, items };
}
```

---

### CREATE FILE: `src/modules/nifty/routes/nifty-public.routes.ts`

```typescript
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '@core/middleware/error-handler';
import {
  getLatestScorecard,
  getScorecardByDate,
  getScorecardHistory,
  getIndicators,
  getIndicatorDetail,
} from '@modules/nifty/services/public-api.service';

export const niftyPublicRouter = Router();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

niftyPublicRouter.get(
  '/scorecard/latest',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await getLatestScorecard();
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  },
);

const historyQuerySchema = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    limit: z
      .string()
      .regex(/^\d+$/)
      .transform((s) => parseInt(s, 10))
      .optional(),
    include_breakdown: z
      .string()
      .transform((s) => s === 'true' || s === '1')
      .optional(),
  })
  .strict();

niftyPublicRouter.get(
  '/scorecard/history',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = historyQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError(400, 'Invalid query', 'VALIDATION_ERROR', parsed.error.flatten());
      }

      const result = await getScorecardHistory({
        from: parsed.data.from ? new Date(`${parsed.data.from}T00:00:00.000Z`) : undefined,
        to: parsed.data.to ? new Date(`${parsed.data.to}T00:00:00.000Z`) : undefined,
        limit: parsed.data.limit,
        includeBreakdown: parsed.data.include_breakdown ?? false,
      });

      res.json({ success: true, ...result });
    } catch (err) {
      next(err);
    }
  },
);

// :date is YYYY-MM-DD; placed AFTER /history so /history doesn't match :date
niftyPublicRouter.get(
  '/scorecard/:date',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dateStr = req.params.date;
      if (!isoDate.safeParse(dateStr).success) {
        throw new AppError(400, 'Invalid date format', 'VALIDATION_ERROR', { date: dateStr });
      }
      const observationDate = new Date(`${dateStr}T00:00:00.000Z`);
      if (observationDate.getTime() > Date.now()) {
        throw new AppError(400, 'Date cannot be in the future', 'VALIDATION_ERROR');
      }
      const data = await getScorecardByDate(observationDate);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  },
);

niftyPublicRouter.get(
  '/indicators',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const items = await getIndicators();
      res.json({ success: true, count: items.length, items });
    } catch (err) {
      next(err);
    }
  },
);

const indicatorDetailQuerySchema = z
  .object({
    include_history: z
      .string()
      .transform((s) => s === 'true' || s === '1')
      .optional(),
  })
  .strict();

niftyPublicRouter.get(
  '/indicators/:code',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const code = req.params.code;
      const parsed = indicatorDetailQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError(400, 'Invalid query', 'VALIDATION_ERROR', parsed.error.flatten());
      }
      const data = await getIndicatorDetail({
        code,
        includeHistory: parsed.data.include_history ?? false,
      });
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  },
);
```

---

### CREATE FILE: `src/modules/nifty/routes/admin-logs.routes.ts`

```typescript
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '@core/middleware/error-handler';
import { getAdminLogs } from '@modules/nifty/services/public-api.service';

export const adminLogsRouter = Router();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

const logsQuerySchema = z
  .object({
    job_name: z.string().max(200).optional(),
    status: z.enum(['success', 'partial', 'failed']).optional(),
    trigger_type: z.enum(['cron', 'manual', 'backfill']).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    limit: z
      .string()
      .regex(/^\d+$/)
      .transform((s) => parseInt(s, 10))
      .optional(),
    offset: z
      .string()
      .regex(/^\d+$/)
      .transform((s) => parseInt(s, 10))
      .optional(),
  })
  .strict();

adminLogsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = logsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, 'Invalid query', 'VALIDATION_ERROR', parsed.error.flatten());
    }

    const result = await getAdminLogs({
      jobName: parsed.data.job_name,
      status: parsed.data.status,
      triggerType: parsed.data.trigger_type,
      from: parsed.data.from ? new Date(`${parsed.data.from}T00:00:00.000Z`) : undefined,
      to: parsed.data.to ? new Date(`${parsed.data.to}T23:59:59.999Z`) : undefined,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });

    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});
```

---

### MODIFY FILE: `src/core/routes/admin.routes.ts`

REPLACE the existing file contents with:

```typescript
import { Router } from 'express';
import { adminAuth } from '@core/middleware/admin-auth';
import { fredRouter } from '@modules/nifty/routes/fred.routes';
import { manualInputRouter } from '@modules/nifty/routes/manual-input.routes';
import { nseRouter } from '@modules/nifty/routes/nse.routes';
import { scoringRouter } from '@modules/nifty/routes/scoring.routes';
import { scorecardRouter } from '@modules/nifty/routes/scorecard.routes';
import { adminLogsRouter } from '@modules/nifty/routes/admin-logs.routes';

export const adminRouter = Router();

// TODO(auth): Replace adminAuth with Supabase Auth + role-based middleware when ready.
adminRouter.use(adminAuth);

adminRouter.get('/ping', (_req, res) => {
  res.json({ message: 'Admin route reachable. Auth working.' });
});

adminRouter.use('/jobs', fredRouter);
adminRouter.use('/jobs', nseRouter);
adminRouter.use('/data', manualInputRouter);
adminRouter.use('/scoring', scoringRouter);
adminRouter.use('/scorecard', scorecardRouter);
adminRouter.use('/logs', adminLogsRouter);
```

---

### MODIFY FILE: `src/server.ts`

The current file mounts `adminRouter` under `/api/admin`. Add a parallel mount for `niftyPublicRouter` under `/api/nifty` with the SAME `adminAuth` middleware (per Aman's decision to use the admin key for read endpoints in v1).

Locate the section where `adminRouter` is mounted and ADD the new mount immediately after. Import `adminAuth` if not already imported. Import `niftyPublicRouter` from the new file path.

Expected pattern:

```typescript
import { niftyPublicRouter } from '@modules/nifty/routes/nifty-public.routes';
import { adminAuth } from '@core/middleware/admin-auth';

// ... existing setup ...

app.use('/api/admin', adminRouter);
app.use('/api/nifty', adminAuth, niftyPublicRouter);  // Read API; same auth as admin for v1
```

If the existing server.ts already has a different mount pattern, MATCH THAT PATTERN. Do not change the conventions of the rest of the file. Read the actual file before modifying.

If there's any ambiguity about where to add the mount, STOP and ask.

---

### FINAL OUTPUT

After all files are created/modified, output:
1. Complete list of files created and modified (paths only)
2. The exact commands the user needs to run manually
3. Anything that was unclear or skipped

Do not run any commands. Do not install packages.