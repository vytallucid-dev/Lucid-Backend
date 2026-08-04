-- Multi-account trade logging.
--
-- Trade = the idea (setup, rationale). Execution = the fill, per account.
-- Every existing Trade row becomes one Trade (idea fields only) plus exactly
-- one Execution (all execution-specific fields, carried over verbatim,
-- flagged primary). No data is discarded: entry_price/sl_price/first_tp_price/
-- main_tp_price are renamed in place (RENAME COLUMN, not drop+add) so their
-- values survive untouched as the trade's planned prices, and execution-level
-- fields are copied into the new executions table before being dropped from
-- trades. This entire file runs in one transaction — it either fully applies
-- or fully rolls back.

-- 1. New table: Execution, one row per account-fill of an idea.
CREATE TABLE "executions" (
    "id"                    TEXT NOT NULL,
    "trade_id"              TEXT NOT NULL,
    "account_id"            TEXT NOT NULL,
    "is_primary"            BOOLEAN NOT NULL DEFAULT false,
    "risk_pct"              DECIMAL(8,2) NOT NULL,
    "lot_size"              DECIMAL(12,4) NOT NULL,
    "entry_price"           DECIMAL(20,6) NOT NULL,
    "partial_exit_price"    DECIMAL(20,6),
    "partial_exit_lot_pct"  DECIMAL(8,2),
    "main_exit_price"       DECIMAL(20,6),
    "exit_type"             VARCHAR(16) NOT NULL DEFAULT 'TP',
    "date_closed"           TIMESTAMP(3),
    "total_pips"            DECIMAL(12,2) NOT NULL DEFAULT 0,
    "blended_pnl"           DECIMAL(20,2) NOT NULL DEFAULT 0,
    "blended_rr"            DECIMAL(12,2) NOT NULL DEFAULT 0,
    "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"            TIMESTAMP(3) NOT NULL,

    CONSTRAINT "executions_pkey" PRIMARY KEY ("id")
);

-- 2. Rename Trade's price columns to what they actually are: the plan.
--    RENAME preserves every existing value; nothing is dropped or recomputed.
ALTER TABLE "trades" RENAME COLUMN "entry_price" TO "planned_entry";
ALTER TABLE "trades" RENAME COLUMN "sl_price" TO "planned_sl";
ALTER TABLE "trades" RENAME COLUMN "first_tp_price" TO "planned_first_tp";
ALTER TABLE "trades" RENAME COLUMN "main_tp_price" TO "planned_main_tp";

-- 3. Backfill: one Execution per existing Trade, flagged primary, carrying
--    its original account and every execution-level field verbatim. The
--    execution's actual entry price is backfilled from the trade's (now
--    renamed) planned_entry column, since today's one-row-per-account model
--    never distinguished "planned" from "actual fill" — they were the same
--    value. createdAt/updatedAt are preserved from the source trade row so
--    execution history reads consistently with when the trade was logged.
INSERT INTO "executions" (
    "id", "trade_id", "account_id", "is_primary",
    "risk_pct", "lot_size", "entry_price",
    "partial_exit_price", "partial_exit_lot_pct", "main_exit_price",
    "exit_type", "date_closed", "total_pips", "blended_pnl", "blended_rr",
    "created_at", "updated_at"
)
SELECT
    gen_random_uuid()::text, "id", "account_id", true,
    "risk_pct", "lot_size", "planned_entry",
    "partial_exit_price", "partial_exit_lot_pct", "main_exit_price",
    "exit_type", "date_closed", "total_pips", "blended_pnl", "blended_rr",
    "created_at", "updated_at"
FROM "trades";

-- 4. Foreign keys, now that parent rows (trades, trading_accounts) and the
--    backfilled child rows both exist and match.
ALTER TABLE "executions" ADD CONSTRAINT "executions_trade_id_fkey"
    FOREIGN KEY ("trade_id") REFERENCES "trades"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "executions" ADD CONSTRAINT "executions_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 5. Indexes.
CREATE INDEX "executions_trade_id_idx" ON "executions"("trade_id");
CREATE INDEX "executions_account_id_idx" ON "executions"("account_id");
CREATE INDEX "executions_account_id_date_closed_idx" ON "executions"("account_id", "date_closed");

-- 6. At most one primary execution per trade. Prisma's schema language cannot
--    express a WHERE-qualified unique index, so it is added here as raw SQL.
CREATE UNIQUE INDEX "executions_one_primary_per_trade" ON "executions"("trade_id") WHERE "is_primary" = true;

-- 7. Drop the now-migrated execution-level columns and their supporting
--    constraints/indexes from trades. Every value they held now lives on the
--    corresponding primary Execution row (step 3) — nothing here is losing
--    data, only its location.
ALTER TABLE "trades" DROP CONSTRAINT "trades_account_id_fkey";
DROP INDEX "trades_user_id_account_id_idx";
DROP INDEX "trades_account_id_idx";

ALTER TABLE "trades"
    DROP COLUMN "account_id",
    DROP COLUMN "risk_pct",
    DROP COLUMN "lot_size",
    DROP COLUMN "partial_exit_price",
    DROP COLUMN "partial_exit_lot_pct",
    DROP COLUMN "main_exit_price",
    DROP COLUMN "exit_type",
    DROP COLUMN "date_closed",
    DROP COLUMN "total_pips",
    DROP COLUMN "blended_pnl",
    DROP COLUMN "blended_rr";
