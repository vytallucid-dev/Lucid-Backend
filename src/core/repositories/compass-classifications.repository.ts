import { Prisma } from '@prisma/client';
import { prisma } from '@core/db/prisma';
import { logger } from '@core/utils/logger';

export type Regime = 'Risk-On' | 'Caution' | 'Risk-Off';

export interface UpsertCompassClassificationInput {
  classificationDate: Date;
  candidateRegime: Regime;
  activeRegime: Regime;
  persistenceDaysCount: number;
  /** Always false going forward — Phase 4 retires the crisis clause. Column kept for historical rows. */
  crisisOverrideFired: boolean;
  /** Phase 4: Risk-Off when shockAActive, else equals activeRegime. */
  finalRegime: Regime;
  shockAActive: boolean;
  shockBActive: boolean;
  /** Phase 6 gate audit — the daily record of what the two override gates decided. */
  us02yClose: number | null;
  us02ySma21: number | null;
  rateGateHawkish: boolean;
  override3SuppressedByGate: boolean;
  override5SuppressedByGate: boolean;
  fedConstraint: string;
  override2SuppressedByConstraint: boolean;
  /** Post-gate override code set that actually fires (asset + pair). */
  overridesActive: string[];
  totalGreenWeight: number;
  totalYellowWeight: number;
  totalRedWeight: number;
  voteBreakdown: Prisma.InputJsonValue;
  isValidation?: boolean;
}

export interface UpsertCompassClassificationResult {
  id: string;
  action: 'inserted' | 'revised' | 'skipped';
}

export interface PriorClassificationSnapshot {
  classificationDate: Date;
  activeRegime: Regime;
  candidateRegime: Regime;
  persistenceDaysCount: number;
}

/**
 * The regime + gate decisions in effect as of a date, for the override
 * assembly path (Phase 6). `activeRegime` is the standard machine's output
 * (== standard_active_regime); `finalRegime` is Risk-Off under a Trigger A
 * shock. The gate fields are the classifier's persisted decisions — assembly
 * reads them rather than re-deriving, so the gates are computed once per day.
 */
export interface RegimeGateSnapshot {
  classificationDate: Date;
  activeRegime: Regime;
  finalRegime: Regime;
  shockAActive: boolean;
  shockBActive: boolean;
  rateGateHawkish: boolean;
  override3SuppressedByGate: boolean;
  override5SuppressedByGate: boolean;
  fedConstraint: string;
  override2SuppressedByConstraint: boolean;
}

/** Full current-vintage classification row with Decimal weights coerced to numbers. */
export interface CompassClassificationRow {
  classificationDate: Date;
  candidateRegime: Regime;
  activeRegime: Regime;
  persistenceDaysCount: number;
  crisisOverrideFired: boolean;
  finalRegime: Regime;
  shockAActive: boolean;
  shockBActive: boolean;
  us02yClose: number | null;
  us02ySma21: number | null;
  rateGateHawkish: boolean;
  override3SuppressedByGate: boolean;
  override5SuppressedByGate: boolean;
  fedConstraint: string;
  override2SuppressedByConstraint: boolean;
  overridesActive: Prisma.JsonValue;
  totalGreenWeight: number;
  totalYellowWeight: number;
  totalRedWeight: number;
  voteBreakdown: Prisma.JsonValue;
}

function toDecimal2(n: number): Prisma.Decimal {
  return new Prisma.Decimal(n).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

function toDecimal6OrNull(n: number | null): Prisma.Decimal | null {
  return n === null ? null : new Prisma.Decimal(n).toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP);
}

interface RawClassificationRow {
  classificationDate: Date;
  candidateRegime: string;
  activeRegime: string;
  persistenceDaysCount: number;
  crisisOverrideFired: boolean;
  finalRegime: string;
  shockAActive: boolean;
  shockBActive: boolean;
  us02yClose: Prisma.Decimal | null;
  us02ySma21: Prisma.Decimal | null;
  rateGateHawkish: boolean;
  override3SuppressedByGate: boolean;
  override5SuppressedByGate: boolean;
  fedConstraint: string;
  override2SuppressedByConstraint: boolean;
  overridesActive: Prisma.JsonValue;
  totalGreenWeight: Prisma.Decimal;
  totalYellowWeight: Prisma.Decimal;
  totalRedWeight: Prisma.Decimal;
  voteBreakdown: Prisma.JsonValue;
}

