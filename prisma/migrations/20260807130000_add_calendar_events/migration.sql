-- Forex Factory calendar event storage.
--
-- PURELY ADDITIVE. One new table. No existing column is altered or dropped,
-- no existing row is read or rewritten, and no existing behaviour changes.
-- Scoring is untouched by this migration — calendar_events feeds the calendar
-- page and the admin unmapped queue only, and nothing in the scoring path
-- reads it.
--
-- WHY A NEW TABLE RATHER THAN data_points
-- ---------------------------------------
-- data_points models an OBSERVATION: it requires a numeric `value` and is
-- keyed by (indicator_id, observation_date, variant, vintage_date). A
-- scheduled release that has not published yet has no value and therefore
-- cannot be represented there at all. calendar_events models the RELEASE
-- SCHEDULE — an event exists here from the moment Forex Factory announces it,
-- with actual_raw staying NULL until the print lands.
--
-- RETENTION IS PERMANENT
-- ----------------------
-- ff_calendar_thisweek.json is current-week-only; ff_calendar_nextweek.json
-- and ff_calendar_lastweek.json both return HTTP 404 (verified). A week not
-- captured while it is "this week" cannot be re-fetched. Nothing prunes this
-- table.
--
-- TIME IS STORED AS A UTC INSTANT
-- -------------------------------
-- The feed sends ISO-8601 with a -04:00 offset on every event. Ingest
-- converts to UTC; TIMESTAMP(3) here holds that instant. Never a local-time
-- string, and never a bare date — every observed event carries a real time
-- component (0 of 99 events at T00:00:00, 46 distinct clock times). The
-- render layer converts back to the viewer's selected timezone.
--
-- forecast_raw IS REFERENCE ONLY
-- ------------------------------
-- It is Forex Factory's own consensus, which is considered unreliable; the
-- user enters forecasts manually from Trading Economics. No scoring path may
-- read this column. It is stored so a future cross-check can compare the two
-- sources — reading it into the surprise calculation would corrupt scores.

-- =========================================================
-- CreateTable: calendar_events
-- =========================================================

CREATE TABLE "calendar_events" (
    "id" TEXT NOT NULL,
    "source" VARCHAR(30) NOT NULL DEFAULT 'forex_factory',
    "country" VARCHAR(8) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "impact" VARCHAR(16) NOT NULL,
    "forecast_raw" VARCHAR(40),
    "previous_raw" VARCHAR(40),
    "actual_raw" VARCHAR(40),
    "indicator_id" TEXT,
    "indicator_code" VARCHAR(50),
    "variant" VARCHAR(20),
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "fetched_via" TEXT,

    CONSTRAINT "calendar_events_pkey" PRIMARY KEY ("id")
);

-- Natural key: re-fetching the same event UPDATES rather than duplicates.
-- Load-bearing — the feed is pulled twice daily and every run re-sends the
-- entire week, so without this each event would insert ~14 times per week.
--
-- scheduled_at participates because Forex Factory reschedules events. A moved
-- release is genuinely a different occurrence; collapsing it onto the original
-- would lose the original slot. A rescheduled event appears as a new row, and
-- that is intended.
--
-- country is FF's value, which is a CURRENCY code (CNY, AUD), not the ISO code
-- indicators.country stores (CN, AU). Deliberately not reconciled here so the
-- key remains a faithful record of what upstream actually sent.
CREATE UNIQUE INDEX "calendar_events_source_country_title_scheduled_at_key"
    ON "calendar_events"("source", "country", "title", "scheduled_at");

-- Hot path: the calendar page's "today + rest of this week" window.
CREATE INDEX "calendar_events_scheduled_at_idx" ON "calendar_events"("scheduled_at");

-- Serves the per-indicator lookup AND the admin unmapped queue. The queue is
-- `indicator_id IS NULL ORDER BY scheduled_at DESC`, which this index
-- satisfies directly (a btree indexes NULLs).
CREATE INDEX "calendar_events_indicator_id_scheduled_at_idx"
    ON "calendar_events"("indicator_id", "scheduled_at" DESC);

-- indicator_id is NULLABLE by design: NULL is the unmapped queue. The FK is
-- still declared so a non-null value can never point at a deleted indicator.
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_indicator_id_fkey"
    FOREIGN KEY ("indicator_id") REFERENCES "indicators"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_fetched_via_fkey"
    FOREIGN KEY ("fetched_via") REFERENCES "data_fetch_log"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
