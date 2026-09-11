import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import { compassConfigRepository } from '@core/repositories/compass-config.repository';
import {
  runValidationSuite,
  REPORT_KIND,
  type ValidationReportV2,
} from './replay/replay-harness.service';

export type Regime = 'Risk-On' | 'Caution' | 'Risk-Off';

/**
 * Compass validation.
 *
 * WHAT CHANGED IN PHASE C
 * -----------------------
 * This used to READ `compass_classifications WHERE isValidation = true` and
 * compare regimes. It had never returned a non-zero result and could not: the
 * only path that could populate those rows ran the live input services day by
 * day, and the live HY OAS service throws whenever FRED returns nothing — which
 * it does for every date before 2023-09-11 — so the backfill skipped the
 * classifier for every historical day and wrote no rows at all. Independently,
 * EODHD serves twelve months of history under a call cap shared with NIFTY.
 *
 * It now RUNS the replay (see replay/replay-harness.service.ts), which drives the
 * shipped pure scoring modules over historical data fetched from FRED and Yahoo,
 * with point-in-time ALFRED vintages for the four revised macro series.
 *
 * Three defects fixed along the way, each of which made the previous output
 * meaningless rather than merely inaccurate:
 *   - it read `activeRegime`, which the Shock Layer deliberately never writes;
 *   - `requiresCrisisOverride` was structurally unsatisfiable after Phase 4;
 *   - four of the eight specified windows did not exist, and one of the four
 *     that did measured duration where the architecture produces a spike.
 */

/** Legacy shape, retained so old rows in the JSONB column still parse. */
export interface WindowValidationResult {
  windowName: string;
  passed: boolean;
  totalTradingDays: number;
  riskOffDays: number;
  cautionDays: number;
  riskOnDays: number;
  riskOffPercent: number;
  crisisOverrideFiredOnPeak: boolean | null;
  peakDateClassification: Regime | null;
  falseRiskOnDates: string[];
  failures: string[];
}

export interface ValidationReport {
  id?: string;
  generatedAt: Date;
  overallPassed: boolean;
  overallSummary: string;
  /** The Phase C report. */
  report: ValidationReportV2;
}

export interface RunValidationOptions {
  /** 'live' reproduces the pre-Phase-C look-ahead, for measuring it. Default 'pit'. */
  macroMode?: 'pit' | 'live';
  only?: string[];
  /** Skip the database write (used by the report scripts). */
  persist?: boolean;
}

/**
 * Run all eight validation windows and persist the report.
 *
 * Takes several minutes: it fetches ~9 full-history series plus 4 ALFRED vintage
 * tables, then replays every window under every applicable HY OAS bracket.
 */
export async function runValidation(
  options: RunValidationOptions = {},
): Promise<ValidationReport> {
  const config = await compassConfigRepository.resolveForDate(new Date());
  const report = await runValidationSuite({
    config,
    macroMode: options.macroMode ?? 'pit',
    only: options.only,
  });

  const generatedAt = new Date();
  let id: string | undefined;

  if (options.persist !== false) {
    const stored = await prisma.compassValidationReport.create({
      data: {
        generatedAt,
        overallPassed: report.overallPassed,
        windowResults: report as unknown as Prisma.InputJsonValue,
        summary: report.summary,
      },
    });
    id = stored.id;
  }

  logger.info(
    {
      id,
      passed: report.passedCount,
      of: report.windowCount,
      macroMode: report.macroMode,
      configVersionLabel: report.configVersionLabel,
    },
    'Compass validation report generated',
  );

  return {
    id,
    generatedAt,
    overallPassed: report.overallPassed,
    overallSummary: report.summary,
    report,
  };
}

/**
 * Most recent persisted report.
 *
 * The JSONB column holds two incompatible shapes: this Phase C report and, from
 * earlier runs, both the legacy 4-window array and a 40-row research export. The
 * `reportKind` discriminator distinguishes them; anything without it is returned
 * as `legacy` rather than being mis-typed as current, which is what the previous
 * unchecked double-cast did.
 */
export async function getMostRecentReport(): Promise<
  | { kind: 'phase-c'; id: string; generatedAt: Date; report: ValidationReportV2 }
  | { kind: 'legacy'; id: string; generatedAt: Date; raw: unknown }
  | null
> {
  const row = await prisma.compassValidationReport.findFirst({
    orderBy: { generatedAt: 'desc' },
  });
  if (!row) return null;

  const raw = row.windowResults as unknown;
  const isPhaseC =
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { reportKind?: unknown }).reportKind === REPORT_KIND;

  if (isPhaseC) {
    return {
      kind: 'phase-c',
      id: row.id,
      generatedAt: row.generatedAt,
      report: raw as ValidationReportV2,
    };
  }
  return { kind: 'legacy', id: row.id, generatedAt: row.generatedAt, raw };
}

/** Most recent Phase C report specifically, skipping any legacy rows. */
export async function getMostRecentPhaseCReport(): Promise<ValidationReportV2 | null> {
  const rows = await prisma.compassValidationReport.findMany({
    orderBy: { generatedAt: 'desc' },
    take: 20,
  });
  for (const row of rows) {
    const raw = row.windowResults as unknown;
    if (
      typeof raw === 'object' &&
      raw !== null &&
      (raw as { reportKind?: unknown }).reportKind === REPORT_KIND
    ) {
      return raw as ValidationReportV2;
    }
  }
  return null;
}
