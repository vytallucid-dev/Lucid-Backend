-- Phase 3B-1 cleanup: hard-delete data points for the 10 US economic indicators
-- being migrated from FRED to JBlanked. US02Y data is preserved.

BEGIN;

-- Step 1: delete data points for the 10 indicators
DELETE FROM data_points
WHERE indicator_id IN (
  SELECT id FROM indicators
  WHERE code IN (
    'US_GDP_QOQ',
    'US_CPI_YOY',
    'US_PPI_YOY',
    'US_PCE_YOY',
    'US_NFP',
    'US_UNEMP',
    'US_JOBLESS_CLAIMS',
    'US_JOLTS',
    'US_RETAIL_MOM',
    'US_ISM_MFG'
  )
);

-- Step 2: delete fetch_log rows tied to these indicators (audit cleanup)
DELETE FROM data_fetch_log
WHERE job_name IN (
  'fetch_fred_us_gdp_qoq',
  'fetch_fred_us_cpi_yoy',
  'fetch_fred_us_ppi_yoy',
  'fetch_fred_us_pce_yoy',
  'fetch_fred_us_nfp',
  'fetch_fred_us_unemp',
  'fetch_fred_us_jobless_claims',
  'fetch_fred_us_jolts',
  'fetch_fred_us_retail_mom',
  'fetch_fred_us_ism_mfg'
);

COMMIT;

-- Verification queries (run separately to confirm):
-- SELECT i.code, COUNT(*) FROM data_points dp JOIN indicators i ON i.id = dp.indicator_id
-- WHERE i.tool = 'edgefinder' GROUP BY i.code ORDER BY i.code;
-- Expected: only US_02Y_SMA shows rows (497). All 10 deleted indicators show 0.
