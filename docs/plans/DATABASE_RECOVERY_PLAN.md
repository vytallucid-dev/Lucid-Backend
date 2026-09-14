# Lucid — Database Recovery Plan

**Incident:** 2026-09-11 ~20:00 UTC. `prisma migrate diff --shadow-database-url <DIRECT_URL>` reset the
production Supabase `public` schema. Every table dropped. Supabase free plan — no backup, no PITR.

**Surviving:** `auth` schema (users), `storage` schema (69 trade screenshots), both code repositories,
and a full journal DTO dump taken ~2 minutes before the incident.

**End goal:** a database that serves the Trading Hub with its complete journal, and NIFTY + Oracle
scoring history over a defined recent window, verified against evidence rather than assumed correct.

---

## 0. Scope, window and success criteria

### 0.1 The scoring window (W)

```
W_start = 2026-05-26
W_end   = 2026-09-13   (today; extend to the run date)
```

**Why 2026-05-26 and not "three months ago".** The journal carries 22 Oracle score snapshots that the
live system captured at the time — 10 entry snapshots and 12 exit snapshots — spanning 2026-05-26 to
2026-09-03. Those snapshots are the only surviving independent record of the old system's output.
Starting W at 2026-05-26 puts **all 22** inside the rebuilt range, which converts Stage 7 from "looks
plausible" into a real pass/fail test. A window starting mid-June would cover only 15 of them and
throw away the evidence for free.

W is ~110 calendar days: about 76 US trading days, about 74 NSE trading days.

### 0.2 The data-depth window (D)

```
D_start = 2025-06-01   (~15 months before W_end)
```

D applies **only to auto-fetched daily series**. It is deliberately much deeper than W because three
NIFTY indicators score off a rolling volatility estimate:

| Rule | Requirement |
|---|---|
| `rolling_slope_sigma` (IND10 DXY, IND11 Brent, IND12 USDINR) | `window_size: 10`, `sigma_lookback_min: 60`, `sigma_lookback_max: 250` → needs ≥70 observations to score at all, ~260 to produce the *same* sigma as before |
| `percentile_rank` expanding (IND13 FII L/S) | ranks against all history; original series began 2022-06-15 |
| `us02y-sma` (Oracle US_02Y_SMA) | 6 stored SMA points, which are themselves computed over 21 days |

Backfilling only W would leave IND10/11/12 either unscored or scored against a different sigma.

### 0.3 Success criteria

The recovery is complete when all of the following hold:

1. Four account balances match `baseline-before.json` **to the cent**.
2. 32 trades and 36 executions restored; exactly one primary execution per trade; the server-side
   integrity check flags 0 trades (it flagged 0 before the incident, after the hand corrections).
3. All 69 screenshot links resolve to live objects in Supabase Storage.
4. A NIFTY scorecard exists for every NSE trading day in W, with no gaps and no non-trading-day rows.
5. An Oracle asset scorecard and pair score exist for every trading day in W.
6. **`oracleScoreOn(pair, date)` reproduces all 22 stored journal snapshots exactly.**
7. A config assertion script reports zero drift from the expected indicator/rule/asset manifest.
8. `prisma migrate status` shows all 48 migrations applied, nothing pending.
9. Both repos type-check clean; the backend test suite is at its known baseline.

Criterion 6 is the load-bearing one. If it fails, the replay is wrong and the cause must be found
before proceeding — do not adjust the expectation to match the output.

### 0.4 Rules for the whole operation

- **Never pass a live database URL to any Prisma flag that takes a shadow database.** Not
  `migrate diff --shadow-database-url`, not `migrate dev`, not `migrate reset`. This is what caused
  the incident. Validate drift with `migrate diff --from-schema-datasource --to-schema-datamodel`,
  which takes no shadow database.
- Every destructive statement is shown to the user and approved before it runs. No exceptions.
- Every stage ends with its own verification. A stage that fails verification blocks the next one.
- Scripts are idempotent and re-runnable. Assume any stage may need to run twice.
- The restore writes stored values **verbatim** via Prisma. It does not go through the trades API,
  which recomputes derived metrics and would overwrite the hand-corrected rows.
- No trade data is invented. Where a field is genuinely absent from the dump, it is left null and
  reported, never guessed.

---

## Stage 0 — Freeze and preserve

**Goal:** stop anything that could write, and get the only copy of the journal somewhere durable.

### 0.1 Preserve the dumps (do this first, before anything else)

The dumps currently live in the session scratchpad under the OS temp directory. That is a temporary
location and can be cleaned at any time. It is the only copy of the journal in existence.

- Copy `baseline/dtos-after-p4.json` and `baseline/baseline-before.json` to a permanent location the
  user controls, in **two** separate places (e.g. a local folder plus cloud storage).
- Record a SHA-256 of each file in this plan's execution log.
- Nothing else in Stage 0 begins until this is confirmed.

### 0.2 Freeze writers

- Backend must stay stopped. `npm start` runs `prisma migrate deploy` — with `_prisma_migrations`
  missing, starting it would attempt a full replay against the live database.
- If the backend is deployed anywhere (Render, Railway, Fly, a VPS), disable auto-restart and any
  scheduled job before touching the database. Check the cron registry
  ([cron-registry.ts](../../src/modules/nifty/jobs/cron-registry.ts)) for what would otherwise fire.
- Confirm the Phase 5 journal-capture migration is still held outside the repo. It is unapplied and
  unreviewed; if it re-enters `prisma/migrations` it will be deployed automatically.

### 0.3 Read-only assessment

Run read-only queries and record the answers:

- Which tables currently exist in `public`, and their row counts (expect: partial set, all empty).
- Does `_prisma_migrations` exist? (Expected: no.)
- `auth.users` — how many rows, which ids and emails. **Assessed 2026-09-13: 4 users.** The journal
  owner is resolved **by id, never by name**: `baseline-before.json` records the 32-trade user as
  `userIdSuffix: 1e300a`, matching `auth.users.id = 16e3f8c7-4ae2-4bd7-9b25-fc78a61e300a`. Which
  account(s) hold the admin role is not recorded anywhere that survived — confirm with the user.
- `storage.objects` — count objects in the `trade-screenshots` bucket; expect 69 referenced.
- Do the storage policies from `prisma/manual-sql/trade_screenshots_bucket.sql` still exist?
  (They live in the `storage` schema, which was not dropped, so expected: yes.)

### 0.4 Decide the rebuild mode

Recommended: **full clean rebuild**. The current `public` schema is a partial artefact of an aborted
migration replay — it stopped at `20260817130000_nifty_ind13_percentile_rank_v3`. Rebuilding onto a
known-empty schema is deterministic; patching a half-applied one is not.

Requires approval, because it is a destructive statement on a live database:

```sql
-- recovery/sql/00-drop-public.sql
BEGIN;
SET LOCAL lock_timeout = '10s';       -- fail fast rather than queue behind a live lock
SET LOCAL statement_timeout = '120s';
DROP SCHEMA public CASCADE;
CREATE SCHEMA public AUTHORIZATION postgres;
COMMIT;
-- No GRANTs. Revised 2026-09-13 after the grants capture (0.4b): public is owner-only
-- post-reset, and nothing in the app needs anon/authenticated/service_role access.
```

This touches only `public`. `auth` and `storage` are untouched, so users and screenshots survive.

**Exit check:** dumps duplicated and hashed; nothing can write to the database; the assessment is
recorded; the rebuild mode is approved.

---

## Stage 1 — Schema

**Goal:** a `public` schema structurally identical to what `schema.prisma` plus the hand-applied SQL
describes, with migration history recorded so future deploys are no-ops.

### 1.1 Why `migrate deploy` cannot be used

`prisma migrate deploy` **fails on an empty database**. This is not a theory — it is exactly where the
accidental replay stopped. Migration `20260817130000_nifty_ind13_percentile_rank_v3` contains:

```sql
INSERT INTO "scoring_rules" (..., "indicator_id", ...)
VALUES (..., (SELECT "id" FROM "indicators" WHERE "code" = 'IND_NIFTY_13_FII_LS_RATIO'), ...)
```

On an empty `indicators` table that subquery yields NULL, and `indicator_id` is NOT NULL. The
migration aborts. Several other migrations have the same shape.

### 1.2 Steps

1. `npx prisma db push --skip-generate` — creates every table, enum, index and FK that
   `schema.prisma` can express.
2. Apply [recovery/sql/01-post-push.sql](../../recovery/sql/01-post-push.sql) via
   `prisma db execute`, **after** `db push` and never before it. It is the complete list of objects
   `db push` cannot build — from a sweep of all 48 migrations and both hand-applied SQL directories
   (2026-09-13) — in one transaction:
   - `public.handle_new_user()` (final body from `20260612120000`) and
     `public.handle_user_email_change()`, with triggers `on_auth_user_created` and
     `on_auth_user_email_changed` on `auth.users`
   - partial unique indexes `executions_one_primary_per_trade`,
     `calendar_event_deferrals_standing_unique`, `data_points_current_unique`
   - CHECK constraints `asset_indicator_map_polarity_sign_check`,
     `trades_oracle_score_entry_source_check`
   - four partial performance indexes from `manual-migrations/001` (never in migration history)

   Deliberately **excluded**: `001`'s `handle_auth_user_sync()` + `on_auth_user_changed`. It falls back
   to the email as display name — the exact bug `20260612120000` fixed — and because same-event
   triggers fire in name order it would insert before `on_auth_user_created` and silently reintroduce
   that bug. Also excluded: `001`'s `idx_assets_tool_scope_gin`, a duplicate of the
   `assets_tool_scope_idx` that `schema.prisma` declares. The hot-path indexes from
   `20260610120000_perf_hot_path_indexes` are declared in `schema.prisma` too.
