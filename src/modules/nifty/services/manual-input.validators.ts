/**
 * Per-indicator validation rules for manually entered values.
 * Each validator returns { valid: true } or { valid: false, reason: string }.
 *
 * Ranges are based on the v9 NIFTY master doc and India macro conventions.
 * Tune as needed.
 */

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export type ValueValidator = (value: number) => ValidationResult;

const inRange = (min: number, max: number, label: string): ValueValidator => {
  return (value: number) => {
    if (!Number.isFinite(value)) {
      return { valid: false, reason: `${label} value must be a finite number` };
    }
    if (value < min || value > max) {
      return {
        valid: false,
        reason: `${label} value ${value} out of expected range [${min}, ${max}]`,
      };
    }
    return { valid: true };
  };
};

/**
 * Validators keyed by indicator code. Fall back to genericNumeric if not listed.
 */
export const VALIDATORS: Record<string, ValueValidator> = {
  // PMI: index points, theoretical 0-100, practical 35-70
  IND_NIFTY_01_PMI_MFG: inRange(0, 100, 'PMI Manufacturing'),
  IND_NIFTY_02_PMI_SVC: inRange(0, 100, 'PMI Services'),

  // RBI Repo Rate: % terms, India's range historically 4-9%
  IND_NIFTY_04_RBI_RATE: inRange(0, 15, 'RBI Repo Rate'),

  // IIP: %, can be deeply negative in shocks (e.g. -57% in Apr 2020 COVID)
  IND_NIFTY_05_IIP: inRange(-100, 100, 'India IIP'),
};

const genericNumeric: ValueValidator = (value: number) => {
  if (!Number.isFinite(value)) {
    return { valid: false, reason: 'Value must be a finite number' };
  }
  return { valid: true };
};

export function validateValue(indicatorCode: string, value: number): ValidationResult {
  const validator = VALIDATORS[indicatorCode] ?? genericNumeric;
  return validator(value);
}
