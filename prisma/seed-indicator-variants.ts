/* eslint-disable no-console */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Release-variant registry seed. The allowed variant set and ordinal per
 * indicator is data (IndicatorVariant rows), never a hardcoded enum in
 * application code — a new release type is a row insert here, never a code
 * change. Every indicator absent from this list stays single-release
 * (DataPoint.variant always null): ISM has no flash, AUD GDP is a single
 * quarterly print, RatingDog China PMI is a single monthly release.
 *
 * Ordinal is the primary tiebreaker scoring uses to resolve which release is
 * "most recent" when Flash and Final share an observationDate (see B3 in
 * src/core/scoring/helpers/latest-release.ts) — it is a property of the
 * release itself, independent of entry order. isFinal marks the ladder's
 * terminal rung, which drives the admin history view's default filter (B5):
 * Finals-only by default for Flash/Final-style indicators, all variants by
 * default for GDP-style ladders where every rung moves meaningfully — see
 * indicator-variant-config.ts for how isFinal maps to that default.
 *
 * Idempotent via upsert on the (indicatorId, variant) unique key.
 */
const VARIANT_SETS: Record<string, { variant: string; ordinal: number; isFinal: boolean }[]> = {
  // EUR/GBP/JPY/AUD Manufacturing and Services PMI: Flash/Final.
  EU_MFG_PMI: [
    { variant: 'flash', ordinal: 1, isFinal: false },
    { variant: 'final', ordinal: 2, isFinal: true },
  ],
  EU_SVC_PMI: [
    { variant: 'flash', ordinal: 1, isFinal: false },
    { variant: 'final', ordinal: 2, isFinal: true },
  ],
  UK_MFG_PMI: [
    { variant: 'flash', ordinal: 1, isFinal: false },
    { variant: 'final', ordinal: 2, isFinal: true },
  ],
  UK_SVC_PMI: [
    { variant: 'flash', ordinal: 1, isFinal: false },
    { variant: 'final', ordinal: 2, isFinal: true },
  ],
  JP_MFG_PMI: [
    { variant: 'flash', ordinal: 1, isFinal: false },
    { variant: 'final', ordinal: 2, isFinal: true },
  ],
  JP_SVC_PMI: [
    { variant: 'flash', ordinal: 1, isFinal: false },
    { variant: 'final', ordinal: 2, isFinal: true },
  ],
  AU_PMI_MFG: [
    { variant: 'flash', ordinal: 1, isFinal: false },
    { variant: 'final', ordinal: 2, isFinal: true },
  ],
  AU_PMI_SVC: [
    { variant: 'flash', ordinal: 1, isFinal: false },
    { variant: 'final', ordinal: 2, isFinal: true },
  ],
  // USD GDP: Advance/Second/Third.
  US_GDP_QOQ: [
    { variant: 'advance', ordinal: 1, isFinal: false },
    { variant: 'second', ordinal: 2, isFinal: false },
    { variant: 'third', ordinal: 3, isFinal: true },
  ],
  // EUR GDP: Prelim/Flash/Final — THIS ORDER IS CORRECT AND READS BACKWARDS.
  //
  // Forex Factory's naming is counterintuitive for the euro-area GDP ladder.
  // Their "Prelim Flash GDP q/q" is the FIRST print (~30 days after quarter
  // end, partial sample). Their "Flash GDP q/q" is the SECOND (~45 days,
  // fuller sample). The word "Prelim" carries the chronological meaning here,
  // NOT the word "Flash" — the opposite of what the names suggest at a glance,
  // and the opposite of every other ladder in this file.
  //
  // Hence prelim = 1, flash = 2. Ordinal is the PRIMARY tiebreaker in
  // core/scoring/helpers/latest-release.ts (deliberately, since vintageDate is
  // entry time and can be out of order), so swapping these two makes scoring
  // silently resolve to the wrong release whenever both share an
  // observationDate.
  //
  // These two ordinals were previously seeded the other way round. Corrected
  // as seed data only, with no migration and no data movement: EU_GDP_QOQ has
  // zero DataPoint rows with a variant set, so there was nothing to reconcile.
  //
  // If you are reading this because the order looks inverted: it is not.
  // Do not "fix" it. See the matching note in forex-factory-event-mapping.ts.
  EU_GDP_QOQ: [
    { variant: 'prelim', ordinal: 1, isFinal: false },
    { variant: 'flash', ordinal: 2, isFinal: false },
    { variant: 'final', ordinal: 3, isFinal: true },
  ],
  // JPY GDP: Prelim/Final.
  JP_GDP_QOQ: [
    { variant: 'prelim', ordinal: 1, isFinal: false },
    { variant: 'final', ordinal: 2, isFinal: true },
  ],
  // JPY Labor Cash Earnings: Prelim/Final.
  JP_CASH_EARNINGS_YOY: [
    { variant: 'prelim', ordinal: 1, isFinal: false },
    { variant: 'final', ordinal: 2, isFinal: true },
  ],
};

async function main() {
  for (const [code, variants] of Object.entries(VARIANT_SETS)) {
    const indicator = await prisma.indicator.findUnique({ where: { code } });
    if (!indicator) {
      console.warn(`SKIP: indicator code "${code}" not found in database — no variant rows created for it.`);
      continue;
    }

    // Two-pass, inside one transaction, because (indicatorId, ordinal) is
    // unique as well as (indicatorId, variant). Re-seeding a ladder whose
    // ordinals were REORDERED (the EU_GDP_QOQ prelim↔flash correction) would
    // collide mid-loop on a naive single pass: writing prelim=1 while flash
    // still holds ordinal 1 violates the unique index, and the outcome would
    // depend on iteration order.
    //
    // Pass 1 parks every existing row on a negative ordinal — outside the
    // range any real ladder uses, so no two rows can collide while parked.
    // Pass 2 writes the intended ordinals into the now-vacant range. The
    // transaction means a failure between passes rolls back rather than
    // leaving the registry parked on negatives.
    await prisma.$transaction(async (tx) => {
      const existing = await tx.indicatorVariant.findMany({
        where: { indicatorId: indicator.id },
        select: { id: true },
      });
      for (const [i, row] of existing.entries()) {
        await tx.indicatorVariant.update({
          where: { id: row.id },
          data: { ordinal: -(i + 1) },
        });
      }

      for (const v of variants) {
        await tx.indicatorVariant.upsert({
          where: { indicatorId_variant: { indicatorId: indicator.id, variant: v.variant } },
          update: { ordinal: v.ordinal, isFinal: v.isFinal },
          create: {
            indicatorId: indicator.id,
            variant: v.variant,
            ordinal: v.ordinal,
            isFinal: v.isFinal,
          },
        });
      }

      // A variant removed from VARIANT_SETS would otherwise stay parked on a
      // negative ordinal and silently outrank nothing while still being an
      // accepted value at manual entry. Fail loudly instead of guessing.
      const stranded = await tx.indicatorVariant.findMany({
        where: { indicatorId: indicator.id, ordinal: { lt: 0 } },
        select: { variant: true },
      });
      if (stranded.length > 0) {
        throw new Error(
          `${code}: variants [${stranded.map((s) => s.variant).join(', ')}] exist in the ` +
            `database but are absent from VARIANT_SETS. Remove them deliberately ` +
            `(they may have DataPoint rows) rather than leaving them unordered.`,
        );
      }
    });
    console.log(`${code}: seeded ${variants.map((v) => v.variant).join('/')}`);
  }

  const total = await prisma.indicatorVariant.count();
  console.log(`Done. indicator_variants now has ${total} rows.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
