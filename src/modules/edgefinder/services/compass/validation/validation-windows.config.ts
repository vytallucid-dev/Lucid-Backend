export type ValidationWindowName =
  | '2008_GFC'
  | '2020_COVID'
  | '2022_HIKES'
  | '2024_YEN_UNWIND';

export interface ValidationWindowConfig {
  windowName: ValidationWindowName;
  startDate: Date;
  endDate: Date;
  peakDate: Date;
  crisisCore: { start: Date; end: Date };
  minRiskOffPercent: number;
  requiresCrisisOverride: boolean;
}

function utc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

export const VALIDATION_WINDOWS: ValidationWindowConfig[] = [
  {
    windowName: '2008_GFC',
    startDate: utc(2008, 7, 1),
    endDate: utc(2008, 12, 31),
    peakDate: utc(2008, 9, 29),
    crisisCore: { start: utc(2008, 9, 15), end: utc(2008, 12, 31) },
    minRiskOffPercent: 60,
    requiresCrisisOverride: true,
  },
  {
    windowName: '2020_COVID',
    startDate: utc(2020, 1, 15),
    endDate: utc(2020, 5, 31),
    peakDate: utc(2020, 3, 16),
    crisisCore: { start: utc(2020, 2, 24), end: utc(2020, 4, 30) },
    minRiskOffPercent: 60,
    requiresCrisisOverride: true,
  },
  {
    windowName: '2022_HIKES',
    startDate: utc(2022, 4, 1),
    endDate: utc(2022, 11, 30),
    peakDate: utc(2022, 10, 21),
    crisisCore: { start: utc(2022, 9, 1), end: utc(2022, 11, 15) },
    minRiskOffPercent: 30,
    requiresCrisisOverride: false,
  },
  {
    windowName: '2024_YEN_UNWIND',
    startDate: utc(2024, 6, 1),
    endDate: utc(2024, 9, 30),
    peakDate: utc(2024, 8, 5),
    crisisCore: { start: utc(2024, 7, 31), end: utc(2024, 8, 9) },
    minRiskOffPercent: 10,
    requiresCrisisOverride: false,
  },
];

export function getWindowByName(
  name: ValidationWindowName,
): ValidationWindowConfig {
  const found = VALIDATION_WINDOWS.find((w) => w.windowName === name);
  if (!found) {
    throw new Error(`Unknown validation window: ${name}`);
  }
  return found;
}
