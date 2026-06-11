-- CreateTable
CREATE TABLE "trading_accounts" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "account_type" VARCHAR(20) NOT NULL,
    "account_name" VARCHAR(120) NOT NULL,
    "account_size" DECIMAL(20,2) NOT NULL,
    "current_balance" DECIMAL(20,2) NOT NULL,
    "currency" VARCHAR(8) NOT NULL DEFAULT 'USD',
    "status" VARCHAR(20) NOT NULL DEFAULT 'Active',
    "starting_date" DATE NOT NULL,
    "broker" VARCHAR(120),
    "profit_goal_pct" DECIMAL(8,2),
    "prop_firm" VARCHAR(120),
    "stage" VARCHAR(20),
    "max_drawdown_pct" DECIMAL(8,2),
    "profit_target_pct" DECIMAL(8,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trading_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "account_id" TEXT NOT NULL,
    "model" VARCHAR(60) NOT NULL,
    "pair" VARCHAR(20) NOT NULL,
    "direction" VARCHAR(8) NOT NULL,
    "entry_price" DECIMAL(20,6) NOT NULL,
    "sl_price" DECIMAL(20,6) NOT NULL,
    "first_tp_price" DECIMAL(20,6),
    "main_tp_price" DECIMAL(20,6) NOT NULL,
    "partial_exit_price" DECIMAL(20,6),
    "partial_exit_lot_pct" DECIMAL(8,2),
    "main_exit_price" DECIMAL(20,6),
    "lot_size" DECIMAL(12,4) NOT NULL,
    "total_pips" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "risk_pct" DECIMAL(8,2) NOT NULL,
    "conviction" VARCHAR(10) NOT NULL,
    "blended_pnl" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "blended_rr" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "exit_type" VARCHAR(16) NOT NULL DEFAULT 'TP',
    "date_opened" TIMESTAMP(3) NOT NULL,
    "date_closed" TIMESTAMP(3),
    "session" VARCHAR(24) NOT NULL,
    "fundamental_score" SMALLINT,
    "screenshots" TEXT[],
    "psychology" VARCHAR(120),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planned_trades" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "pair" VARCHAR(20) NOT NULL,
    "model" VARCHAR(60) NOT NULL,
    "direction" VARCHAR(8) NOT NULL,
    "planned_entry" DECIMAL(20,6) NOT NULL,
    "planned_sl" DECIMAL(20,6) NOT NULL,
    "planned_first_tp" DECIMAL(20,6),
    "planned_main_tp" DECIMAL(20,6) NOT NULL,
    "planned_risk_pct" DECIMAL(8,2) NOT NULL,
    "conviction" VARCHAR(10) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'Watching',
    "date_added" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "screenshots" TEXT[],
    "current_market_price" DECIMAL(20,6) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "planned_trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_flows" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "account_id" TEXT NOT NULL,
    "type" VARCHAR(16) NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "date" DATE NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_flows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trading_models" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "description" VARCHAR(200) NOT NULL DEFAULT '',
    "rules" TEXT NOT NULL DEFAULT '',
    "status" VARCHAR(12) NOT NULL DEFAULT 'Active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trading_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trading_pairs" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "symbol" VARCHAR(20) NOT NULL,
    "display_name" VARCHAR(40) NOT NULL,
    "flag_a" VARCHAR(16) NOT NULL,
    "flag_b" VARCHAR(16) NOT NULL,
    "pip_value" DECIMAL(12,4) NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'Active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trading_pairs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "trading_accounts_user_id_created_at_idx" ON "trading_accounts"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "trading_accounts_user_id_status_idx" ON "trading_accounts"("user_id", "status");

-- CreateIndex
CREATE INDEX "trades_user_id_date_opened_idx" ON "trades"("user_id", "date_opened" DESC);

-- CreateIndex
CREATE INDEX "trades_user_id_account_id_idx" ON "trades"("user_id", "account_id");

-- CreateIndex
CREATE INDEX "trades_account_id_idx" ON "trades"("account_id");

-- CreateIndex
CREATE INDEX "planned_trades_user_id_status_idx" ON "planned_trades"("user_id", "status");

-- CreateIndex
CREATE INDEX "planned_trades_user_id_date_added_idx" ON "planned_trades"("user_id", "date_added" DESC);

-- CreateIndex
CREATE INDEX "cash_flows_account_id_date_idx" ON "cash_flows"("account_id", "date");

-- CreateIndex
CREATE INDEX "cash_flows_user_id_idx" ON "cash_flows"("user_id");

-- CreateIndex
CREATE INDEX "trading_models_user_id_idx" ON "trading_models"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "trading_models_user_id_name_key" ON "trading_models"("user_id", "name");

-- CreateIndex
CREATE INDEX "trading_pairs_user_id_idx" ON "trading_pairs"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "trading_pairs_user_id_symbol_key" ON "trading_pairs"("user_id", "symbol");

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_flows" ADD CONSTRAINT "cash_flows_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

