-- Compass Phase C — the two-layer architecture's storage.
--
-- Layer 1: compass_module_readings + compass_module_states
-- Layer 2: compass_synthesis
--
-- THE DESIGN REQUIREMENT these tables exist to satisfy is that a module must be
-- able to emit a state label that is NOT a vote. So a reading has two
-- independent axes:
--
--     vote axis   (color_band, is_voting, weight)
--     state axis  (state_label)
--
-- A voting input sets the first and leaves state_label null. A non-voting
-- reading — a term-premium level, the hedged 30-year JPY pickup, a co-movement
-- state — sets color_band NULL / is_voting false / weight NULL and may carry a
-- state_label that describes the market without expressing an opinion about risk
-- appetite. Nothing in the vote path reads state_label; nothing in the state path
-- reads color_band.
--
-- That separation is what makes a future "repricing regime" reading (the 2022
-- case, which the current architecture is structurally unable to register) a new
-- reading_code plus a layer-2 template, with NO migration and no change to
-- scoring. compass_module_states.verdict_band is nullable for the same reason:
-- the Policy Stance module has no verdict, and forcing one would manufacture an
-- opinion the evidence does not support.
--
-- PROVENANCE IS MANDATORY. Every reading records source_code, source_as_of and
-- staleness_state, because the UI renders all three next to every number.
--
-- EXPLANATIONS ARE {templateId, params}, NEVER PROSE. Storing rendered text would
-- let a later template edit silently rewrite history; storing the inputs to a
-- pure render function keeps output reproducible and auditable.
--
-- research_tag is NOT NULL DEFAULT '' on all three tables because it participates
-- in their unique keys, and Postgres treats NULLs as distinct in a unique index —
-- a nullable column would silently permit duplicate rows for the same date.

CREATE TABLE "compass_module_readings" (
    "id"                   TEXT NOT NULL,
    "classification_date"  DATE NOT NULL,
    "module_code"          VARCHAR(30) NOT NULL,
    "reading_code"         VARCHAR(40) NOT NULL,

    -- vote axis (all null for a non-voting reading)
    "color_band"           VARCHAR(10),
    "is_voting"            BOOLEAN NOT NULL DEFAULT false,
    "weight"               DECIMAL(5,2),

    -- state axis: a label that is not a vote
    "state_label"          VARCHAR(40),

    -- value
    "value_numeric"        DECIMAL(20,6),
    "value_text"           VARCHAR(120),
    "unit"                 VARCHAR(16),

    -- provenance
    "source_code"          VARCHAR(40) NOT NULL,
    "source_as_of"         DATE,
    "staleness_state"      VARCHAR(12) NOT NULL,
    "staleness_days"       INTEGER,

    "explanation"          JSONB,

    "config_version_label" VARCHAR(20),
    "research_tag"         VARCHAR(40) NOT NULL DEFAULT '',
    "is_validation"        BOOLEAN NOT NULL DEFAULT false,
    "computed_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compass_module_readings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "compass_module_readings_unique_key"
    ON "compass_module_readings" ("classification_date", "module_code", "reading_code", "is_validation", "research_tag");

CREATE INDEX "compass_module_readings_date_module_idx"
    ON "compass_module_readings" ("classification_date" DESC, "module_code");

CREATE INDEX "compass_module_readings_reading_date_idx"
    ON "compass_module_readings" ("reading_code", "classification_date" DESC);

CREATE TABLE "compass_module_states" (
    "id"                   TEXT NOT NULL,
    "classification_date"  DATE NOT NULL,
    "module_code"          VARCHAR(30) NOT NULL,
    -- NULL for a module that does not vote (Policy Stance).
    "verdict_band"         VARCHAR(10),
    "state_label"          VARCHAR(40),
    "headline"             JSONB NOT NULL,
    "reading_codes"        JSONB NOT NULL,
    "config_version_label" VARCHAR(20),
    "research_tag"         VARCHAR(40) NOT NULL DEFAULT '',
    "is_validation"        BOOLEAN NOT NULL DEFAULT false,
    "computed_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compass_module_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "compass_module_states_unique_key"
    ON "compass_module_states" ("classification_date", "module_code", "is_validation", "research_tag");

CREATE INDEX "compass_module_states_date_idx"
    ON "compass_module_states" ("classification_date" DESC);

CREATE TABLE "compass_synthesis" (
    "id"                   TEXT NOT NULL,
    "classification_date"  DATE NOT NULL,
    -- ordered [{ templateId, params, text, traces:[{moduleCode,readingCode}] }]
    -- every sentence MUST carry at least one trace that resolves to a
    -- compass_module_readings row for the same date.
    "sentences"            JSONB NOT NULL,
    -- same shape; module disagreement is surfaced, never averaged away.
    "disagreements"        JSONB NOT NULL,
    "config_version_label" VARCHAR(20),
    "research_tag"         VARCHAR(40) NOT NULL DEFAULT '',
    "is_validation"        BOOLEAN NOT NULL DEFAULT false,
    "computed_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compass_synthesis_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "compass_synthesis_unique_key"
    ON "compass_synthesis" ("classification_date", "is_validation", "research_tag");

CREATE INDEX "compass_synthesis_date_idx"
    ON "compass_synthesis" ("classification_date" DESC);
