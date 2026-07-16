import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '@core/db/prisma';
import { AppError } from '@core/middleware/error-handler';

export const cycleStancesRouter = Router();

// Auth is enforced upstream at the /api/admin mount (requireAuth + requireRole('admin')).

const VALID_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY'] as const;
const VALID_STANCES = ['CUTTING', 'NEUTRAL', 'HIKING'] as const;
// Phase 6 (Addendum 8B): the Fed constraint for the gold override gate. A
// global, effective-dated judgment value stored on the USD cycle-stance rows.
const VALID_FED_CONSTRAINTS = ['FREE', 'CONSTRAINED'] as const;

type CurrencyCode = (typeof VALID_CURRENCIES)[number];
type Stance = (typeof VALID_STANCES)[number];
type FedConstraint = (typeof VALID_FED_CONSTRAINTS)[number];

const updateStanceSchema = z.object({
  stance: z.enum(VALID_STANCES),
  effectiveFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
    .optional(),
  notes: z.string().max(500).optional(),
  // Only meaningful on USD rows (Fed ↔ USD). Ignored for other currencies.
  fedConstraint: z.enum(VALID_FED_CONSTRAINTS).optional(),
});

/**
 * GET /api/admin/cycle-stances
 * Returns the active cycle stance for all 4 currencies.
 */
cycleStancesRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const today = new Date();

    const stances = await prisma.currencyCycleStance.findMany({
      where: {
        effectiveFrom: { lte: today },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }],
      },
      orderBy: [{ currencyCode: 'asc' }, { effectiveFrom: 'desc' }],
    });

    // Deduplicate — keep only the latest active row per currency
    const seen = new Set<string>();
    const active = stances.filter((s) => {
      if (seen.has(s.currencyCode)) return false;
      seen.add(s.currencyCode);
      return true;
    });

    res.json({
      success: true,
      stances: active.map((s) => ({
        id: s.id,
        currencyCode: s.currencyCode,
        stance: s.stance,
        effectiveFrom: s.effectiveFrom.toISOString().slice(0, 10),
        effectiveTo: s.effectiveTo ? s.effectiveTo.toISOString().slice(0, 10) : null,
        notes: s.notes ?? null,
        // Phase 6: only USD rows carry it; null elsewhere. Absent → FREE at read.
        fedConstraint: s.currencyCode === 'USD' ? s.fedConstraint ?? 'FREE' : null,
      })),
      validCurrencies: VALID_CURRENCIES,
      validStances: VALID_STANCES,
      validFedConstraints: VALID_FED_CONSTRAINTS,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/admin/cycle-stances/:currencyCode
 * Updates (or creates) the cycle stance for one currency.
 *
 * Closes the current open-ended row (sets effectiveTo = today - 1 day)
 * and opens a new row from effectiveFrom (defaults to today).
 *
 * Body: { stance: 'CUTTING' | 'NEUTRAL' | 'HIKING', effectiveFrom?: 'YYYY-MM-DD', notes?: string }
 */
cycleStancesRouter.put(
  '/:currencyCode',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const currencyCode = (req.params.currencyCode as string)?.toUpperCase() as CurrencyCode;
      if (!VALID_CURRENCIES.includes(currencyCode)) {
        throw new AppError(
          400,
          `Invalid currency code. Must be one of: ${VALID_CURRENCIES.join(', ')}`,
          'INVALID_CURRENCY_CODE',
          { received: req.params.currencyCode, valid: VALID_CURRENCIES },
        );
      }

      const parsed = updateStanceSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, 'Invalid body', 'VALIDATION_ERROR', parsed.error.flatten());
      }

      const { stance, notes } = parsed.data;
      const effectiveFromRaw = parsed.data.effectiveFrom;
      // fedConstraint is only stored on USD rows (Fed ↔ USD); ignored elsewhere.
      const fedConstraint: FedConstraint | undefined =
        currencyCode === 'USD' ? parsed.data.fedConstraint : undefined;

      const effectiveFrom = effectiveFromRaw
        ? new Date(`${effectiveFromRaw}T00:00:00.000Z`)
        : new Date(
            Date.UTC(
              new Date().getUTCFullYear(),
              new Date().getUTCMonth(),
              new Date().getUTCDate(),
            ),
          );

      const triggeredBy = req.user?.email ?? null;

      const result = await prisma.$transaction(async (tx) => {
        // Close any currently open row for this currency
        const openRow = await tx.currencyCycleStance.findFirst({
          where: {
            currencyCode,
            effectiveTo: null,
          },
          orderBy: { effectiveFrom: 'desc' },
        });

        if (openRow) {
          const sameEffectiveFrom = openRow.effectiveFrom.getTime() === effectiveFrom.getTime();

          if (sameEffectiveFrom) {
            // Same effectiveFrom — update the existing row in-place to avoid unique constraint violation
            const isUnchanged =
              openRow.stance === stance &&
              (notes === undefined || notes === openRow.notes) &&
              (fedConstraint === undefined || fedConstraint === openRow.fedConstraint);
            const updated = await tx.currencyCycleStance.update({
              where: { id: openRow.id },
              data: {
                stance: stance as Stance,
                notes: notes ?? openRow.notes,
                fedConstraint: fedConstraint ?? openRow.fedConstraint,
              },
            });
            return {
              action: isUnchanged ? ('unchanged' as const) : ('updated' as const),
              row: updated,
            };
          }

          // Different effectiveFrom — close the current row: set effectiveTo to effectiveFrom - 1 day
          const closeDate = new Date(effectiveFrom);
          closeDate.setUTCDate(closeDate.getUTCDate() - 1);

          await tx.currencyCycleStance.update({
            where: { id: openRow.id },
            data: { effectiveTo: closeDate },
          });
        }

        // Insert the new stance row (only reached when effectiveFrom differs from open row).
        // fedConstraint carries forward from the closed row unless a new value
        // was supplied — so a plain stance change on USD doesn't silently reset it.
        const newRow = await tx.currencyCycleStance.create({
          data: {
            currencyCode,
            stance: stance as Stance,
            effectiveFrom,
            effectiveTo: null,
            notes: notes ?? null,
            fedConstraint: fedConstraint ?? openRow?.fedConstraint ?? null,
          },
        });

        return { action: openRow ? ('updated' as const) : ('created' as const), row: newRow };
      });

      res.json({
        success: true,
        action: result.action,
        triggeredBy,
        stance: {
          id: result.row.id,
          currencyCode: result.row.currencyCode,
          stance: result.row.stance,
          effectiveFrom: result.row.effectiveFrom.toISOString().slice(0, 10),
          effectiveTo: result.row.effectiveTo
            ? result.row.effectiveTo.toISOString().slice(0, 10)
            : null,
          notes: result.row.notes ?? null,
          fedConstraint:
            result.row.currencyCode === 'USD' ? result.row.fedConstraint ?? 'FREE' : null,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);
