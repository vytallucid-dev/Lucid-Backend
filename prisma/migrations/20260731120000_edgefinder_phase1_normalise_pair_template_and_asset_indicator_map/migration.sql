-- EdgeFinder Phase 1 (AUD / JPY / indices expansion): database layer only.
--
-- PURELY ADDITIVE. This migration creates two new tables and backfills them
-- from current state. It does NOT drop, alter or delete any existing column,
-- table or row. The four legacy currency columns on pair_template_rows
-- (us/eur/gbp/jpy_indicator_code) are left in place and remain authoritative
-- until a later phase switches the loader over.
--
-- 1a: pair_template_row_currencies — currency becomes a ROW, not a column, so a
--     5th+ economy is a data insert instead of an ALTER TABLE.
-- 1b: asset_indicator_map — replaces COUNTRY_BY_ASSET (membership) and
--     flipScoreForGold (a single global boolean) with per-(asset, indicator)
--     membership + a signed polarity, because indices need MIXED signs that one
--     boolean cannot express.

-- =========================================================
-- CreateTable
-- =========================================================

CREATE TABLE "pair_template_row_currencies" (
    "id" TEXT NOT NULL,
    "template_row_id" TEXT NOT NULL,
    "currency_code" VARCHAR(3) NOT NULL,
    "indicator_code" VARCHAR(50),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pair_template_row_currencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_indicator_map" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "indicator_id" TEXT NOT NULL,
    "polarity" SMALLINT NOT NULL DEFAULT 1,
    "is_cot" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_indicator_map_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pair_template_row_currencies_currency_code_idx" ON "pair_template_row_currencies"("currency_code");

-- CreateIndex
CREATE INDEX "pair_template_row_currencies_indicator_code_idx" ON "pair_template_row_currencies"("indicator_code");

-- CreateIndex
CREATE UNIQUE INDEX "pair_template_row_currencies_template_row_id_currency_code_key" ON "pair_template_row_currencies"("template_row_id", "currency_code");

-- CreateIndex
CREATE INDEX "asset_indicator_map_asset_id_idx" ON "asset_indicator_map"("asset_id");

-- CreateIndex
CREATE INDEX "asset_indicator_map_indicator_id_idx" ON "asset_indicator_map"("indicator_id");

-- CreateIndex
CREATE UNIQUE INDEX "asset_indicator_map_asset_id_indicator_id_key" ON "asset_indicator_map"("asset_id", "indicator_id");

-- AddForeignKey
ALTER TABLE "pair_template_row_currencies" ADD CONSTRAINT "pair_template_row_currencies_template_row_id_fkey" FOREIGN KEY ("template_row_id") REFERENCES "pair_template_rows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_indicator_map" ADD CONSTRAINT "asset_indicator_map_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_indicator_map" ADD CONSTRAINT "asset_indicator_map_indicator_id_fkey" FOREIGN KEY ("indicator_id") REFERENCES "indicators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Guard: polarity is a sign, never a magnitude. Enforced in the DB so a bad
-- seed cannot silently scale scores. (Not expressible in Prisma schema.)
ALTER TABLE "asset_indicator_map"
  ADD CONSTRAINT "asset_indicator_map_polarity_sign_check" CHECK ("polarity" IN (-1, 1));

-- =========================================================
-- 1a BACKFILL — pair_template_row_currencies
-- Every NON-NULL cell in the four legacy columns becomes exactly one row.
-- Expected: 42 rows (us 14 + eur 9 + gbp 9 + jpy 10).
-- Idempotent: ON CONFLICT DO NOTHING against the (row, currency) unique key.
-- =========================================================

INSERT INTO "pair_template_row_currencies"
  ("id", "template_row_id", "currency_code", "indicator_code", "created_at", "updated_at")
SELECT gen_random_uuid(), t."id", 'USD', t."us_indicator_code", now(), now()
FROM "pair_template_rows" t
WHERE t."us_indicator_code" IS NOT NULL
ON CONFLICT ("template_row_id", "currency_code") DO NOTHING;

INSERT INTO "pair_template_row_currencies"
  ("id", "template_row_id", "currency_code", "indicator_code", "created_at", "updated_at")
SELECT gen_random_uuid(), t."id", 'EUR', t."eur_indicator_code", now(), now()
FROM "pair_template_rows" t
WHERE t."eur_indicator_code" IS NOT NULL
ON CONFLICT ("template_row_id", "currency_code") DO NOTHING;

INSERT INTO "pair_template_row_currencies"
  ("id", "template_row_id", "currency_code", "indicator_code", "created_at", "updated_at")
SELECT gen_random_uuid(), t."id", 'GBP', t."gbp_indicator_code", now(), now()
FROM "pair_template_rows" t
WHERE t."gbp_indicator_code" IS NOT NULL
ON CONFLICT ("template_row_id", "currency_code") DO NOTHING;

INSERT INTO "pair_template_row_currencies"
  ("id", "template_row_id", "currency_code", "indicator_code", "created_at", "updated_at")
SELECT gen_random_uuid(), t."id", 'JPY', t."jpy_indicator_code", now(), now()
FROM "pair_template_rows" t
WHERE t."jpy_indicator_code" IS NOT NULL
ON CONFLICT ("template_row_id", "currency_code") DO NOTHING;

-- Reconciliation guard: abort the migration if the backfilled row count does not
-- equal a fresh manual count of non-null cells in the four legacy columns.
DO $$
DECLARE
  v_backfilled INTEGER;
  v_cells      INTEGER;
BEGIN
  SELECT count(*) INTO v_backfilled FROM "pair_template_row_currencies";

  SELECT
      count("us_indicator_code")
    + count("eur_indicator_code")
    + count("gbp_indicator_code")
    + count("jpy_indicator_code")
  INTO v_cells
  FROM "pair_template_rows";

  IF v_backfilled <> v_cells THEN
    RAISE EXCEPTION
      'pair_template_row_currencies backfill mismatch: % rows backfilled vs % non-null legacy cells',
      v_backfilled, v_cells;
  END IF;

  RAISE NOTICE '1a backfill reconciled: % rows = % non-null legacy cells', v_backfilled, v_cells;
END $$;

-- =========================================================
-- 1b BACKFILL — asset_indicator_map
-- Reproduces CURRENT behaviour exactly, as resolved today by
-- COUNTRY_BY_ASSET + flipScoreForGold in asset-indicator-resolver.ts:
--
--   USD    -> country IN ('US','USD'),  polarity +1
--   EUR    -> country IN ('EU','EUR'),  polarity +1
--   GBP    -> country IN ('UK','GBP'),  polarity +1
--   JPY    -> country IN ('JP','JPY'),  polarity +1
--   XAUUSD -> country IN ('US','XAU'),  polarity -1 on every NON-COT indicator
--                                       (flipScoreForGold excludes COT), +1 COT
--
-- isCot mirrors the resolver: ui_group = 'COT' OR country = the asset's COT code.
-- Only tool='edgefinder' AND is_active=true indicators are mapped, matching the
-- resolver's own query filter.
-- Idempotent: ON CONFLICT DO NOTHING against the (asset, indicator) unique key.
-- =========================================================

INSERT INTO "asset_indicator_map"
  ("id", "asset_id", "indicator_id", "polarity", "is_cot", "created_at", "updated_at")
SELECT
  gen_random_uuid(),
  a."id",
  i."id",
  CASE
    WHEN m."asset_code" = 'XAUUSD'
     AND NOT (i."ui_group" = 'COT' OR i."country" = m."cot_code") THEN -1
    ELSE 1
  END,
  (i."ui_group" = 'COT' OR i."country" = m."cot_code"),
  now(),
  now()
FROM (
  VALUES
    ('USD',    ARRAY['US'], 'USD'),
    ('EUR',    ARRAY['EU'], 'EUR'),
    ('GBP',    ARRAY['UK'], 'GBP'),
    ('JPY',    ARRAY['JP'], 'JPY'),
    ('XAUUSD', ARRAY['US'], 'XAU')
) AS m("asset_code", "fundamental_codes", "cot_code")
JOIN "assets" a
  ON a."code" = m."asset_code"
JOIN "indicators" i
  ON i."tool" = 'edgefinder'
 AND i."is_active" = true
 AND i."country" = ANY(m."fundamental_codes" || ARRAY[m."cot_code"])
ON CONFLICT ("asset_id", "indicator_id") DO NOTHING;

-- Reconciliation guard: per-asset counts must equal what COUNTRY_BY_ASSET
-- resolves today. Abort the migration on any drift.
DO $$
DECLARE
  r            RECORD;
  v_mapped     INTEGER;
  v_resolved   INTEGER;
BEGIN
  FOR r IN
    SELECT * FROM (
      VALUES
        ('USD',    ARRAY['US','USD']),
        ('EUR',    ARRAY['EU','EUR']),
        ('GBP',    ARRAY['UK','GBP']),
        ('JPY',    ARRAY['JP','JPY']),
        ('XAUUSD', ARRAY['US','XAU'])
    ) AS t("asset_code", "codes")
  LOOP
    SELECT count(*) INTO v_mapped
    FROM "asset_indicator_map" m
    JOIN "assets" a ON a."id" = m."asset_id"
    WHERE a."code" = r."asset_code";

    SELECT count(*) INTO v_resolved
    FROM "indicators" i
    WHERE i."tool" = 'edgefinder'
      AND i."is_active" = true
      AND i."country" = ANY(r."codes");

    IF v_mapped <> v_resolved THEN
      RAISE EXCEPTION
        'asset_indicator_map backfill mismatch for %: % mapped vs % resolved by COUNTRY_BY_ASSET',
        r."asset_code", v_mapped, v_resolved;
    END IF;

    RAISE NOTICE '1b backfill reconciled for %: % rows', r."asset_code", v_mapped;
  END LOOP;
END $$;

-- Gold must be a strict inverse of USD on every non-COT indicator, and must NOT
-- flip its own COT row. Abort if that invariant does not hold.
DO $$
DECLARE
  v_bad INTEGER;
BEGIN
  SELECT count(*) INTO v_bad
  FROM "asset_indicator_map" m
  JOIN "assets" a ON a."id" = m."asset_id"
  WHERE a."code" = 'XAUUSD'
    AND ((m."is_cot" = false AND m."polarity" <> -1)
      OR (m."is_cot" = true  AND m."polarity" <> 1));

  IF v_bad > 0 THEN
    RAISE EXCEPTION 'XAUUSD polarity backfill is wrong on % row(s)', v_bad;
  END IF;

  RAISE NOTICE 'XAUUSD polarity invariant holds (non-COT = -1, COT = +1)';
END $$;
