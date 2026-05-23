-- EdgeFinder Phase 7D: validation flag + validation report table
-- Adds is_validation flag to compass_inputs and compass_classifications so
-- historical backfill rows can coexist with live data without leaking into
-- live read paths. Existing rows default to is_validation = false.
--
-- Also adds compass_validation_reports for persisting harness output.

-- compass_inputs: is_validation column + index + composite unique
ALTER TABLE "compass_inputs"
  ADD COLUMN "is_validation" BOOLEAN NOT NULL DEFAULT false;

DROP INDEX IF EXISTS "compass_inputs_observation_date_input_code_key";

ALTER TABLE "compass_inputs"
  ADD CONSTRAINT "compass_inputs_observation_date_input_code_is_validation_key"
  UNIQUE ("observation_date", "input_code", "is_validation");

CREATE INDEX "compass_inputs_observation_date_is_validation_idx"
  ON "compass_inputs" ("observation_date", "is_validation");

-- compass_classifications: is_validation column + index
ALTER TABLE "compass_classifications"
  ADD COLUMN "is_validation" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "compass_classifications_classification_date_is_validation_idx"
  ON "compass_classifications" ("classification_date", "is_validation");

-- compass_validation_reports: new table
CREATE TABLE "compass_validation_reports" (
  "id"             TEXT NOT NULL,
  "generated_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "overall_passed" BOOLEAN NOT NULL,
  "window_results" JSONB NOT NULL,
  "summary"        TEXT NOT NULL,

  CONSTRAINT "compass_validation_reports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "compass_validation_reports_generated_at_idx"
  ON "compass_validation_reports" ("generated_at" DESC);