function mapClassificationRow(row: RawClassificationRow): CompassClassificationRow {
  return {
    classificationDate: row.classificationDate,
    candidateRegime: row.candidateRegime as Regime,
    activeRegime: row.activeRegime as Regime,
    persistenceDaysCount: row.persistenceDaysCount,
    crisisOverrideFired: row.crisisOverrideFired,
    finalRegime: row.finalRegime as Regime,
    shockAActive: row.shockAActive,
    shockBActive: row.shockBActive,
    us02yClose: row.us02yClose === null ? null : Number(row.us02yClose.toString()),
    us02ySma21: row.us02ySma21 === null ? null : Number(row.us02ySma21.toString()),
    rateGateHawkish: row.rateGateHawkish,
    override3SuppressedByGate: row.override3SuppressedByGate,
    override5SuppressedByGate: row.override5SuppressedByGate,
    fedConstraint: row.fedConstraint,
    override2SuppressedByConstraint: row.override2SuppressedByConstraint,
    overridesActive: row.overridesActive,
    totalGreenWeight: Number(row.totalGreenWeight.toString()),
    totalYellowWeight: Number(row.totalYellowWeight.toString()),
    totalRedWeight: Number(row.totalRedWeight.toString()),
    voteBreakdown: row.voteBreakdown,
  };
}

/** Columns needed by the public snapshot — keeps the row payload lean. */
const PUBLIC_ROW_SELECT = {
  classificationDate: true,
  candidateRegime: true,
  activeRegime: true,
  persistenceDaysCount: true,
  crisisOverrideFired: true,
  finalRegime: true,
  shockAActive: true,
  shockBActive: true,
  us02yClose: true,
  us02ySma21: true,
  rateGateHawkish: true,
  override3SuppressedByGate: true,
  override5SuppressedByGate: true,
  fedConstraint: true,
  override2SuppressedByConstraint: true,
  overridesActive: true,
  totalGreenWeight: true,
  totalYellowWeight: true,
  totalRedWeight: true,
  voteBreakdown: true,
} as const;

function decimalEquals(a: Prisma.Decimal, b: Prisma.Decimal): boolean {
  return a.equals(b);
}

