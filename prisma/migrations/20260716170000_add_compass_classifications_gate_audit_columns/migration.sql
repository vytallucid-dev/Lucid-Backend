-- Compass v2 Phase 6 (Task 4): audit columns recording what the two override
-- gates decided on each classification date.
--
--   us02y_close / us02y_sma21          = rate-gate inputs (raw DGS2 close and
--                                        its 21-obs SMA). NULL on pre-Phase-6
--                                        rows / when the gate failed open.
--   rate_gate_hawkish                  = us02y_close > us02y_sma21 (strict,
--                                        6-decimal rounded).
--   override_3/5_suppressed_by_gate    = JPY safe-haven / carry overrides
--                                        suppressed by a hawkish rate gate
--                                        (no Trigger B bypass).
--   fed_constraint                     = resolved Fed constraint as of the
--                                        date ('FREE' | 'CONSTRAINED'); '' on
--                                        pre-Phase-6 rows.
--   override_2_suppressed_by_constraint= gold override suppressed because
--                                        fed_constraint was FREE under a
--                                        Risk-Off regime path.
--   overrides_active                   = post-gate final override code set
--                                        that actually fired (JSON array).
--
-- Purely additive — no existing column altered.
ALTER TABLE "compass_classifications" ADD COLUMN     "fed_constraint" VARCHAR(12) NOT NULL DEFAULT '',
ADD COLUMN     "override_2_suppressed_by_constraint" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "override_3_suppressed_by_gate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "override_5_suppressed_by_gate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "overrides_active" JSONB,
ADD COLUMN     "rate_gate_hawkish" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "us02y_close" DECIMAL(20,6),
ADD COLUMN     "us02y_sma21" DECIMAL(20,6);