3. Apply the grant posture decided in Stage 0.4b
   ([recovery/sql/02-grants.sql](../../recovery/sql/02-grants.sql)). Nothing in the app reaches
   `public` through Supabase's REST API — the backend imports no `@supabase/supabase-js` and uses
   Prisma as `postgres`; the frontend uses Supabase only for auth and storage — so `anon` and
   `authenticated` get **no** table privileges. No table has row-level security, so any such grant
   would expose it to anyone holding the public anon key.
4. Storage: verify the `trade-screenshots` bucket and its four policies still exist. Re-apply
   [trade_screenshots_bucket.sql](../../prisma/manual-sql/trade_screenshots_bucket.sql) only if they
   are missing. It is idempotent (`drop policy if exists` then create).
5. Record migration history: `npx prisma migrate resolve --applied <name>` for all **48** migrations,
   in filename order, so `migrate deploy` on the next backend start is a clean no-op.

### 1.3 Verification

- `npx prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --script`
  reports no differences other than the hand-applied objects in `01-post-push.sql`, which
  `schema.prisma` cannot express. No `--shadow-database-url`. Ever. The CLI reports it skips its own
  `.env` loading because `prisma.config.ts` exists — pass URLs explicitly rather than relying on how
  the environment happens to resolve.
- Structural diff of the rebuilt `public` against `recovery/snapshots/replay37-catalog.json` (the
  schema the aborted replay built from migrations #1–#37, captured before the drop). Every
  difference must be explained by a DDL statement in migrations #38–#48.
- Query `pg_indexes` and confirm each partial index exists by name, with its `WHERE` clause.
- Query `pg_trigger` on `auth.users` and confirm `on_auth_user_created` and the email/change triggers.
- `npx prisma migrate status` → 48 applied, 0 pending.

**Exit check:** zero schema drift; every partial index and trigger present by name; migration history
complete.

---

## Stage 2 — Reference data and scoring configuration

**Goal:** the indicator registry, scoring rules, assets, pair templates and Compass config restored to
their true final state — not to the state the seed files alone would produce.

### 2.1 The central risk of this whole recovery

Configuration reached production through **three** channels, and only one of them replays cleanly:

| Channel | Replays on a fresh DB? |
|---|---|
| Seed scripts (`prisma/seed*.ts`) | Yes |
| Data statements inside migrations | **No** — `UPDATE`s hit zero rows; `INSERT … SELECT`s insert nothing |
| Hand-applied SQL in `prisma/manual-migrations/` and `prisma/manual-sql/` | **No** — never part of migration history at all |

If channels 2 and 3 are skipped, the system comes back up looking entirely healthy while scoring on
**version 2 rules**. IND10/11/12 would run `rolling_pct_direction` instead of `rolling_slope_sigma`;
IND13 would run static `threshold_bands` instead of expanding `percentile_rank`. Nothing would error.
The scores would simply be wrong, and every number downstream of them would be quietly wrong too.

This is the single most likely way this recovery fails, so Stage 2 ends with an assertion script
rather than a checklist tick.

### 2.2 Seed order

```
npx tsx prisma/seed.ts                     # 10 assets, 14 NIFTY indicators, v1 rules, rating rule
npx tsx prisma/seed-rules-v2.ts            # promotes IND01–13 to v2, closes v1
npx tsx prisma/seed-edgefinder.ts          # 18 assets, 65 indicators, rules, pair templates,
                                           #   asset↔indicator map, rating rule, currency stances
npx tsx prisma/seed-indicator-variants.ts  # release ladders (Flash/Final, Advance/Second/Third)
npx tsx prisma/seed-compass-config.ts      # Compass inputs and config
```

`scripts/seed-edgefinder-data.ts` (41 historical macro values) is **optional** — Stage 5 supplies the
authoritative values for W. Load it only if its rows fall outside W and fill genuine gaps.

### 2.3 Replay the skipped configuration, in order

**From migrations** (data statements only — the DDL already ran in Stage 1):

| Migration | Effect |
|---|---|
| `20260702120000_add_nifty_ind14_dii_flow_indicator` | INSERT indicator (self-contained; seed may already cover it) |
| `20260608120100_nifty_price_indicators_to_eodhd` | 3 × UPDATE indicator source |
| `20260610130100_nifty_brent_to_crude_price_api` | UPDATE indicator source |
| `20260713120000_nifty_brent_to_yahoo` | UPDATE indicator source (supersedes the previous) |
| `20260629120000_recalibrate_nifty_ind13_fii_ls_bands` | UPDATE rule bands |
| `20260702120100_fix_nifty_ind7_dii_absorption_net_formula` | UPDATE rule formula |
| `20260817130000_nifty_ind13_percentile_rank_v3` | UPDATE v2 `effective_to` + INSERT v3 rule |
| `20260817150000_nifty_ind10_11_12_slope_sigma_v3` | UPDATE + INSERT v3 rules ×3 |
| `20260817160000_nse_holiday_calendar` | INSERT NSE holidays (self-contained; **required** — the NIFTY assembly route gates on `isTradingDay`) |
| `20260731120000_edgefinder_phase1_normalise_…` | 4 × INSERT pair_template_row_currencies + INSERT asset_indicator_map (`INSERT … SELECT`) |

Pure data backfills of rows that no longer exist (`20260817120000`, `20260817140000`, `20260817170000`,
`20260817190000`, `20260804120000`, `20260807120000`, `20260815120000`) are **no-ops by design** —
they backfilled rows that Stage 3 onward recreates correctly. Skip them; record that they were skipped.

**From hand-applied SQL:**

| File | Effect | Note |
|---|---|---|
| `manual-migrations/002_iip_to_manual.sql` | IND_NIFTY_05_IIP → manual source | README says "Pending"; it was applied in production — confirms IIP is hand-filled |
| `manual-sql/edgefinder_step_b_cot_asset_metadata.sql` | COT contract codes + trader category on 5 assets | **Critical** — CFTC fetch cannot resolve contracts without it. Seed appears to carry these already; assert, then apply only if missing |
| `manual-sql/edgefinder_phase_3b1_ppi_rename.sql` | `*_PPI_YOY` → `*_PPI_MOM` ×3 + pair template row | Seed already uses `_MOM`; expected no-op |
| `manual-sql/edgefinder_phase_3b15_indicator_source_update.sql` | UPDATE indicator source | Apply |
| `manual-sql/edgefinder_phase_3c_trader_category_update.sql` | UPDATE asset trader category | Apply |
| `manual-sql/edgefinder_phase_3b1_cleanup.sql` | DELETEs bad `data_points` / `data_fetch_log` rows | **Skip** — those rows are not being recreated |

### 2.4 Verification — the config assertion script

Write `scripts/assert-config.ts`. It checks the database against an explicit expected manifest and
exits non-zero on any mismatch. It must assert at minimum:

- 14 NIFTY indicators, 65 EdgeFinder indicators, 18 EdgeFinder assets + 10 base assets.
- For every indicator: `dataSource` equals the expected final value (IIP = manual, Brent = yahoo,
  the EODHD switches applied).
- **Active rule version per indicator**, evaluated at `W_end`: IND10, IND11, IND12, IND13 → **v3**;
  IND01–09, IND14 → v2. Any indicator sitting on v1 or v2 where v3 is expected is a hard failure.
- Rule bodies for the v3 rules match the expected JSON (type, `window_size`, `sigma_lookback_min/max`,
  bands, `min_observations`).
- Assets USD/EUR/GBP/JPY/XAUUSD carry `cotContractCode` and `cotTraderCategory`.
- `pair_template_rows`, `pair_template_row_currencies`, `asset_indicator_map` row counts non-zero and
  every pair definition resolvable via `loadPairDefinitions()`.
- `nse_holidays` covers W (and note the known 2027 gap).
- Compass inputs and config resolvable for `W_start` via `compassConfigRepository.resolveForDate()`.

**Exit check:** `assert-config.ts` exits 0.

---

## Stage 3 — Users, accounts and the trading journal

**Goal:** the journal restored exactly, balances matching the baseline to the cent.

### 3.1 Users

`auth.users` still holds the accounts, but `public.users` is empty and the sync trigger is
`AFTER INSERT ON auth.users` — it will not fire for users that already exist. Backfill explicitly:

```sql
INSERT INTO public.users (id, email, display_name, role, created_at, updated_at)
SELECT id, email, raw_user_meta_data->>'display_name', 'user', created_at, now()
FROM auth.users
ON CONFLICT (id) DO NOTHING;
```

Then restore the admin role for the account(s) the user confirms — required for the admin
cron-trigger routes used in Stages 6–8. Every restored journal row keys off the id-matched owner
`16e3f8c7-4ae2-4bd7-9b25-fc78a61e300a` (see Stage 0.3). Do not infer ownership or role from names.

### 3.2 Models and pairs

`seedDefaultModelsIfNeeded(userId)` and `seedDefaultPairsIfNeeded(userId)` in
[bootstrap.service.ts](../../src/modules/trading/services/bootstrap.service.ts) already carry the
correct `pipValue`, `flagA/flagB` and `displayName` for all 13 default pairs. Run them, then upsert
any model or pair appearing in the dump that the defaults miss.

- Models in the dump: `4HPullBack`, `Breakout`, `Short`, `No Model`.
- Pairs in the dump: EURUSD, GBPUSD, XAUUSD, USDJPY, NAS100, AUDUSD, SPY, EURJPY.

**Known gap:** model `description`/`rules` text and any pair whose `pipValue` was customised away from
the bootstrap default are not in the dump. Restore the defaults, list them in the report, and let the
user correct anything that differs.

### 3.3 Accounts, cash flows, payouts

Restore all 4 accounts with `accountSize`, `currentBalance`, `startingDate`, `status`, `stage`,
`propFirm`, `maxDrawdownPct`, `profitTargetPct`, `profitGoalPct`, `currency`.

`cash_flows` and `payouts` arrive as separate arrays in the DTO but are one table — `payouts` are
`CashFlow` rows with `type = 'payout'`. Restore both into `cash_flows` with the right `type`.

`tradingPnl` and `netDeposits` in the DTO are **computed**, not columns. Do not attempt to write them.

**Known gap:** `TradingAccount.broker` is not in the DTO. Left null; reported.

### 3.4 Trades and executions

Restore 32 trades and 36 executions, writing stored values verbatim:

- Trade: model, pair, direction, planned entry/SL/first TP/main TP, conviction, `dateOpened`, session,
  screenshots array, psychology, notes, and all four Oracle entry snapshot columns.
- Execution: account, `isPrimary`, `riskPct`, `lotSize`, `entryPrice`, partial exit price/lot %,
  `mainExitPrice`, `exitType`, `dateClosed`, `totalPips`, `blendedPnl`, `blendedRr`, and the three
  Oracle exit snapshot columns.

**Do not recompute** `totalPips`, `blendedPnl` or `blendedRr`. Four rows were hand-corrected outside
the redesign session; the dump holds the corrected values and recomputation would undo that work.

`pre_trade_memory` and `debrief_memory` appear in the DTO but are hardcoded `null` in
[serialize.ts](../../src/modules/trading/services/serialize.ts) — derived, nothing to restore.
`integrity` and `expected_rr` are likewise computed at read time.

### 3.5 Verification

- Counts: 4 accounts, 32 trades, 36 executions, cash flows and payouts matching the dump.
- **Balances byte-equal** to `baseline-before.json`: `10040.00`, `10325.40`, `10818.91`, `10511.58`.
- Exactly one primary execution per trade — the partial unique index should make violation impossible;
  assert anyway.
- Server-side integrity check flags **0** trades, and the Phase 1 outcome-coherence rule flags 0.
- All 69 screenshot paths resolve to live objects (HEAD each URL).
- Recompute the known hand example: EURUSD 2026-08-17, entry 1.15865, stop 1.1545, exit 1.16635 →
  0.00770 / 0.00415 = **+1.86R**.

**Exit check:** every balance to the cent; 0 integrity flags; 69/69 screenshots live.

At this point the Trading Hub is fully usable. Stages 4–8 restore the scoring history behind it.

---

## Stage 4 — Deep auto-series backfill

**Goal:** every auto-fetched series populated from `D_start`, so the scoring engine has the history
its rolling rules need before any replay begins.

### 4.1 Series and sources

| Series | Source | Depth | Notes |
|---|---|---|---|
| DXY, USDINR, NIFTY close | EODHD | `D_start` | Feeds IND10/IND12 slope-sigma; needs ~260 points |
| Brent | Yahoo | `D_start` | IND11; source switched from crude API → Yahoo |
| US 2Y yield | FRED | `D_start` | `US_02Y_SMA` needs 21-day SMA + 6 points |
| India CPI, IIP | FRED / manual | see Stage 5 | IIP was switched to manual |
| FII/DII cash flows | NSE archives | W + 30d buffer | IND06 uses a 10-day rolling window |
| NSE VIX | NSE | W + buffer | IND08 |
| Participant OI (FII long/short) | NSE archives | **as deep as NSE serves** | IND13 expanding percentile — see 4.3 |
| COT | CFTC | `D_start` | 9 COT indicators; weekly |

The fetch services support this: `fred-indicator.service.ts` and `eodhd-indicator.service.ts` both
implement "smart catch-up" with a `triggerType: 'backfill'` mode, and
`nse-participant-oi.service.ts` handles today / single-date / backfill uniformly.

### 4.2 Required code change — CFTC row limit

[cftc.client.ts](../../src/core/clients/cftc/cftc.client.ts) hardcodes `$limit: 100`. With `daysBack`
covering D across 9 contracts that truncates silently. Raise the limit (or page) for the backfill.
This is the one production code change Stage 4 requires; it is small, and it should be covered by a
test before use.

### 4.3 IND13 — the one indicator that cannot be made identical

IND13 uses an **expanding-window** percentile rank with `min_observations: 60`. It ranks each day
against the entire history to that date, which originally reached back to 2022-06-15. NSE archives are
unlikely to serve three years of participant-OI files reliably.

Consequence: IND13's scores over W will be computed against a shorter sample and **will differ from the
originals**. This is unavoidable and must be stated in the final report rather than papered over.

Containment: IND13 is already excluded from `domestic`, `external` and `net_score` (excluded
2026-08-17, pending validation). It is persisted standalone in `nifty_scorecards.ind_13_score` and
shown in the UI. So the divergence is confined to one displayed row and does not propagate into the
net score, the band, velocity, or anything downstream.

Backfill participant OI as deep as NSE will serve, record the achieved start date, and report the
resulting sample size next to the figure.

### 4.4 Verification

Per series: earliest and latest `observation_date`, row count, and the largest gap between consecutive
observations. Assert:

- Daily price series have ≥ 260 observations before `W_start` (the slope-sigma requirement).
- No gap longer than 5 trading days inside W.
- COT: ~1 row per contract per week across D, 9 contracts present.
- Record IND13's achieved history depth explicitly.

**Exit check:** every series meets its depth requirement, or the shortfall is recorded with its
downstream consequence named.

---

## Stage 5 — Manual macro entry

**Goal:** load the macro prints that cannot be re-fetched.

### 5.1 Why these are manual

55 of the 65 Oracle indicators are sourced `forex_factory`. That feed is current-week-only —
`ff_calendar_nextweek.json` and `_lastweek.json` both 404, which is why `CalendarEvent` retention is
permanent and nothing in it is ever pruned. Past weeks **cannot be re-fetched by any means**. They
must be typed in. NIFTY adds PMI Manufacturing, PMI Services, RBI repo rate, CPI and IIP.

### 5.2 How much data

| Tool | Indicators | Frequency mix | Values needed for W + lead-in |
|---|---|---|---|
| Oracle | 55 (US 15, JP 12, AU 10, EU 9, UK 9) | 44 monthly, 5 quarterly, 5 event-driven, 1 weekly (jobless claims) | ~150–170 |
| NIFTY | 5 | monthly + event-driven | ~15–20 |

**Supply four months, not three.** Every rule compares the current print against the previous one
(`value >= previous_value`, `falling`, `rising`, `cycle_regime`). A print from before `W_start` is
required or the first weeks of W score as `insufficient_data`. Quarterly indicators need the prior
quarter as well.

Per value: indicator code, observation date, actual. Forecast and previous are optional but improve
fidelity — several handlers read `forecastValue`/`previousValue` directly.

### 5.3 Mechanism

1. Generate `scripts/data/manual-backfill-template.csv` pre-filled with every
   `(indicator_code, observation_date)` pair that needs a value, derived from each indicator's
   frequency and release calendar. The user fills the `actual` column — blanks to fill, not a file to
   compose.
2. Write `scripts/load-manual-backfill.ts`: validates against the indicator registry, rejects unknown
   codes and out-of-range dates, resolves release variants against `indicator_variants` (Flash/Final,
   Advance/Second/Third), and upserts `data_points` with `source = 'manual'`. Idempotent.
3. Dry-run mode first, printing exactly what would be written. Apply only after the user reviews it.

Both manual-entry paths already accept arbitrary past dates —
[manual-input.routes.ts](../../src/modules/nifty/routes/manual-input.routes.ts) takes
`observation_date`, and `manual-data-entry.service.ts` takes `observationDate` per input — so the
loader can reuse the existing validated service rather than writing raw rows.

### 5.4 Verification

Coverage report per indicator: does a value exist on or before `W_start` (the lead-in), and is every
scheduled release inside W present? Any indicator without a lead-in value will score
`insufficient_data` for the early part of W — surface it here, before replaying, not afterwards.

**Exit check:** every one of the 60 manual indicators has a lead-in value and full in-window coverage,
or its gap is listed and accepted.

---

## Stage 6 — Compass replay

**Goal:** a Compass classification for every trading day in W. Must precede Oracle: asset scorecard
assembly calls `getRegimeGateAsOf(observationDate)`, so a missing regime changes the score.

Compass is fully automated and already has the machinery —
[historical-backfill.service.ts](../../src/modules/edgefinder/services/compass/validation/historical-backfill.service.ts)
walks trading days, runs every input in the registry's dependency order strictly sequentially, then
calls `runCompassClassifier('manual', by, day, true)`. A point-in-time replay harness exists alongside
it under `compass/validation/replay/`.

### 6.1 Steps

1. Run `backfillWindow({ startDate: W_start, endDate: W_end, windowName: 'recovery' })`.
2. It skips the classifier for any day whose inputs failed — so a partial result is expected on the
   first pass. Collect failures, fix the underlying data, re-run for those days only.
3. Compass carries sequential state (`CompassCurveState`, `CompassShockState`). Replay strictly
   oldest-first; never backfill a day out of order.

### 6.2 Verification

- One `compass_classifications` row per trading day in W, no gaps.
- `compass_module_readings` / `compass_module_state` present for each.
- Regime transitions are plausible and not a single flat value for the whole window.
- `getRegimeGateAsOf()` returns a gate for `W_start` and `W_end`.

**Exit check:** zero missing days.

---

## Stage 7 — Oracle replay (the acceptance gate)

**Goal:** asset scorecards and pair scores for every trading day in W, verified against the 22 journal
snapshots.

Both orchestrators already take a target date:

```ts
runScorecardOrchestrator('manual', 'recovery', date)   // 18 assets
runPairScoreOrchestrator('manual', 'recovery', date)   // pairs, from loadPairDefinitions()
```

### 7.1 Steps

1. Write `scripts/replay-oracle.ts`: iterate trading days `W_start → W_end` **ascending**, calling the
   asset orchestrator then the pair orchestrator for each. Log per-day success and failure; support
   resuming from a given date.
2. Assets must precede pairs each day — pair scores read the asset-level results.
3. Rate-limit politely; write per-day progress so an interrupted run resumes instead of restarting.

### 7.2 Verification — the real test

Read all 22 snapshots out of the restored journal and assert that `oracleScoreOn(symbol, date)`
returns the stored value for each:

| Date | Pair | Expected |
|---|---|---|
| 2026-05-26 | GBPUSD | 5 |
| 2026-05-28 | XAUUSD | −4 |
| 2026-05-29 | XAUUSD | −2 (exit) |
| 2026-06-05 | XAUUSD | −1 |
| 2026-06-05 | GBPUSD | 5 (exit) |
| 2026-06-08 | XAUUSD | −5 (exit) |
| 2026-06-11 | EURUSD | −7 (entry and exit) |
| 2026-06-17 | XAUUSD | −6 |
| 2026-06-24 | XAUUSD | −6 (exit) |
| 2026-07-30 | EURUSD | 6 |
| 2026-07-30 | GBPUSD | 5 |
| 2026-08-10 | GBPUSD | 5 |
| 2026-08-12 | GBPUSD | 6 (exit) |
| 2026-08-14 | EURUSD | 6 (exit) |
| 2026-08-17 | EURUSD | 4 |
| 2026-08-19 | EURUSD | 4 (exit) |
| 2026-08-19 | GBPUSD | 8 (exit) |
| 2026-09-03 | EURUSD | 6 |

EURUSD/GBPUSD resolve through `edgefinder_pair_scores`; XAUUSD through `edgefinder_scorecards`
([oracle-snapshot.ts:63](../../src/modules/trading/services/oracle-snapshot.ts#L63)).

**22 of 22 must match.** A mismatch means a missing macro value, a wrong rule version (Stage 2), or a
wrong Compass regime (Stage 6). Diagnose and fix the cause. Do not relax the expectation.

Also assert: a scorecard and pair score exist for every trading day in W, and no `isCurrent`
duplicates per `(asset, date)`.

**Exit check:** 22/22 snapshots reproduced; no gaps in W.

---

## Stage 8 — NIFTY replay

**Goal:** a NIFTY scorecard for every NSE trading day in W.

`assembleScorecard({ observationDate })` is date-parameterised and reads its own history —
`observationDate: { lt: observationDate }`, 130 trailing sessions — so velocity, the peak-score ceiling
state and the composition flag all rebuild correctly **provided the replay runs oldest-first**.

### 8.1 Steps

1. Write `scripts/replay-nifty.ts`: iterate NSE trading days ascending. Skip weekends and
   `nse_holidays` days — the POST route already rejects non-trading days, and rows flagged
   `isNonTradingDay` are excluded from velocity, anchors and band distribution.
2. Resumable, with per-day logging.
3. Never run a day before the days preceding it exist.

### 8.2 Verification

- One `nifty_scorecards` row per NSE trading day in W; `isNonTradingDay` false throughout.
- `scoreVelocity1d` / `scoreVelocity5d` populated from the second/sixth day onward; nulls only where
  history genuinely does not exist.
- `peakScoreCeilingState` evolves rather than staying constant.
- `netScore = domesticScore + externalScore`, with IND13 excluded — assert directly.
- `ratingLabel` matches the active rating rule's band for `netScore` on every row.
- Spot-check one day by hand: recompute each indicator's score from its `data_points` and confirm the
  sum, the band and the counts.
- Report how many rows carry `insufficient_data` for any indicator, and for which.

**Exit check:** no gaps; the hand-checked day matches; the `insufficient_data` inventory is recorded.

---

## Stage 9 — Final verification and return to service

1. Run the full success-criteria list from §0.3 as a single script and print each result individually.
2. `npx tsc --noEmit` clean in both repositories; backend tests at their known baseline.
3. Re-enable cron jobs. Verify each job's next run targets **today**, not a backfill date.
4. Start the backend. `prisma migrate deploy` must report nothing to apply (Stage 1.2 step 5).
5. Smoke-test through the UI: Journal, Accounts, Analytics, System, NIFTY, Oracle, Compass.
6. Confirm the Phase 5 journal-capture migration is still held outside the repo, and decide separately
   whether to resume that work.

---

## Known fidelity limits — to be stated in the final report

These cannot be recovered and must not be presented as if they were:

1. **`calendar_events` before the current week.** Forward-only feed. Actuals are restored as data
   points; the release *schedule* around them is gone permanently.
2. **Revision history.** Each series will carry one vintage. Where a print was revised mid-window, the
   rebuilt score uses the final value, not what the tool saw live that day. `isCurrent` filtering makes
   the replay "correct given final data", not "identical to what was displayed".
3. **IND13 scores over W** — expanding percentile against a shorter sample (§4.3). Contained to one
   displayed row; excluded from net score.
4. **Audit trail** — `data_fetch_log` history, original `computed_at` timestamps, and the Compass
   archive tables as originally run. Regenerated, not restored.
5. **Planned trades, and the second user's journal.**
   - Planned trades are in no dump. Three screenshots owned by the journal owner (uploaded 2026-07-06,
     2026-07-07, 2026-07-31 UTC) are referenced by no restored trade — possibly planned-trade images.
     Kept in storage, never deleted.
   - The second user (`de476512-…`, matched by the baseline's `userIdSuffix: 7fb6f0`) exists in
     `baseline-before.json` only in **summary** form: one **open** EURJPY Buy on a Demo account, $0 P&L.
     The summary lacks fields the schema requires as NOT NULL — planned entry, stop and main TP, lot
     size, and the account's starting date. Restoring it would mean inventing trade data, so it is
     **not restored**; the user re-enters one open trade and one account. Two screenshots owned by that
     user were uploaded on the trade's own date (2026-06-12) — very likely its images — and are kept
     for re-attachment.
6. **Model descriptions/rules text** and any customised pair `pipValue` (§3.2).
7. **Score history before `W_start`.** Out of scope by decision. The tool will show ~3.5 months of
   history instead of its full life.

---

## Decisions needed before execution

| # | Decision | Status |
|---|---|---|
| D1 | Confirm `DROP SCHEMA public CASCADE` on the live database | **CONFIRMED 2026-09-13** — clean rebuild, after the read-only assessment is shown |
| D2 | Window start 2026-05-26 (covers all 22 snapshots) vs a literal 3 months | **CONFIRMED 2026-09-13** — 2026-05-26 |
| D2b | India CPI source | **CONFIRMED 2026-09-13** — manual. Stage 2 must set `IND_NIFTY_03_CPI.data_source = 'manual'`; the seed says `fred` |
| D2c | Admin role | **CONFIRMED 2026-09-13** — `16e3f8c7-4ae2-4bd7-9b25-fc78a61e300a` (jainaman060294@gmail.com) and `de476512-9f3f-4726-a4b0-e069937fb6f0` (arman.shaikh01082003@gmail.com). Applied in Stage 3.1 by user id |
| D2d | Writer freeze | **CONFIRMED 2026-09-13** — the Railway deployment was stopped by the user, not restarted or redeployed. No push to the Railway deploy branch until Stage 9. Tripwire: re-run forensics after the 22:30 and 23:00 UTC cron slots; any new `data_fetch_log` row means a writer is still alive — stop |
| D3 | Load `scripts/seed-edgefinder-data.ts`'s 41 historical values? | Skip; Stage 5 is authoritative inside W |
| D4 | How deep will you go on participant OI for IND13? | Take whatever NSE serves; report the achieved depth |
| D5 | Extend scoring history before `W_start` later? | Not now; the plan is structured so W can be widened by re-running Stages 6–8 with an earlier `W_start` |
| D6 | Resume the Phase 5 journal-capture work after recovery? | Hold; keep the migration outside the repo |

---

## Sequencing and rough effort

| Stage | Depends on | Effort | Notes |
|---|---|---|---|
| 0 Freeze and preserve | — | 30 min | Do 0.1 immediately |
| 1 Schema | 0 | 1 h | Mostly mechanical; verification is the value |
| 2 Config | 1 | 1–2 h | Highest risk of silent failure |
| 3 Journal | 1, 2 | 1–2 h | **Trading Hub usable after this** |
| 4 Auto backfill | 2 | 2–4 h | API rate limits dominate |
| 5 Manual entry | 2 | Your data + 1–2 h tooling | The critical-path dependency |
| 6 Compass replay | 4, 5 | 1–2 h runtime | Sequential, inter-day delay |
| 7 Oracle replay | 6 | 1–2 h runtime | Acceptance gate |
| 8 NIFTY replay | 4, 5 | 30–60 min runtime | Independent of 6–7, can run in parallel |
| 9 Final verify | all | 1 h | |

Stages 1–3 can proceed immediately and independently of the macro data. Stage 5 is the long pole: the
scoring replay cannot start until the manual prints are in. Recommended order of attack: run Stages
0–3 first so the journal is back and the tool is usable, generate the CSV template at the same time,
then work Stages 4–8 as the data arrives.

---

## Execution log

### 2026-09-13 — Stage 0: freeze, preserve, assess

Times UTC. Scripts in `recovery/scripts/`, SQL in `recovery/sql/`, captures in `recovery/snapshots/`.

**0.1 Preserve — done.** Dumps copied to `recovery/dumps/`; verified 32 trades, 36 executions,
4 accounts, 69 screenshots, balances intact. SHA-256 `dtos-after-p4.json` = `88899aa0…97eec0`,
`baseline-before.json` = `89add4fa…fda8e`. Off-machine second copy: **pending (user)**.

**Decisions:** D1, D2, D2b, D2c, D2d confirmed — see the decisions table.

**0.3 Assess** (`00-assess.ts`) — 32 tables in `public`, 6 holding rows; `_prisma_migrations` absent;
4 `auth.users`; both auth triggers present (recreated by the aborted replay); bucket
`trade-screenshots` intact with 74 objects and 4 policies.

**0.2 Forensics** (`00b-forensics.ts`, 19:45 and 20:15) — the database was **not** frozen:
- 10 cron runs after the reset, 2026-09-11 22:00 → 2026-09-12 15:32. No NSE/NIFTY jobs because
  2026-09-12 is a Saturday. Pattern of an always-on server.
- `_prisma_migrations` absent ⇒ the writer never restarted (`npm start` runs `migrate deploy`).
- The journal owner's session opened the Trading Hub at 2026-09-12 02:27:16: `public.users` row,
  3 default models and 13 default pairs, all in the same second.
- `indicators` = 1 (`IND_NIFTY_14_DII_FLOW`, 2026-09-11 20:00:31) — written by the aborted replay.
- Every local node process belongs to Vytal, a different project; no Lucid backend on this machine.
  Code references `RAILWAY_PUBLIC_DOMAIN`. **The user stopped the Railway deployment.** Re-run at
  20:15: no writes since 15:32.
- Storage: 69/69 referenced objects present, none created after the reset; 5 unreferenced — see
  Known fidelity limits §5.
- Tooling fix: `00b` read naive timestamps as local time (IST, +5h30) in its age column; corrected.

**0.4 Pre-drop capture** (`00c-predrop-capture.ts`, 20:18) — **SAFE TO DROP.** Outside `public`,
CASCADE reaches only `auth.users.on_auth_user_created` and `on_auth_user_email_changed`. Extensions
live in `extensions`, `vault` and `pg_catalog`. No views, foreign keys, typed columns or policies reach
into `public`; no RLS; no realtime publication rows.

**0.4b Catalog + grants** (`00d-catalog-and-grants.ts`, 20:25) — `replay37-catalog.json`: 32 tables,
401 columns, 119 indexes, 56 constraints, 12 enums. Grants: `public` privileges held by `postgres`
only; `anon`, `authenticated` and `service_role` have no schema USAGE and no table access; no default
privileges on `public` in any form; no event trigger grants on CREATE TABLE. ⇒ rebuild owner-only.

**Findings that changed the plan**
- `prisma.config.ts` imports `dotenv/config` and sets the CLI datasource to `DIRECT_URL` (Supavisor
  session pooler, port 5432). No shadow database is configured anywhere. Every Prisma CLI command in
  this recovery targets `DIRECT_URL`.
- `001`'s `on_auth_user_changed` must **not** be recreated — it would reintroduce the display-name bug
  `20260612120000` fixed. Stage 1.2 corrected; `01-post-push.sql` written.
- Stage 1.3's `migrate diff` syntax was wrong; corrected to `--from-url`.
- Stage 0.4's DROP block granted `anon`/`authenticated` schema USAGE; removed. `02-grants.sql` is
  REVOKE-only.
- Migrations #38–#48 add exactly 6 tables (`nse_holidays`, `compass_classifications_archive`,
  `compass_inputs_archive`, `compass_module_readings`, `compass_module_states`, `compass_synthesis`)
  and columns on `nifty_scorecards`, `compass_classifications`, `compass_inputs`,
  `compass_curve_state`, `compass_shock_state`. The offline DDL from `schema.prisma`
  (`00-schema-from-datamodel.sql`, generated with the database URLs pointed at a closed local port)
  creates 38 tables and 12 enums: 32 + 6, and 12. Column-level proof runs after `db push`.
- The second user's journal is summary-only and is not restored (Known fidelity limits §5).
- No Docker or Postgres locally, so no rehearsal database. Accepted: `public` holds nothing
  irreplaceable until Stage 3 writes the journal.

**2026-09-13 19:38 — tripwire FIRED.** Forensics found 9 further `cron` runs after the user's first
stop (2026-09-12 23:00 → 2026-09-13 15:30, all at scheduled slots); `calendar_events` 80 → 177;
nothing else written. `_prisma_migrations` still absent ⇒ the same process kept running, never
restarted — the first stop hit something other than the writer. DROP withheld. The user then found and
stopped the writer (service not specified). Baseline for the next tripwire: `data_fetch_log` = 19,
`calendar_events` = 177. Gate: no new row after the 23:00 UTC slot.

**Stage 5 data arrived (parallel session).** `scripts/data/manual-backfill/*.csv`, from Trading
Economics: 402 rows, 60/60 indicators, every row with actual and consensus, lead-in before `W_start`
for all; 398 `VERIFIED_TE`, 3 `PARTIAL_TE`, 1 `NON_TE`. Flag for Stage 8: India CPI changed base series
on 2026-02-12, so `two_component_cpi`'s 3-month averages for Feb–Apr span old and new series.

**2026-09-13/14 — Stage 1–3 tooling built and validated without touching the database.**

| File | Purpose | Validated |
|---|---|---|
| `scripts/00e-tripwire.ts` | CLEAR/FIRED vs the 19/177 baseline | armed via Monitor for 23:05 UTC |
| `sql/00-drop-public.sql` | Stage 0.4 DROP, 10 s lock timeout | — |
| `scripts/10-stage1-schema.ts` | guarded: db push → 01 → 02 → resolve ×48 → status; dry run default | dry run refused correctly (public not empty) |
| `sql/01-post-push.sql`, `sql/02-grants.sql` | non-Prisma objects; owner-only grants | — |
| `scripts/11-verify-schema.ts` | rebuilt catalog vs `replay37-catalog.json` + #38–#48 deltas | — |
| `scripts/build-03-config-replay.ts` → `sql/03-config-replay.sql` | config copied verbatim from migrations; refuses destructive statements | built: 7 sections, 84 holidays |
| `scripts/20-stage2-config.ts` | guarded: 5 seeds → 03 → assert; dry run default | — |
| `scripts/21-assert-config.ts` | rules checked by date incl. the 2026-08-17 v2→v3 boundary | — |
| `scripts/30-restore-journal.ts` | verbatim restore, SHA-checked dump, field-by-field verify | dry run passes; +1.86R present in dump |

All recovery scripts type-check clean (`npx tsc -p recovery/tsconfig.json`).

Established while building: IND14 is intentionally unscored (`NON_SCORED_NIFTY_INDICATORS`); v2 NIFTY
rules start 2026-05-17, before `W_start`; Compass config v1/v2/v3 cover the window contiguously
(switching 2026-07-16 and 2026-09-09); "No Model" is a user-created model, restored with empty
description and rules; the seeds already carry the price-source switches, COT metadata, IND13 v2
recalibration and PPI rename, but not the IND07 formula fix, the v3 rules, IIP/CPI manual, or the NSE
holidays — which is exactly what `03-config-replay.sql` supplies.

**2026-09-14 04:08 — tripwire FIRED again.** 8 further `cron` runs (2026-09-13 23:00 → 2026-09-14
02:35) after the user's second stop; `data_fetch_log` 19 → 27, `calendar_events` 177 → 184. The DROP
stays withheld. Recommended fail-safe: reset the database password in Supabase (cuts off the writer
wherever it runs). New baseline for the next check: 27 / 184. Live FF titles captured before any drop
to `recovery/snapshots/ff-titles-live.json` (171 distinct).

**2026-09-14 — Stage 5 handoff implemented in code (no database access).** The parallel session's
handoff ruled the user's measures authoritative over code names. Decisions and changes:

- **Relabel, not rename.** Codes stay (`US_PPI_MOM` etc.); names and descriptions carry the measure
  actually tracked. A code rename mid-recovery would ripple through pair templates, the FF mapping, the
  frontend, tests and all 402 CSV rows. Deferred to a separate change after the rebuild is verified.
- **Relabelled** (`seed-edgefinder.ts`): US/EU/UK PPI → YoY; JP retail → MoM; Tokyo CPI → headline;
  `US_CB_CONSCONF` → Michigan; `AU_CONSCONF` → Westpac-MI index level; EU/JP/AU PMIs → S&P Global;
  EU CPI → flash→final. "Tokyo Core CPI" → "Tokyo CPI" changed in lockstep across the pair-template
  `displayName`, `PAIR_ROW_TO_SLOT` (oracle-mappers.ts) and the frontend label — the slot mapping is
  keyed on that string.
- **Ladders added** (`seed-indicator-variants.ts`): `EU_CPI_YOY` flash/final, `US_CB_CONSCONF`
  prelim/final, `IND_NIFTY_01_PMI_MFG` and `IND_NIFTY_02_PMI_SVC` flash/final.
- **FF mapping.** Found that FF ingestion WRITES values for mapped titles, not just dates. Where FF
  publishes a different measure and no title for the tracked one (verified against the live feed), the
  title is now `alertOnly()`: calendar row and overdue still work, no value is written. Eight titles:
  US/EU "PPI m/m", GBP "PPI Output m/m", JPY "Retail Sales y/y", "National Core CPI y/y",
  "Tokyo Core CPI y/y", AUD "PPI q/q", "Westpac Consumer Sentiment". Michigan remapped to
  "Prelim UoM Consumer Sentiment" (verified live) / "Revised UoM Consumer Sentiment" (FF convention,
  HIGH) as rungs; "CB Consumer Confidence" unmapped. EU CPI titles are rungs. "Core PCE Price Index m/m"
  removed. Service skips the value write for alert-only titles and records `alertOnlyCount`.
- **Latest-print rule verified, not changed.** `findLatestRelease` resolves the most recent
  `observationDate <= scoring date`; ordinal only breaks same-date ties. NIFTY's threshold handler and
  `cpi_rate_cycle` order by date without the tie-break, so the loader refuses any same-date rows for one
  indicator (the CSVs have none).
- **Stances: seed placeholders kept, per the user.** Confirmed in code the user is right that they do
  not affect CPI scoring: `ruleForIndicator` empties the `cpiRateCycle` map ("Change 1, cycle-gating
  removal"), so every CPI indicator scores as plain surprise. Residual: `fed_constraint` (null = FREE)
  still gates Compass's gold override — only XAUUSD snapshots could be sensitive.
- **Loader:** `recovery/scripts/40-load-manual-backfill.ts` — validates against the live registry,
  coverage report, revision report, refuses conflicts; dry run by default.
- `21-assert-config.ts` now also checks all 16 ladders and the relabels, including the Tokyo
  pair-template name.
- Verified: backend, frontend and recovery-script `tsc` clean; FF mapping (50), FF ingestion service
  (37, including a new alert-only case), overdue resolver (15) and manual data entry (21) tests pass —
  123/123. Not yet exercised against a database: the ladder seeds, the relabels, the loader and
  `21-assert-config.ts` all run for real at Stages 2 and 5.

**2026-09-14 — writer freeze by code, decided by the user.** Instead of a password reset: comment out
every cron registration in `src/server.ts`, push to `main` so production redeploys without a
scheduler, then run the recovery. Also removed `npx prisma migrate deploy && ` from `package.json`'s
start script for the hold: against the half-built database it fails, which would crash the new deploy
and could leave the old container — and its crons — running. The commit contains only those two files.
Pushed 2026-09-14 05:1x UTC as `7101b92` on `main` (`cb7ed0c..7101b92`); the exact committed tree
passed strict `tsc` in a clean HEAD worktree before the push. The redeployed server logs
"Scheduler ON HOLD for database recovery — no cron jobs registered" at startup.

### 2026-09-14 — Stage 0.4 DROP and Stage 1 schema: DONE

Gates before the drop (05:17 UTC): the user confirmed Railway's redeploy of `7101b92` logs "Scheduler
ON HOLD"; `00c` re-run SAFE TO DROP (CASCADE reaches only the two `auth.users` triggers); `00e`
tripwire CLEAR at 27 / 184.

- 05:18 `00-drop-public.sql` executed.
- `10-stage1-schema.ts --execute`: `db push` in sync (17.8 s); `01-post-push.sql`; `02-grants.sql`;
  48/48 migrations resolved as applied; `migrate status` — "Database schema is up to date!"
- First `11-verify-schema.ts`: 6 unexplained differences. Resolved, not waived:
  - `_prisma_migrations` flagged as unexpected — verifier bug (the reference predates it); allow-listed.
  - `db push` truncates generated names at 63 bytes differently from the explicit names the migrations
    wrote: `data_points_…_vintage_d_key` vs `…_vintage_key`, and all 7 indexes on the #47 Compass tables.
    Definitions identical. Renamed to the migration names.
  - `compass_classifications_research_tag_idx` and `compass_inputs_research_tag_idx` (#46) are not
    declared in `schema.prisma`. Created.
  - `compass_inputs`' unique was a CONSTRAINT in production; `db push` builds a bare unique index.
    Attached with `ADD CONSTRAINT … UNIQUE USING INDEX`.
  - Fixes live in `recovery/sql/01b-parity.sql`, now step 2b of the Stage 1 runner for any future
    rebuild. No application code references these names (grep).
  - The verifier had a blind spot — it never checked the 6 new tables. It now compares their columns
    against the migrations' `CREATE TABLE` DDL (with #48's width change) and checks all 10
    migration-named indexes.
- Second `11-verify-schema.ts`: **VERIFIED** — 39 tables, 410 columns, 126 indexes, 56 constraints,
  12 enums; 6 new tables match their migration DDL.

### 2026-09-14 — Stage 2 config: DONE

`20-stage2-config.ts --execute`, 05:25–05:32 UTC. Seeds in order (`seed.ts`, `seed-rules-v2.ts` —
expired 13 v1 rules and 1 v1 rating rule — `seed-edgefinder.ts`, `seed-indicator-variants.ts` — 16
ladders, 34 rows — `seed-compass-config.ts` — v1/v2/v3), then `03-config-replay.sql`, then
`21-assert-config.ts`: **CONFIG VERIFIED — 0 fail, 2 warn.**

- 14 NIFTY / 65 EdgeFinder indicators; EF sources 55 forex_factory, 9 cftc, 1 fred.
- NIFTY CPI and IIP manual; DXY/USDINR eodhd, Brent yahoo.
- Rules by date: IND10/11/12/13 on v2 through 2026-08-16 and v3 from 2026-08-17 (boundary checked on
  both days); IND07 carries the `abs(fii_sell)` fix; every EF indicator has an active rule at both ends
  of the window.
- All 16 ladders exactly as expected, no extras; every relabel present, including the `Tokyo CPI`
  pair-template row.
- COT metadata for USD/EUR/GBP/JPY/XAUUSD; 20 assets; 19 pair-template rows, 55 currency rows, 125
  asset-map rows.
- 84 NSE holidays; two fall inside the window (2026-05-28, 2026-06-26).
- Compass config v1 active at `W_start`, v3 at `W_end`.
- WARNs, accepted per the user: stances are the seed placeholders (AUD NEUTRAL). They do not affect CPI
  scoring (see the handoff entry).

### 2026-09-14 — Stage 3 journal: DONE

`30-restore-journal.ts --apply`, 05:32–05:33 UTC.

- 4 `public.users` rows backfilled from `auth.users`; admin set on the two confirmed ids.
- Bootstrap defaults: 3 models and 13 pairs; "No Model" created, with no description or rules.
- 4 accounts, 1 payout, 32 trades, 36 executions in one transaction.

**JOURNAL VERIFIED — 0 fail:**
- 32 / 36 / 4.
- Balances equal to the cent: 10040.00, 10325.40, 10818.91, 10511.58.
- Exactly one primary per trade.
- Every restored value equals the dump, field by field.
- EURUSD 2026-08-17 fills at +1.86R.
- Screenshots 69/69 resolve.

Stage 5 loader dry run the same minute: VALIDATION PASSED — 402 rows, 60/60 indicators with lead-in and
no gap over cadence, 4 warnings (the known PARTIAL_TE/NON_TE rows), 88 informational revisions
(`previous` differs from the prior print on file).

### 2026-09-14 — Stage 5 manual macro data: DONE

`40-load-manual-backfill.ts --apply`, 05:33 UTC.

**VERIFIED: all 402 rows present with identical actual / consensus / previous.**
- 402 written, 0 pre-existing, 0 conflicts.
- Every row is tagged `created_by = 'recovery-stage5'`, with `sourceMetadata` carrying the CSV file,
  line, status, TE URL, reference period and release time, so the load is fully reversible.
- The 88 revision notes span 25 indicators (US jobless claims 17, the rest 1–5 each). **None is a rate
  decision**, where `previous` feeds the HIKE/CUT label. Elsewhere `previous` is only a fallback baseline
  when consensus is missing, and no row lacks consensus. None of them affects a score.

Stage 5 ran before Stage 4 on purpose: the manual prints do not depend on the auto series, and loading
them first let the journal and macro data be verified while Stage 4 was still being scoped.

### 2026-09-14 — Stages 4 and 6 scoped: sources, depths, constraints

Established from the code and read-only probes. Nothing written yet.

**Constraints**
- **EODHD is on the free plan: 20 calls/day** (plus 258 extra), with about twelve months of history.
  The Compass input services call EODHD per day (4 symbols), so a naive backfill would need about 440
  calls.
- Compass input services are point-in-time **only in validation mode**. In live mode they anchor
  fetches to today and do not filter later data. Oracle reads the live regime
  (`getRegimeGateAsOf(isValidation = false)`).
- NSE's FII/DII (`/api/fiidiiTradeReact`) and VIX (`/api/allIndices`) endpoints are live-only.
- The CFTC client capped results at 100 rows. Fixed: `CFTC_ROW_LIMIT = 5000` with a warning at the
  cap. The one failing CFTC client test (`omits X-App-Token`) is pre-existing and environmental — the
  local `.env` sets `CFTC_APP_TOKEN`, which the re-imported client reloads; the diff touches neither
  headers nor env.

**Decisions** (`recovery/scripts/45-auto-series-backfill.ts`, `50-compass-backfill.ts`)
- **DXY from 2026-04-23, not 14 months.** Migration `20260817150000`'s note records that production's
  DXY history began then (about 82 observations by 2026-08-17). The v3 slope-sigma estimate depends on
  depth, so deeper history would *change* the scores being recovered. USDINR from about 12 months back
  (the EODHD limit). v2 (through 2026-08-16) needs only 11 observations.
- **Brent: Yahoo BZ=F throughout.** Production's Brent history mixed sources (EODHD → crude-price API
  2026-06-10 → Yahoo 2026-07-13), and that mix cannot be reconstructed. BZ=F for the whole history is a
  known fidelity limit, relevant only to IND11's v3 sigma from 2026-08-17.
- **India VIX: Yahoo `^INDIAVIX`** (491 closes 2024-09 → 2026-09; 2026-05-28 empty = NSE holiday),
  marked `historySubstituteFor` in metadata. IND08 scores the level band only.
- **IND13 participant OI: NSE archives back to 2022-06-15**, where production's history began
  (archives verified to serve 2022 files). The expanding percentile needs the full history to reproduce.
- **COT: shipped service, `daysBack` 150**, after the row-limit fix.
- **FII/DII (IND06/07/14), in progress, user chose "search for a source first".** Groww's
  `v1/api/search/v3/query/fii_dii/st_fii_dii` with `segment=Cash Market&period=daily` returns NSE's
  provisional figures exactly — the 2026-09-11 row matches NSE live to the cent (FII net −930.9, DII
  net 1968.17, gross buy/sell included). The default depth is 20 trading days; reaching May is still
  being probed.
- **Compass: validation-space backfill, then promote to live.** Run the shipped `backfillWindow` from
  2026-04-11 (the classifier reads 45 days of stored inputs), with `eodhdClient.fetchEodSeries` and
  non-vintage FRED calls memoized in the recovery process only (about 4 EODHD calls in total; FRED
  vintage calls stay per-day). Then copy validation rows to live space in one transaction, with columns
  discovered at runtime. `compass_classifications` is unique on (date, vintage_date) without
  `is_validation`, so the live copy shifts `vintage_date` by 1 ms. The alternative — changing 7
  production input services mid-recovery — was rejected.

### 2026-09-14 — Stage 4 auto series: DONE (IND13 still loading)

**FII/DII — source verified, then loaded.** `46-fii-dii-backfill.ts`:
- **Source.** Groww `period=custom` returns daily rows only for ranges of 2 weeks or less (longer ranges
  come back weekly), so the window was fetched in 14-day chunks. 97 rows equal 97 NSE trading days
  (2026-04-27 → 2026-09-11): 0 missing, 0 extra, 0 chunk conflicts. The 2026-09-11 row matched NSE
  live on all six figures before writing.
- **Written:** 291 rows (IND06 / IND07 / IND14 × 97 days), mirroring `nse-fii-dii.service.ts`'s
  values, sources, metadata and vintage rule. **VERIFIED: all equal the source.**

**Other series.**
- `45-auto-series-backfill.ts --step=eodhd,fred,brent,vix,cftc` (05:55–06:11 UTC): exit 0; COT 189
  rows inserted, 0 unmatched.
- `--step=poi --poi-from=2022-06-15`: running in the background, logging to `recovery/logs/poi.log`.

**Depth verified in the database** (current rows):

| Series | Rows | Range | Before W_start | Before 2026-08-17 | Source |
|---|---|---|---|---|---|
| IND06 FII flow | 97 | 2026-04-27 → 09-11 | 20 | 77 | nse_scrape |
| IND07 DII absorption | 97 | 2026-04-27 → 09-11 | 20 | 77 | derived |
| IND14 DII flow | 97 | 2026-04-27 → 09-11 | 20 | 77 | nse_scrape |
| IND08 VIX | 113 | 2026-04-01 → 09-11 | 36 | 93 | yahoo |
| IND10 DXY | 102 | 2026-04-23 → 09-11 | 23 | **82** | eodhd |
| IND11 Brent | 323 | 2025-06-02 → 09-11 | 247 | 304 | yahoo |
| IND12 USDINR | 260 | 2025-09-15 → 09-11 | 181 | 240 | eodhd |
| US_02Y_SMA | 320 | 2025-06-02 → 09-10 | 245 | 302 | fred |
| COT, 9 contracts | 21 each | 2026-04-21 → 09-08 | — | — | cftc |

- **DXY has 82 observations before 2026-08-17 — exactly the "~82 distinct observations" migration
  `20260817150000` recorded for production on that date.** The rebuilt v3 slope-sigma depth therefore
  matches production's.
- Brent and USDINR clear the 60-observation sigma minimum by a wide margin.
- IND06's 10-day and IND07's 5-day lead-ins are covered.

### 2026-09-14 — Stage 6 finding: config v1 predates the Shock Layer

The `--backfill` run (from 06:12 UTC) wrote validation inputs normally, but **every classifier run
failed** with `Cannot read properties of undefined (reading 'shock_a_vix_threshold')`.

- **Cause.** Compass config v1 (effective 2026-01-01 → 2026-07-15) carries the retired
  `crisisOverride` (VIX > 30 AND HY OAS > 7.0) and no `shockLayer`. The current classifier reads
  `config.shockLayer` unconditionally. Production never re-ran v1 dates with Shock Layer code, so the
  original v1-era classifications (April → mid-July) came from older code and cannot be reproduced
  exactly by the current classifier. v2 and v3 dates carry `shockLayer` and are unaffected.
- **Decision (recovery process only; production code untouched).** Where a resolved config lacks
  `shockLayer`, substitute a **disabled** one: Trigger A requires VIX > +∞ and Trigger B a USDJPY
  5-day move < −∞, so neither can fire. Those dates then classify as they did before the Shock Layer
  existed.
- **Accepted fidelity limit.** The retired crisis clause is not reproduced. It needs crisis-level
  spreads (HY OAS > 7%), so in May–July 2026 it would not have fired.
- **Oracle impact.** Compass changes Oracle scores only on Risk-Off paths. With no classification,
  Oracle defaults to Caution with no overrides.
- **Procedure.** Let `--backfill` finish (its inputs are valid), then `--classify`: reset
  validation-space classifier output and state caches in range, classify every US trading day oldest
  first with the patch, verify one classification per day, then `--promote`.

### 2026-09-14 — IND13 participant OI: DONE

`45-auto-series-backfill.ts --step=poi --poi-from=2022-06-15`, 06:05–07:12 UTC:
**1,029 inserted, 9 no_data, 12 failed**, of 1,050 NSE trading days.

- **no_data (9):** NSE published no file. Several are known market closures missing from
  `nse_holidays` (2024-01-22, 2024-05-20, 2024-11-20, …). None falls inside the window.
- **failed (12, 2023-01-03 and eleven 2024 dates):** the file's title line is quoted differently
  (`…as on Mar 01,"2024"""""`), which the shipped parser rejects. **Not fixed, deliberately.**
  Production's IND13 history was loaded by this same parser, so production almost certainly lacks
  the same 12 days; keeping the parser reproduces the expanding percentile more faithfully. A parser
  fix is a separate, later change.
- `90-final-verify.ts` tolerates 2.5% missing for IND13, with this reasoning recorded in the check.

### 2026-09-14 — Stage 6 Compass inputs: DONE; classification re-run in progress

`50-compass-backfill.ts --backfill`, 06:12–07:16 UTC (3,846 s), exit 0.

- **Inputs: 954 = 9 input codes × 106 US trading days** (2026-04-11 → 2026-09-13). No day skipped for
  inputs.
- **EODHD: 4 real calls** (VIX.INDX 205 rows, VIX3M.INDX 203, DXY.INDX 203, USDJPY.FOREX 268, all from
  2025-12-01), with 530 served from memo. The free plan's 20/day was never at risk.
- **FRED:** 4 latest-vintage series fetches (420 memo hits) plus 424 point-in-time vintage calls for
  the US data stack.
- **All 106 classifier attempts failed** (config v1 shock-layer gap; see above). Re-running with
  `--classify`, started 07:17 UTC.

NIFTY replay (`80-nifty-replay.ts --run`) started in parallel. It reads only the database.

### 2026-09-14 — Stage 6 Compass classification: VERIFIED

`50-compass-backfill.ts --classify`, 07:16–07:27 UTC.

- Reset validation-space classifier output first: 41 classifications left by the backfill's v2/v3
  days, plus the curve and shock state caches.
- Then classified every US trading day oldest first: **106/106 success, 0 failures.**
- The disabled Shock Layer was applied only to config **v1**.
- No external calls; the classifier reads stored inputs.

**CLASSIFICATION VERIFIED: 106/106 trading days, none missing in the window.**

- **Window regimes: Caution 49, Risk-On 27, Risk-Off 0.** Compass adjusts Oracle only on Risk-Off
  paths, and the shock triggers could not have fired, so the v1 shock-layer approximation cannot
  change any Oracle score in the window.
- **Note.** The input check found 2026-09-11 short one of its 9 inputs; the classifier still wrote
  that day. It is recorded, not blocking.

Next, chained so any failure stops the rest: `--promote`, then `70-oracle-replay.ts --run`, then
`--verify`.

### 2026-09-14 — Promotion VERIFIED; replays interrupted by a pooler outage

**`--promote` (07:27 UTC) — PROMOTION VERIFIED.**
- 983 inputs, 106 classifications and 1 shock-state row copied to live space.
- Current classifications: 106 validation = 106 live (2026-04-13 → 2026-09-11).
- Live regime gate: Caution at W_start, Risk-On at W_end.
- Module readings, module states, synthesis and curve state were 0 rows in validation space, so
  nothing was copied for them.

**07:54:01 UTC — Supabase pooler outage.** Both replays died in the same second with
"Can't reach database server at …pooler.supabase.com:6543". Both URLs answered again by 07:56.

| Replay | Reached | Resume |
|---|---|---|
| NIFTY | 40 scorecards (2026-05-26 → 07-22); IND9 written for 07-23, its scorecard not | `--from=2026-07-23` |
| Oracle | 3 days of assets; 2026-05-28's pair scores only partly written | re-run 05-28 onward |

Re-running a date is vintage-safe: identical values are skipped.

**Changes made.**
- Both replay scripts now retry a whole day on connection errors, including connection failures the
  Oracle orchestrators swallow per asset.
- **The Oracle replay averaged about 9 minutes per day**, which projects to about 16 hours for the full
  window. Oracle days carry no day-to-day state, so `70-oracle-replay.ts` accepts `--snapshot-dates`.
  It replays first the 15 distinct dates the journal snapshotted, then `--verify` answers the
  acceptance gate before the remaining days are filled.

### 2026-09-14 — Finding: most Oracle snapshots record OLDER code's output; acceptance gate revised

**First result.** The two earliest snapshot dates replayed failed by a wide margin: 2026-05-26 GBPUSD
expected 5, rebuilt −3; 2026-05-28 XAUUSD expected −4, rebuilt 2.

**Cause, from the evidence.**
- **How snapshots were captured.** Every snapshot's `captured_at` is 2026-08-19 (three are 08-19
  15:49–15:53 and 09-04), not its score date. Migration `20260815120000_journal_oracle_snapshot` fills
  `oracle_score_at_entry` from the `edgefinder_pair_scores` / `edgefinder_scorecards` row **stored**
  for the entry date. A snapshot therefore records the row as it was originally computed — by the code
  live on that date.
- **What changed since.** Git shows Oracle scoring changed repeatedly between the window start and
  August: `ad38dd2`–`2f5781e` versions 2–6 (June 6–12), `ab4c4c9` Lucidv2 (07-02), `99e7bc5` 2y yield
  fix (07-05), `eb21c82` Compass v2 (07-16), `015deb4` AUD added (08-02), and **`9b011a5` "Stance
  removed" (08-04)** — CPI scoring switching from the stance matrix to plain surprise.
- **Conclusion.** Rows for May–July dates were produced by earlier code versions. **No data can make
  today's code reproduce another version's output**, so plan criterion 6 ("22 of 22 must match") was
  unachievable as written. The plan's assumption that the snapshots were independent evidence of the
  *current* system's output was wrong.

**Revised gate.**
- The acceptance test is the **8 snapshots dated on or after 2026-08-05**, produced by today's scoring
  code: 08-10 GBPUSD entry, 08-12 GBPUSD exit, 08-14 EURUSD exit, 08-17 EURUSD entry, 08-19 EURUSD exit
  ×2, 08-19 GBPUSD exit, 09-03 EURUSD entry. All must match.
- The 14 earlier snapshots are reported as informational.
- `70-oracle-replay.ts --verify` now reports both groups and fails only on the gate group.
- Those 6 dates are replaying now in a separate process.

**Residual risk inside the gate.** Production scored with the data entered by the evening of each date.
The rebuild assumes every print was entered on its release date. Entry lag in production would show up
as a gate mismatch and would need to be read row by row.

### 2026-09-14 — NIFTY replay complete; RBI cycle state gap fixed

**First complete NIFTY run.** `80-nifty-replay.ts`: 40 days before the outage, then 37 via
`--from=2026-07-23`, 0 failures. `--verify` passed: 77/77 NSE trading days, no non-trading-day rows,
net = domestic + external.

**Its inventory exposed a gap:** `IND_NIFTY_04_RBI_RATE` was insufficient_data on **all 77 days**.
- The `cycle_regime` handler scores from `sourceMetadata.state` (cutting / paused_after_hikes /
  hold_neutral / hiking / hawkish_hold). That state is a judgment recorded at entry; no code derives
  it, and the Stage 5 loader did not write it.
- All four 2026 MPC decisions held at 5.25% (02-06, 04-08, 06-05, 08-05).
- **User decision: `hold_neutral` (score 0) for all four.** Written by
  `41-set-rbi-cycle-state.ts --state=hold_neutral`, which merges the state into metadata and leaves
  values untouched.
- Net scores are unchanged (an unscored indicator already added 0). Breakdowns, neutral counts and
  missing-indicator lists change, so the full NIFTY window is being re-run and re-verified.

**Rerun result.** Re-verified: 77/77 days, 0 failures, and the insufficient_data inventory is now
**empty**, with IND04 scored on every day. Rating distribution: Bearish 22, Caution 10, Neutral 32,
Strong Bearish 9, Bullish 4.

### 2026-09-14 — Oracle: COT release-date fix; acceptance gate is now coverage

**User decision on the snapshot mismatches.**
- Every Oracle input was entered by hand. The Forex Factory pipeline never injected values.
- Exact matches are hard, and some discrepancy is acceptable.
- COT: a report is used only once it is released (the Friday). Until the next release, the most recent
  released report applies.

**Code fix (production code, uncommitted).**
- The COT lookups used `reportDate <= date`. A replay of a Tuesday–Thursday therefore saw that week's
  report days before CFTC released it. The gate snapshots on 08-12, 08-19 ×3 and 09-03 were affected.
- `releaseDate <= date` is added to both lookups: `cot-two-component.handler.ts` (asset COT score) and
  `pair-score.service.ts` `loadCotChangeLabel` (pair COT). The ordering stays `reportDate desc`.
- Live behaviour is unchanged, because a row only exists after its release is fetched.
- All 189 current `cot_data` rows have `release_date = report_date + 3`.
- A test was added for each lookup; the COT and pair-score suites pass, and tsc is clean.

**Speed.** One Oracle day took about 600 s through the transaction pooler (`pgbouncer=true`) and
155 s through the session pooler. The full-window rerun uses `DATABASE_URL = DIRECT_URL` with
`connection_limit=4`, across 3 parallel date partitions (days are independent).

**Revised gate** (`70-oracle-replay.ts --verify`):
- Asset scorecards and pair scores exist for every asset and pair on every calendar day.
- Every journal snapshot resolves to a rebuilt score.
- Snapshot agreement (exact, within ±1, mean |diff|) is reported for information only.
- `90-final-verify.ts` uses the same criterion.

### 2026-09-14 — Oracle full-window replay VERIFIED; Stage 9 final verification: RECOVERY VERIFIED

**Oracle replay.** All 111 calendar days (2026-05-26 → 2026-09-13), with the COT release fix, ran in
3 partitions from 10:14 to 11:43 UTC. There were 0 failures and 0 connection errors.
- **Coverage:** 9 asset scorecards and 9 pair scores on every day.
- **Snapshots:** all 22 journal snapshots resolve to a rebuilt score.
- **Inputs:** no asset indicator is ever unscored. The only excluded pair rows are the other-currency
  template rows (Tokyo CPI on GBPUSD, and so on), which are excluded by design.

**Snapshot agreement (informational, discrepancy accepted by the user).**
- Exact 1/22, within ±1 7/22, mean |diff| 3.09.
- Current-code snapshots (≥ 08-05): exact 0/8, within ±1 4/8. The rebuilt score is lower on every one:
  08-10 GBPUSD −3, 08-12 GBPUSD −5, 08-14 EURUSD −3, 08-17 EURUSD −1, 08-19 −1 ×3, 09-03 EURUSD −4.
- Because every indicator is scored, the residual comes from input values — the Trading Economics
  prints and consensus collected after the loss versus what was entered at the time — plus COT now
  switching on its Friday release.

**Final verification** (`90-final-verify.ts`, log `recovery/logs/final-verify.log`): **RECOVERY VERIFIED —
10/10 criteria pass**: schema, config (2 stance-placeholder warnings), journal, Oracle, NIFTY, migrate
status (48 applied, none pending), 402/402 manual prints, Compass live classification for all 76 US
trading days, IND13 1029/1050, and no cron runs since the hold.

**Scheduler re-enabled locally** (`spec-unhold.mjs`): the cron imports and registrations in
`src/server.ts` and `npx prisma migrate deploy && ` in the start script are restored. `migrate deploy` is a
no-op because all 48 migrations are recorded. **Not yet committed or pushed — awaiting user approval.**

**Open**
- **PUSH THE SCHEDULER RE-ENABLE TO PRODUCTION** (with user approval). Production still runs 7101b92,
  which has the scheduler on hold. Restore the imports and registrations in
  `src/server.ts` and `npx prisma migrate deploy && ` in the start script (the exact reverse edit is kept
  as `spec-unhold.mjs`). Only after Stage 1 has resolved all 48 migrations, so `migrate deploy` is a
  no-op, and after the replays, so the first cron runs land on a complete database.
- 0.4 DROP — ready (`00-drop-public.sql`); gated on the tripwire above.
- Tripwire: re-run `00b-forensics.ts` after the 22:30 and 23:00 UTC cron slots.
- Off-machine copy of `recovery/dumps/`.
