-- Compass v2 Phase 2B: cache table for the T10Y2Y inversion episode state
-- machine. This table is NOT the source of truth for episode state — it can
-- be wiped and fully recomputed by re-scanning T10Y2Y history via
-- compass-curve-state-machine.ts (see compass-curve-state.repository.ts for
-- the read/write wrapper). One current row per is_validation space (live vs
-- backfill/validation), matching the existing compass_inputs /
-- compass_classifications isValidation partitioning convention.
CREATE TABLE "compass_curve_state" (
    "id" TEXT NOT NULL,
    "is_validation" BOOLEAN NOT NULL DEFAULT false,
    "computed_for_date" DATE NOT NULL,
    "inversion_start" DATE,
    "un_inversion_date" DATE,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compass_curve_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "compass_curve_state_is_validation_key" ON "compass_curve_state"("is_validation");
