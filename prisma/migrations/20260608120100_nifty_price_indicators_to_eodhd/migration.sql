-- Migrate the three NIFTY price indicators from FRED to EODHD.
--
-- Flipping data_source to 'eodhd' is what REMOVES these three from the FRED daily
-- fetch: fetchAllFredIndicators() selects `WHERE data_source = 'fred'`, so once the
-- rows are 'eodhd' they are no longer fetched by the FRED job. The EODHD job picks
-- them up via `WHERE data_source = 'eodhd'`. source_series_id is updated from the
-- FRED series id to the EODHD symbol for traceability.
--
--   IND_NIFTY_10_DXY    DTWEXBGS      -> DXY.INDX      (EOD endpoint,        ICE DXY ~98)
--   IND_NIFTY_11_BRENT  DCOILBRENTEU  -> BRENT         (commodities endpoint)
--   IND_NIFTY_12_USDINR DEXINUS       -> USDINR.FOREX  (EOD endpoint)
--
-- This runs in its own transaction (separate migration from the enum addition) so
-- the 'eodhd' value is already committed and safe to use here.
--
-- NOTE: existing DXY data points remain on the old FRED broad-index scale (~118).
-- They are cleared and re-backfilled on the EODHD ICE scale (~98) by the one-time
-- cutover script (scripts/cutover-dxy-to-eodhd.ts), run manually after deploy.
UPDATE "indicators" SET "data_source" = 'eodhd', "source_series_id" = 'DXY.INDX'     WHERE "code" = 'IND_NIFTY_10_DXY';
UPDATE "indicators" SET "data_source" = 'eodhd', "source_series_id" = 'BRENT'        WHERE "code" = 'IND_NIFTY_11_BRENT';
UPDATE "indicators" SET "data_source" = 'eodhd', "source_series_id" = 'USDINR.FOREX' WHERE "code" = 'IND_NIFTY_12_USDINR';
