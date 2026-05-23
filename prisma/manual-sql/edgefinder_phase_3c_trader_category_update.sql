-- Phase 3C: Update trader category from 'Large Speculators' to 'Non-Commercials'
-- to match CFTC's actual API field naming.
BEGIN;
UPDATE assets SET metadata = jsonb_set(
  metadata, '{cotTraderCategory}', '"Non-Commercials"'::jsonb
) WHERE metadata->>'cotTraderCategory' = 'Large Speculators'
  AND 'edgefinder' = ANY(tool_scope);
COMMIT;
