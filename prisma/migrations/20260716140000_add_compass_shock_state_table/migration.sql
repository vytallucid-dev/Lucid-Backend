-- Compass v2 Phase 4: cache table for the Shock Layer's two triggers
-- (Trigger A / Vol Shock, Trigger B / Carry Shock). This table is NOT the
-- source of truth — it can be wiped and fully recomputed by re-scanning
-- VIX/OAS/USDJPY history via compass-shock-layer.ts (see
-- compass-shock-state.repository.ts for the read/write wrapper). One
-- current row per is_validation space (live vs backfill/validation),
-- matching compass_curve_state's and compass_inputs' partitioning
-- convention.
CREATE TABLE "compass_shock_state" (
    "id" TEXT NOT NULL,
    "is_validation" BOOLEAN NOT NULL DEFAULT false,
    "computed_for_date" DATE NOT NULL,
    "shock_a_active" BOOLEAN NOT NULL DEFAULT false,
    "shock_a_expiry" DATE,
    "shock_b_active" BOOLEAN NOT NULL DEFAULT false,
    "shock_b_expiry" DATE,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compass_shock_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "compass_shock_state_is_validation_key" ON "compass_shock_state"("is_validation");
