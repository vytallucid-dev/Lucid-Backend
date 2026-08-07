-- B2 — deferral (snooze) state for overdue calendar events.
--
-- PURELY ADDITIVE. One new table, one new back-relation column added to two
-- existing models (no column type changes, no data rewritten).
--
-- Deferral is a SNOOZE, never a suppression: entering a DataPoint for the
-- indicator/variant/date an overdue event resolves to clears its overdue
-- status unconditionally, regardless of any deferral row that exists for it.
-- Deferral rows are never read by the overdue check itself — they are read
-- only when deciding whether an overdue event should be SURFACED (badge
-- count, due-today list) versus recessed into the deferred list.
--
-- TWO SHAPES IN ONE TABLE, DISTINGUISHED BY calendar_event_id:
--   NOT NULL — a one-off deferral of exactly that scheduled occurrence.
--   NULL     — a STANDING deferral of (indicator_id, variant): "also apply
--              to future releases of the same indicator" from B2. Matches
--              any future overdue event for that indicator+variant, not just
--              the one being deferred at creation time.
--
-- A partial unique index enforces "at most one standing deferral per
-- (indicator_id, variant)" — partial because the constraint only applies
-- when calendar_event_id IS NULL; two one-off deferrals of two different
-- events must both be allowed to coexist, and Prisma's schema DSL has no
-- native partial-unique syntax, hence the raw index below.

CREATE TABLE "calendar_event_deferrals" (
    "id" TEXT NOT NULL,
    "calendar_event_id" TEXT,
    "indicator_id" TEXT NOT NULL,
    "indicator_code" VARCHAR(50) NOT NULL,
    "variant" VARCHAR(20),
    "defer_until" DATE,
    "reason" VARCHAR(280),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "calendar_event_deferrals_pkey" PRIMARY KEY ("id")
);

-- Hot path: does this specific event have a one-off deferral?
CREATE INDEX "calendar_event_deferrals_calendar_event_id_idx"
    ON "calendar_event_deferrals"("calendar_event_id");

-- Hot path: does this (indicator, variant) have a standing deferral, and the
-- badge/list resolver's per-indicator lookup generally.
CREATE INDEX "calendar_event_deferrals_indicator_id_variant_idx"
    ON "calendar_event_deferrals"("indicator_id", "variant");

-- Partial unique: at most one STANDING (calendar_event_id IS NULL) deferral
-- per (indicator_id, variant). NULL is not distinct-per-row here the way it
-- is in a normal unique index — the WHERE clause is what makes this apply
-- only to the standing-deferral rows, which is the shape that needs
-- uniqueness; one-off deferrals (calendar_event_id NOT NULL) are excluded
-- from this index entirely and may repeat freely across different events.
CREATE UNIQUE INDEX "calendar_event_deferrals_standing_unique"
    ON "calendar_event_deferrals"("indicator_id", "variant")
    WHERE "calendar_event_id" IS NULL;

-- Deliberately NOT onDelete CASCADE from calendar_events: a deferred event is
-- exactly the kind of row worth keeping deferral history for even if the
-- underlying calendar_events row were ever purged. calendar_events rows are
-- never deleted in practice (permanent retention — see that model's own
-- comment), so this is belt-and-braces rather than a path this schema
-- expects to exercise.
ALTER TABLE "calendar_event_deferrals" ADD CONSTRAINT "calendar_event_deferrals_calendar_event_id_fkey"
    FOREIGN KEY ("calendar_event_id") REFERENCES "calendar_events"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- indicator_id IS required on every row (both shapes), so this FK is a
-- normal CASCADE: a deleted indicator's deferral history has nothing left to
-- refer to.
ALTER TABLE "calendar_event_deferrals" ADD CONSTRAINT "calendar_event_deferrals_indicator_id_fkey"
    FOREIGN KEY ("indicator_id") REFERENCES "indicators"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
