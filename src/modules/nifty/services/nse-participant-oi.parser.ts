/**
 * Parser for NSE Participant-wise Open Interest CSV.
 *
 * Input: raw CSV text from /content/nsccl/fao_participant_oi_DDMMYYYY.csv
 * Output: parsed FII row + observation date from the file title.
 *
 * Defensive parsing — column matching by header name, not position.
 * Tolerates whitespace, trailing commas, and trailing empty lines.
 */

import { AppError } from '@core/middleware/error-handler';

export interface ParsedFiiOi {
  observationDate: Date; // UTC midnight of the date in the CSV title
  futureIndexLong: number;
  futureIndexShort: number;
  longPct: number; // 0-100
  rawHeaders: string[];
  rawFiiRow: string[];
}

const MONTH_NAMES: Record<string, number> = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
};

/**
 * Parse the title line's date. Title format example:
 *   "Participant wise Open Interest (no. of contracts) in Equity Derivatives as on Oct 20,2023"
 */
function parseTitleDate(titleLine: string): Date {
  const match = titleLine.match(/as on\s+([A-Za-z]{3,9})\s+(\d{1,2})\s*,\s*(\d{4})/i);
  if (!match) {
    throw new AppError(
      502,
      `Could not parse date from CSV title: ${titleLine.slice(0, 200)}`,
      'NSE_OI_TITLE_DATE_PARSE_FAILED',
      { titleLine },
    );
  }
  const [, monthRaw, dayRaw, yearRaw] = match;
  const monthKey = monthRaw.slice(0, 3).toUpperCase();
  const month = MONTH_NAMES[monthKey];
  if (month === undefined) {
    throw new AppError(
      502,
      `Unknown month '${monthRaw}' in CSV title`,
      'NSE_OI_TITLE_DATE_PARSE_FAILED',
      { titleLine },
    );
  }
  const day = parseInt(dayRaw, 10);
  const year = parseInt(yearRaw, 10);
  if (!Number.isFinite(day) || !Number.isFinite(year)) {
    throw new AppError(
      502,
      `Invalid day/year in CSV title`,
      'NSE_OI_TITLE_DATE_PARSE_FAILED',
      { titleLine },
    );
  }
  return new Date(Date.UTC(year, month, day));
}

function parseIntegerCell(raw: string, label: string): number {
  const cleaned = raw.replace(/,/g, '').trim();
  if (cleaned === '') {
    throw new AppError(502, `Empty cell for ${label}`, 'NSE_OI_VALUE_PARSE_FAILED', {
      label,
      raw,
    });
  }
  const num = parseInt(cleaned, 10);
  if (!Number.isFinite(num)) {
    throw new AppError(
      502,
      `Non-numeric cell for ${label}: '${raw}'`,
      'NSE_OI_VALUE_PARSE_FAILED',
      { label, raw },
    );
  }
  return num;
}

/**
 * Parse NSE Participant-wise OI CSV. Returns FII row data only.
 * Throws AppError if the structure is unexpected.
 */
export function parseParticipantOiCsv(csvText: string): ParsedFiiOi {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 3) {
    throw new AppError(
      502,
      `CSV has too few lines (${lines.length})`,
      'NSE_OI_CSV_MALFORMED',
      { lineCount: lines.length, preview: csvText.slice(0, 200) },
    );
  }

  // Line 1 = title (starts with quote, contains date)
  const titleLine = lines[0];
  if (!titleLine.startsWith('"')) {
    throw new AppError(
      502,
      `Expected quoted title as first line; got: ${titleLine.slice(0, 200)}`,
      'NSE_OI_CSV_MALFORMED',
    );
  }
  const observationDate = parseTitleDate(titleLine);

  // Line 2 = headers
  const headerLine = lines[1];
  const headers = headerLine.split(',').map((h) => h.trim());

  const longColIdx = headers.findIndex((h) => h.toLowerCase() === 'future index long');
  const shortColIdx = headers.findIndex((h) => h.toLowerCase() === 'future index short');
  const clientTypeIdx = headers.findIndex((h) => h.toLowerCase() === 'client type');

  if (longColIdx === -1 || shortColIdx === -1 || clientTypeIdx === -1) {
    throw new AppError(
      502,
      'Required CSV headers missing (Client Type / Future Index Long / Future Index Short)',
      'NSE_OI_CSV_MALFORMED',
      { availableHeaders: headers },
    );
  }

  // Lines 3+ = data rows. Find the FII row (case-insensitive).
  let fiiRow: string[] | null = null;
  for (let i = 2; i < lines.length; i++) {
    const cells = lines[i].split(',').map((c) => c.trim());
    if (cells[clientTypeIdx]?.toUpperCase() === 'FII') {
      fiiRow = cells;
      break;
    }
  }

  if (!fiiRow) {
    throw new AppError(502, 'FII row not found in CSV', 'NSE_OI_FII_ROW_MISSING', {
      lineCount: lines.length,
    });
  }

  const futureIndexLong = parseIntegerCell(fiiRow[longColIdx], 'FII.Future Index Long');
  const futureIndexShort = parseIntegerCell(fiiRow[shortColIdx], 'FII.Future Index Short');

  const total = futureIndexLong + futureIndexShort;
  if (total === 0) {
    throw new AppError(
      502,
      'FII Future Index Long + Short = 0, cannot compute ratio',
      'NSE_OI_INVALID_INPUTS',
      { futureIndexLong, futureIndexShort },
    );
  }

  const longPct = (futureIndexLong / total) * 100;

  return {
    observationDate,
    futureIndexLong,
    futureIndexShort,
    longPct,
    rawHeaders: headers,
    rawFiiRow: fiiRow,
  };
}
