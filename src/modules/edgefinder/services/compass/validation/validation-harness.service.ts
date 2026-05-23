import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';
import {
  VALIDATION_WINDOWS,
  type ValidationWindowConfig,
} from './validation-windows.config';

export type Regime = 'Risk-On' | 'Caution' | 'Risk-Off';

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
  windowResults: WindowValidationResult[];
  overallPassed: boolean;
  overallSummary: string;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function buildSummary(windowResults: WindowValidationResult[]): string {
  const passed = windowResults.filter((w) => w.passed).length;
  const failed = windowResults.filter((w) => !w.passed);
  if (failed.length === 0) {
    return `All ${passed}/${windowResults.length} validation windows passed.`;
  }
  const failureDetails = failed
    .map((w) => `${w.windowName}: ${w.failures.join('; ')}`)
    .join(' | ');
  return `${passed}/${windowResults.length} passed. Failures: ${failureDetails}`;
}

async function evaluateWindow(
  config: ValidationWindowConfig,
): Promise<WindowValidationResult> {
  const rows = await prisma.compassClassification.findMany({
    where: {
      isValidation: true,
      isCurrent: true,
      classificationDate: {
        gte: config.startDate,
        lte: config.endDate,
      },
    },
    select: {
      classificationDate: true,
      activeRegime: true,
      crisisOverrideFired: true,
    },
    orderBy: { classificationDate: 'asc' },
  });

  const totalTradingDays = rows.length;
  let riskOffDays = 0;
  let cautionDays = 0;
  let riskOnDays = 0;

  for (const row of rows) {
    if (row.activeRegime === 'Risk-Off') riskOffDays += 1;
    else if (row.activeRegime === 'Caution') cautionDays += 1;
    else if (row.activeRegime === 'Risk-On') riskOnDays += 1;
  }

  const riskOffPercent =
    totalTradingDays === 0 ? 0 : (riskOffDays / totalTradingDays) * 100;

  const peakRow = rows.find(
    (r) => r.classificationDate.getTime() === config.peakDate.getTime(),
  );
  const crisisOverrideFiredOnPeak = peakRow ? peakRow.crisisOverrideFired : null;
  const peakDateClassification = (peakRow?.activeRegime as Regime | undefined) ?? null;

  const falseRiskOnDates: string[] = [];
  const coreStart = config.crisisCore.start.getTime();
  const coreEnd = config.crisisCore.end.getTime();
  for (const row of rows) {
    const t = row.classificationDate.getTime();
    if (t >= coreStart && t <= coreEnd && row.activeRegime === 'Risk-On') {
      falseRiskOnDates.push(ymd(row.classificationDate));
    }
  }

  const failures: string[] = [];

  if (totalTradingDays === 0) {
    failures.push('no classifications found in window — backfill incomplete?');
  }

  if (riskOffPercent < config.minRiskOffPercent) {
    failures.push(
      `Risk-Off ${riskOffPercent.toFixed(1)}% below threshold ${config.minRiskOffPercent}%`,
    );
  }

  if (config.requiresCrisisOverride) {
    if (crisisOverrideFiredOnPeak === null) {
      failures.push(`no classification found for peak date ${ymd(config.peakDate)}`);
    } else if (crisisOverrideFiredOnPeak === false) {
      failures.push(
        `crisis override did not fire on peak date ${ymd(config.peakDate)}`,
      );
    }
  }

  if (falseRiskOnDates.length > 0) {
    failures.push(
      `${falseRiskOnDates.length} false Risk-On classification(s) in crisis core`,
    );
  }

  return {
    windowName: config.windowName,
    passed: failures.length === 0,
    totalTradingDays,
    riskOffDays,
    cautionDays,
    riskOnDays,
    riskOffPercent,
    crisisOverrideFiredOnPeak,
    peakDateClassification,
    falseRiskOnDates,
    failures,
  };
}

/**
 * Run validation against all 4 historical windows. Reads classifications
 * where isValidation=true and compares to expected regime behavior.
 *
 * Does NOT trigger any data fetches — assumes backfill is complete.
 * Persists the report to compass_validation_reports.
 */
export async function runValidation(): Promise<ValidationReport> {
  const windowResults: WindowValidationResult[] = [];
  for (const cfg of VALIDATION_WINDOWS) {
    windowResults.push(await evaluateWindow(cfg));
  }

  const overallPassed = windowResults.every((w) => w.passed);
  const overallSummary = buildSummary(windowResults);
  const generatedAt = new Date();

  const stored = await prisma.compassValidationReport.create({
    data: {
      generatedAt,
      overallPassed,
      windowResults: windowResults as unknown as Prisma.InputJsonValue,
      summary: overallSummary,
    },
  });

  logger.info(
    { id: stored.id, overallPassed, overallSummary },
    'Compass validation report generated',
  );

  return {
    id: stored.id,
    generatedAt: stored.generatedAt,
    windowResults,
    overallPassed,
    overallSummary,
  };
}

/**
 * Get the most recent persisted validation report, or null if none exist.
 */
export async function getMostRecentReport(): Promise<ValidationReport | null> {
  const row = await prisma.compassValidationReport.findFirst({
    orderBy: { generatedAt: 'desc' },
  });
  if (!row) return null;
  return {
    id: row.id,
    generatedAt: row.generatedAt,
    windowResults: row.windowResults as unknown as WindowValidationResult[],
    overallPassed: row.overallPassed,
    overallSummary: row.summary,
  };
}
