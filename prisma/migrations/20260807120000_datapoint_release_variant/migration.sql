-- Release variant as a first-class field (Flash/Final, Advance/Second/Third,
-- Prelim/Final, ...). Admin/manual-entry + EdgeFinder scoring only. NIFTY,
-- Forex Factory ingestion, and scoring's as-printed-vintage question are all
-- explicitly out of scope for this migration.
--
-- PURELY ADDITIVE. No column or table is dropped. No row is deleted. No
-- existing data is rewritten (see the follow-up UPDATE below, which only sets
-- the new is_legacy_variant flag on rows already in the table — it changes no
-- other column).
--
-- 1) data_points gains:
--      variant           nullable — null means single-release indicator,
--                        the common case, and must stay clean.
--      is_legacy_variant boolean, default false — true only for rows that
--                        existed on a multi-variant indicator before variants
--                        existed. Never inferred which variant they were
--                        (precedent: deprecated IND_NIFTY_03_CPI rows, 2025
--                        AUD discontinuity flags — flag and leave alone).
--    The existing unique constraint
--      (indicator_id, observation_date, vintage_date)
--    is replaced by
--      (indicator_id, observation_date, variant, vintage_date)
--    so Flash and Final can coexist on the same observation_date. Postgres
--    treats NULL as distinct per row in a unique index, so single-release
--    indicators (variant always null) keep exactly the collision behaviour
--    they had before this migration — this is not a behaviour change for
--    them.
--
-- 2) indicator_variants is a new registry table: the allowed variant set and
--    ordinal (Flash 1 / Final 2, Advance 1 / Second 2 / Third 3, ...) per
--    indicator. Data, not an application-code enum — a new release type is a
--    row insert here, never a code change. No indicator has a row yet; this
--    migration creates the table only. Seeding (which indicators from the
--    prompt's list get variant rows) is done via a TS script, matching how
--    ScoringRule / compass_config rows are seeded rather than raw SQL
--    inserts (see prisma/seed-edgefinder.ts, prisma/seed-compass-config.ts).

-- =========================================================
-- AlterTable: data_points
-- =========================================================

ALTER TABLE "data_points" ADD COLUMN "variant" VARCHAR(20);
ALTER TABLE "data_points" ADD COLUMN "is_legacy_variant" BOOLEAN NOT NULL DEFAULT false;

-- DropIndex (old 3-column unique constraint)
DROP INDEX "data_points_indicator_id_observation_date_vintage_date_key";

-- CreateIndex (new 4-column unique constraint, variant included)
CREATE UNIQUE INDEX "data_points_indicator_id_observation_date_variant_vintage_key" ON "data_points"("indicator_id", "observation_date", "variant", "vintage_date");

-- CreateIndex: hot path for scoring resolution (B3) — latest release for an
-- indicator regardless of variant. isCurrent narrows to (indicator,
-- observationDate, variant); the remaining variant-ordinal tiebreak happens
-- in application code against IndicatorVariant, not as a DB sort here.
CREATE INDEX "data_points_indicator_current_date_idx" ON "data_points"("indicator_id", "is_current", "observation_date" DESC);

-- =========================================================
-- CreateTable: indicator_variants
-- =========================================================

CREATE TABLE "indicator_variants" (
    "id" TEXT NOT NULL,
    "indicator_id" TEXT NOT NULL,
    "variant" VARCHAR(20) NOT NULL,
    "ordinal" SMALLINT NOT NULL,
    "is_final" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "indicator_variants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "indicator_variants_indicator_id_variant_key" ON "indicator_variants"("indicator_id", "variant");
CREATE UNIQUE INDEX "indicator_variants_indicator_id_ordinal_key" ON "indicator_variants"("indicator_id", "ordinal");
CREATE INDEX "indicator_variants_indicator_id_idx" ON "indicator_variants"("indicator_id");

ALTER TABLE "indicator_variants" ADD CONSTRAINT "indicator_variants_indicator_id_fkey" FOREIGN KEY ("indicator_id") REFERENCES "indicators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =========================================================
-- Data: flag pre-existing rows on multi-variant indicators as legacy
-- =========================================================
--
-- B2: every DataPoint that already existed on an indicator which is about to
-- become multi-variant gets is_legacy_variant = true. This runs BEFORE
-- indicator_variants is seeded (seeding happens in a separate TS script,
-- next step in the rollout) so "which indicators are multi-variant" cannot
-- be read from indicator_variants yet — it is named explicitly here, sourced
-- directly from the prompt's list. This is the one and only place any
-- indicator code is named in this migration; the seed script is the
-- authoritative registry from this point forward, and this list is never
-- read again after this migration runs.
UPDATE "data_points" dp
SET "is_legacy_variant" = true
FROM "indicators" i
WHERE dp."indicator_id" = i."id"
  AND i."code" IN (
    'EU_MFG_PMI', 'EU_SVC_PMI',
    'UK_MFG_PMI', 'UK_SVC_PMI',
    'JP_MFG_PMI', 'JP_SVC_PMI',
    'AU_PMI_MFG', 'AU_PMI_SVC',
    'US_GDP_QOQ',
    'EU_GDP_QOQ',
    'JP_GDP_QOQ',
    'JP_CASH_EARNINGS_YOY'
  );
