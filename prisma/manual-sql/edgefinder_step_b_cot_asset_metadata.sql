-- Step B: Add CFTC contract codes to EdgeFinder asset metadata.
-- Idempotent: jsonb concatenation preserves any keys already present and
-- overwrites cotContractCode/cotTraderCategory on each re-run.
--
-- Scope: 5 assets that get COT scoring in Step B. SPY and NAS100 are deferred
-- (isActive=false in the seed) so they are intentionally skipped here.

BEGIN;

UPDATE assets SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
  'cotContractCode', '098662',
  'cotTraderCategory', 'Large Speculators'
) WHERE code = 'USD' AND 'edgefinder' = ANY(tool_scope);

UPDATE assets SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
  'cotContractCode', '099741',
  'cotTraderCategory', 'Large Speculators'
) WHERE code = 'EUR' AND 'edgefinder' = ANY(tool_scope);

UPDATE assets SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
  'cotContractCode', '096742',
  'cotTraderCategory', 'Large Speculators'
) WHERE code = 'GBP' AND 'edgefinder' = ANY(tool_scope);

UPDATE assets SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
  'cotContractCode', '097741',
  'cotTraderCategory', 'Large Speculators'
) WHERE code = 'JPY' AND 'edgefinder' = ANY(tool_scope);

UPDATE assets SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
  'cotContractCode', '088691',
  'cotTraderCategory', 'Large Speculators'
) WHERE code = 'XAUUSD' AND 'edgefinder' = ANY(tool_scope);

COMMIT;

-- Verify after running:
--   SELECT code, metadata->'cotContractCode' AS cot_code
--   FROM assets
--   WHERE 'edgefinder' = ANY(tool_scope)
--   ORDER BY code;
-- Should show cot_code populated for USD, EUR, GBP, JPY, XAUUSD.
