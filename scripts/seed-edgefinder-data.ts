/// <reference types="node" />
/* eslint-disable no-console */

/**
 * EdgeFinder Manual Seed Script
 *
 * Reads edgefinder_seed_data.json and POSTs each indicator's data to the
 * manual data entry endpoint. Designed to be run ONCE after deploy to seed
 * baseline data for all 41 EdgeFinder indicators.
 *
 * Usage:
 *   npx tsx scripts/seed-edgefinder-data.ts
 *
 * Required env vars:
 *   ADMIN_JWT      - a Supabase JWT for a user with app_metadata.role = 'admin'
 *   API_BASE_URL   - optional, defaults to http://localhost:3001
 *
 * Behavior:
 *   - Reads scripts/data/edgefinder_seed_data.json
 *   - Loops through each entry with a 200ms delay between requests (safe pacing)
 *   - Logs every request: indicator code, status, action (inserted/revised/skipped), errors
 *   - Continues on individual failures (does not abort the whole run)
 *   - Prints a final summary
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================================
// Configuration
// ============================================================================

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3001';
const ADMIN_JWT = process.env.ADMIN_JWT ?? '';
const SEED_FILE_PATH = path.join(__dirname, 'data', 'edgefinder_seed_data.json');
const REQUEST_DELAY_MS = 200; // small delay between requests to be polite

// ============================================================================
// Types
// ============================================================================

interface SeedEntry {
  indicatorCode: string;
  indicatorName: string;
  observationDate: string;
  actual: number;
  forecast?: number;
  previous?: number;
  confidence: string;
  notes?: string;
}

interface ManualEntryRequest {
  indicatorCode: string;
  observationDate: string;
  actual: number;
  forecast?: number | null;
  previous?: number | null;
  notes?: string;
}

interface ManualEntryResponse {
  success: boolean;
  dataPointId: string;
  action: 'inserted' | 'revised' | 'skipped';
  indicator: { code: string; name: string };
  observationDate: string;
  value: number;
  isRateDecision: boolean;
  rateLevel?: number;
  metadata: {
    forecastValue: number | null;
    previousValue: number | null;
    notes: string | null;
  };
}

interface ApiError {
  error: {
    message: string;
    code: string;
    details?: unknown;
  };
  requestId?: string;
}

interface ResultRow {
  indicatorCode: string;
  status: 'success' | 'failed';
  action?: 'inserted' | 'revised' | 'skipped';
  isRateDecision?: boolean;
  errorCode?: string;
  errorMessage?: string;
  durationMs: number;
}

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function colorize(text: string, color: 'green' | 'yellow' | 'red' | 'cyan' | 'gray'): string {
  const codes = {
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
  };
  const reset = '\x1b[0m';
  return `${codes[color]}${text}${reset}`;
}

function formatStatus(status: 'success' | 'failed', action?: string): string {
  if (status === 'failed') return colorize('FAIL', 'red');
  switch (action) {
    case 'inserted':
      return colorize('INSERTED', 'green');
    case 'revised':
      return colorize('REVISED', 'yellow');
    case 'skipped':
      return colorize('SKIPPED', 'gray');
    default:
      return colorize('OK', 'green');
  }
}

// ============================================================================
// API client
// ============================================================================

async function postManualEntry(
  entry: SeedEntry,
): Promise<{ ok: true; data: ManualEntryResponse } | { ok: false; error: ApiError; httpStatus: number }> {
  const body: ManualEntryRequest = {
    indicatorCode: entry.indicatorCode,
    observationDate: entry.observationDate,
    actual: entry.actual,
  };

  if (entry.forecast !== undefined) {
    body.forecast = entry.forecast;
  }
  if (entry.previous !== undefined) {
    body.previous = entry.previous;
  }
  if (entry.notes !== undefined) {
    body.notes = entry.notes;
  }

  const url = `${API_BASE_URL}/api/admin/data/manual`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADMIN_JWT}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        ok: false,
        error: {
          error: {
            message: `Non-JSON response: ${text.slice(0, 200)}`,
            code: 'INVALID_RESPONSE',
          },
        },
        httpStatus: response.status,
      };
    }

    if (response.ok) {
      return { ok: true, data: parsed as ManualEntryResponse };
    }

    return {
      ok: false,
      error: parsed as ApiError,
      httpStatus: response.status,
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        error: {
          message: err instanceof Error ? err.message : String(err),
          code: 'NETWORK_ERROR',
        },
      },
      httpStatus: 0,
    };
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log(colorize('═'.repeat(80), 'cyan'));
  console.log(colorize('EdgeFinder Manual Seed Script', 'cyan'));
  console.log(colorize('═'.repeat(80), 'cyan'));
  console.log();

  // Validate env
  if (!ADMIN_JWT) {
    console.error(colorize('✗ Missing required env var: ADMIN_JWT (a Supabase JWT for an admin user)', 'red'));
    process.exit(1);
  }

  console.log(`API base URL  : ${colorize(API_BASE_URL, 'cyan')}`);
  console.log(`Seed file     : ${colorize(SEED_FILE_PATH, 'cyan')}`);
  console.log(`Request delay : ${colorize(`${REQUEST_DELAY_MS}ms`, 'cyan')}`);
  console.log();

  // Load seed data
  if (!fs.existsSync(SEED_FILE_PATH)) {
    console.error(colorize(`✗ Seed file not found: ${SEED_FILE_PATH}`, 'red'));
    process.exit(1);
  }

  let entries: SeedEntry[];
  try {
    const raw = fs.readFileSync(SEED_FILE_PATH, 'utf-8');
    entries = JSON.parse(raw) as SeedEntry[];
  } catch (err) {
    console.error(colorize(`✗ Failed to parse seed file: ${(err as Error).message}`, 'red'));
    process.exit(1);
  }

  console.log(`Loaded ${colorize(String(entries.length), 'cyan')} indicators to seed`);
  console.log();
  console.log(colorize('─'.repeat(80), 'gray'));

  // Run
  const results: ResultRow[] = [];
  const startedAt = Date.now();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const prefix = `[${String(i + 1).padStart(2, '0')}/${entries.length}]`;
    const codeFmt = entry.indicatorCode.padEnd(20);

    process.stdout.write(`${prefix} ${codeFmt} ${colorize('→', 'gray')} `);

    const reqStart = Date.now();
    const result = await postManualEntry(entry);
    const durationMs = Date.now() - reqStart;

    if (result.ok) {
      const action = result.data.action;
      const isRate = result.data.isRateDecision;
      const valueStr = isRate
        ? `level ${entry.actual} → bps ${result.data.value > 0 ? '+' : ''}${result.data.value}`
        : `value ${result.data.value}`;

      console.log(
        `${formatStatus('success', action)} ${colorize(valueStr, 'gray')} ${colorize(`(${durationMs}ms)`, 'gray')}`,
      );

      results.push({
        indicatorCode: entry.indicatorCode,
        status: 'success',
        action,
        isRateDecision: isRate,
        durationMs,
      });
    } else {
      const errCode = result.error.error.code;
      const errMsg = result.error.error.message;
      console.log(
        `${formatStatus('failed')} ${colorize(`[${errCode}]`, 'red')} ${errMsg} ${colorize(`(HTTP ${result.httpStatus}, ${durationMs}ms)`, 'gray')}`,
      );

      results.push({
        indicatorCode: entry.indicatorCode,
        status: 'failed',
        errorCode: errCode,
        errorMessage: errMsg,
        durationMs,
      });
    }

    // Delay between requests
    if (i < entries.length - 1) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  const totalDuration = Date.now() - startedAt;

  // ============================================================================
  // Summary
  // ============================================================================

  console.log(colorize('─'.repeat(80), 'gray'));
  console.log();
  console.log(colorize('SUMMARY', 'cyan'));
  console.log(colorize('═'.repeat(80), 'cyan'));

  const successCount = results.filter((r) => r.status === 'success').length;
  const failedCount = results.filter((r) => r.status === 'failed').length;
  const insertedCount = results.filter((r) => r.action === 'inserted').length;
  const revisedCount = results.filter((r) => r.action === 'revised').length;
  const skippedCount = results.filter((r) => r.action === 'skipped').length;
  const rateDecisionCount = results.filter((r) => r.isRateDecision).length;

  console.log(`Total       : ${entries.length}`);
  console.log(`${colorize('Successful  :', 'green')} ${successCount}`);
  console.log(`  ${colorize('Inserted  :', 'green')} ${insertedCount}`);
  console.log(`  ${colorize('Revised   :', 'yellow')} ${revisedCount}`);
  console.log(`  ${colorize('Skipped   :', 'gray')} ${skippedCount}`);
  console.log(`  Rate decisions: ${rateDecisionCount}`);

  if (failedCount > 0) {
    console.log(`${colorize('Failed      :', 'red')} ${failedCount}`);
  } else {
    console.log(`${colorize('Failed      :', 'gray')} 0`);
  }

  console.log(`Duration    : ${(totalDuration / 1000).toFixed(1)}s`);
  console.log();

  // Print failures in detail
  const failures = results.filter((r) => r.status === 'failed');
  if (failures.length > 0) {
    console.log(colorize('FAILURES', 'red'));
    console.log(colorize('─'.repeat(80), 'gray'));
    for (const f of failures) {
      console.log(
        `  ${colorize('✗', 'red')} ${f.indicatorCode.padEnd(20)} [${f.errorCode}] ${f.errorMessage}`,
      );
    }
    console.log();
  }

  // Exit code
  if (failedCount > 0) {
    console.log(colorize('Seed completed with failures. Review above and re-run for failed indicators.', 'yellow'));
    process.exit(1);
  } else {
    console.log(colorize('✓ Seed completed successfully.', 'green'));
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(colorize('Unhandled error:', 'red'), err);
  process.exit(1);
});