export const compassClassificationsRepository = {
  /**
   * Vintage-aware upsert for a Compass classification row.
   *
   * Live and validation rows live in disjoint spaces via the isValidation
   * flag — current-row lookup and revision both scope to the same flag.
   */
  async upsert(
    input: UpsertCompassClassificationInput,
  ): Promise<UpsertCompassClassificationResult> {
    const incomingGreen = toDecimal2(input.totalGreenWeight);
    const incomingYellow = toDecimal2(input.totalYellowWeight);
    const incomingRed = toDecimal2(input.totalRedWeight);
    const isValidation = input.isValidation ?? false;

    // Common column payload shared by both create paths (insert + revision),
    // so the Phase 6 gate-audit fields are threaded through in exactly one place.
    const commonData = {
      classificationDate: input.classificationDate,
      candidateRegime: input.candidateRegime,
      activeRegime: input.activeRegime,
      persistenceDaysCount: input.persistenceDaysCount,
      crisisOverrideFired: input.crisisOverrideFired,
      finalRegime: input.finalRegime,
      shockAActive: input.shockAActive,
      shockBActive: input.shockBActive,
      us02yClose: toDecimal6OrNull(input.us02yClose),
      us02ySma21: toDecimal6OrNull(input.us02ySma21),
      rateGateHawkish: input.rateGateHawkish,
      override3SuppressedByGate: input.override3SuppressedByGate,
      override5SuppressedByGate: input.override5SuppressedByGate,
      fedConstraint: input.fedConstraint,
      override2SuppressedByConstraint: input.override2SuppressedByConstraint,
      overridesActive: input.overridesActive as Prisma.InputJsonValue,
      totalGreenWeight: incomingGreen,
      totalYellowWeight: incomingYellow,
      totalRedWeight: incomingRed,
      voteBreakdown: input.voteBreakdown,
      isValidation,
    };

    return prisma.$transaction(async (tx) => {
      const existing = await tx.compassClassification.findFirst({
        where: {
          classificationDate: input.classificationDate,
          isCurrent: true,
          isValidation,
        },
      });

      if (existing) {
        const existingGreen = new Prisma.Decimal(existing.totalGreenWeight.toString());
        const existingYellow = new Prisma.Decimal(existing.totalYellowWeight.toString());
        const existingRed = new Prisma.Decimal(existing.totalRedWeight.toString());

        const existingUs02yClose =
          existing.us02yClose === null ? null : new Prisma.Decimal(existing.us02yClose.toString());
        const existingUs02ySma21 =
          existing.us02ySma21 === null ? null : new Prisma.Decimal(existing.us02ySma21.toString());
        const incomingUs02yClose = toDecimal6OrNull(input.us02yClose);
        const incomingUs02ySma21 = toDecimal6OrNull(input.us02ySma21);
        const decimalEqualsNullable = (a: Prisma.Decimal | null, b: Prisma.Decimal | null): boolean =>
          a === null && b === null ? true : a === null || b === null ? false : a.equals(b);

        const matches =
          existing.candidateRegime === input.candidateRegime &&
          existing.activeRegime === input.activeRegime &&
          existing.persistenceDaysCount === input.persistenceDaysCount &&
          existing.crisisOverrideFired === input.crisisOverrideFired &&
          existing.finalRegime === input.finalRegime &&
          existing.shockAActive === input.shockAActive &&
          existing.shockBActive === input.shockBActive &&
          decimalEqualsNullable(existingUs02yClose, incomingUs02yClose) &&
          decimalEqualsNullable(existingUs02ySma21, incomingUs02ySma21) &&
          existing.rateGateHawkish === input.rateGateHawkish &&
          existing.override3SuppressedByGate === input.override3SuppressedByGate &&
          existing.override5SuppressedByGate === input.override5SuppressedByGate &&
          existing.fedConstraint === input.fedConstraint &&
          existing.override2SuppressedByConstraint === input.override2SuppressedByConstraint &&
          JSON.stringify(existing.overridesActive) === JSON.stringify(input.overridesActive) &&
          decimalEquals(existingGreen, incomingGreen) &&
          decimalEquals(existingYellow, incomingYellow) &&
          decimalEquals(existingRed, incomingRed) &&
          JSON.stringify(existing.voteBreakdown) === JSON.stringify(input.voteBreakdown);

        if (matches) {
          return { id: existing.id, action: 'skipped' as const };
        }

        logger.info(
          {
            classificationDate: input.classificationDate.toISOString().slice(0, 10),
            priorActive: existing.activeRegime,
            newActive: input.activeRegime,
            isValidation,
          },
          'Compass classification revision — inserting new vintage',
        );

        await tx.compassClassification.update({
          where: { id: existing.id },
          data: { isCurrent: false },
        });

        const inserted = await tx.compassClassification.create({
          data: { ...commonData, isCurrent: true },
        });

        return { id: inserted.id, action: 'revised' as const };
      }

      const inserted = await tx.compassClassification.create({
        data: { ...commonData, isCurrent: true },
      });

      return { id: inserted.id, action: 'inserted' as const };
    });
  },

  /**
   * Get the most recent current classification strictly before `date` in the
   * same validation space. Used to look up "yesterday's" state when
   * resolving today's persistence.
   */
  async getMostRecentBefore(
    date: Date,
    isValidation: boolean = false,
  ): Promise<PriorClassificationSnapshot | null> {
    const row = await prisma.compassClassification.findFirst({
      where: {
        isCurrent: true,
        isValidation,
        classificationDate: { lt: date },
      },
      orderBy: { classificationDate: 'desc' },
    });

    if (!row) return null;

    return {
      classificationDate: row.classificationDate,
      activeRegime: row.activeRegime as Regime,
      candidateRegime: row.candidateRegime as Regime,
      persistenceDaysCount: row.persistenceDaysCount,
    };
  },

  /**
   * Get the regime in effect AS OF `date` in the same validation space.
   * Prefers the classification row for `date` itself; otherwise falls back
   * to the most recent prior current row.
   */
  async getRegimeAsOf(
    date: Date,
    isValidation: boolean = false,
  ): Promise<PriorClassificationSnapshot | null> {
    const row = await prisma.compassClassification.findFirst({
      where: {
        isCurrent: true,
        isValidation,
        classificationDate: { lte: date },
      },
      orderBy: { classificationDate: 'desc' },
    });

    if (!row) return null;

    return {
      classificationDate: row.classificationDate,
      activeRegime: row.activeRegime as Regime,
      candidateRegime: row.candidateRegime as Regime,
      persistenceDaysCount: row.persistenceDaysCount,
    };
  },

  /**
   * Get the regime + persisted gate decisions in effect AS OF `date` (Phase 6
   * override assembly). Reads the classifier's already-computed gate outcomes
   * so the override assembly path applies them without re-deriving the gates
   * per asset/pair — the gates are global per-date and computed once.
   */
  async getRegimeGateAsOf(
    date: Date,
    isValidation: boolean = false,
  ): Promise<RegimeGateSnapshot | null> {
    const row = await prisma.compassClassification.findFirst({
      where: {
        isCurrent: true,
        isValidation,
        classificationDate: { lte: date },
      },
      orderBy: { classificationDate: 'desc' },
      select: {
        classificationDate: true,
        activeRegime: true,
        finalRegime: true,
        shockAActive: true,
        shockBActive: true,
        rateGateHawkish: true,
        override3SuppressedByGate: true,
        override5SuppressedByGate: true,
        fedConstraint: true,
        override2SuppressedByConstraint: true,
      },
    });

    if (!row) return null;

    return {
      classificationDate: row.classificationDate,
      activeRegime: row.activeRegime as Regime,
      finalRegime: row.finalRegime as Regime,
      shockAActive: row.shockAActive,
      shockBActive: row.shockBActive,
      rateGateHawkish: row.rateGateHawkish,
      override3SuppressedByGate: row.override3SuppressedByGate,
      override5SuppressedByGate: row.override5SuppressedByGate,
      fedConstraint: row.fedConstraint,
      override2SuppressedByConstraint: row.override2SuppressedByConstraint,
    };
  },

  /**
   * Latest current-vintage classification (the regime in effect "now").
   * Backed by the [classificationDate desc] index — single indexed row read.
   */
  async getLatest(
    isValidation: boolean = false,
  ): Promise<CompassClassificationRow | null> {
    const row = await prisma.compassClassification.findFirst({
      where: { isCurrent: true, isValidation },
      orderBy: { classificationDate: 'desc' },
      select: PUBLIC_ROW_SELECT,
    });
    return row ? mapClassificationRow(row) : null;
  },

  /**
   * Most recent `limit` current-vintage classifications, newest first. Powers
   * the 30-day audit log and the days-stable streak from a single indexed scan;
   * voteBreakdown carries each day's per-input color bands, so no per-day input
   * join is needed.
   */
  async getRecent(
    limit: number,
    isValidation: boolean = false,
  ): Promise<CompassClassificationRow[]> {
    const rows = await prisma.compassClassification.findMany({
      where: { isCurrent: true, isValidation },
      orderBy: { classificationDate: 'desc' },
      take: limit,
      select: PUBLIC_ROW_SELECT,
    });
    return rows.map(mapClassificationRow);
  },
};
