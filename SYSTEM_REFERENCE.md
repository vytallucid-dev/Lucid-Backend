# Lucid Backend — System Reference Guide

> **Purpose:** Complete technical reference for testing, debugging, and understanding data flow across both the **NIFTY** and **EdgeFinder** modules, plus all sub-tools.

---

## Table of Contents

1. [NIFTY Module](#1-nifty-module)
2. [EdgeFinder Module](#2-edgefinder-module)
3. [Sub-Tools Deep Dive](#3-sub-tools-deep-dive)

---

---

# 1. NIFTY Module

The NIFTY module produces a daily **scorecard** for the NIFTY 50 index. It is composed of **13 indicators** split into two sub-groups: **Domestic** (Ind 1–7) and **External** (Ind 8–13). The final net score drives a band label (Strong Bullish → Strong Bearish).

---

## 1.1 Indicators Summary

| # | Code | Name | Group | Data Source | Frequency |
|---|------|------|-------|-------------|-----------|
| 1 | `IND_NIFTY_01_PMI_MFG` | India PMI Manufacturing | Domestic | Manual | Monthly |
| 2 | `IND_NIFTY_02_PMI_SVC` | India PMI Services | Domestic | Manual | Monthly |
| 3 | `IND_NIFTY_03_CPI` | India CPI YoY | Domestic | FRED (`INDCPIALLMINMEI`) | Monthly |
| 4 | `IND_NIFTY_04_RBI_RATE` | RBI Repo Rate Direction | Domestic | Manual | Event-driven |
| 5 | `IND_NIFTY_05_IIP` | India Industrial Production | Domestic | FRED (`INDPROINDMISMEI`) | Monthly |
| 6 | `IND_NIFTY_06_FII_FLOW` | FII 10-day Rolling Cash Flow | Domestic | NSE scrape (`/api/fiidiiTradeReact`) | Daily |
| 7 | `IND_NIFTY_07_DII_ABSORPTION` | DII Absorption Ratio | Domestic | Derived (from NSE FII/DII) | Daily |
| 8 | `IND_NIFTY_08_VIX` | India VIX | External | NSE scrape (`/api/allIndices`) | Daily |
| 9 | `IND_NIFTY_09_USD_WEAKNESS` | USD Weakness (NIFTY-facing) | External | Derived (from EdgeFinder USD scorecard) | Daily |
| 10 | `IND_NIFTY_10_DXY` | DXY 10-day Direction | External | FRED (`DTWEXBGS`) | Daily |
| 11 | `IND_NIFTY_11_BRENT` | Brent Crude 10-day Direction | External | FRED (`DCOILBRENTEU`) | Daily |
| 12 | `IND_NIFTY_12_USDINR` | USD/INR 10-day Direction | External | FRED (`DEXINUS`) | Daily |
| 13 | `IND_NIFTY_13_FII_LS_RATIO` | FII Long/Short Ratio (Futures) | External | NSE Archives CSV | Daily |
| 14 | `IND_NIFTY_14_DII_FLOW` | DII Net Flow | — (display-only, not scored) | NSE scrape (`/api/fiidiiTradeReact`) | Daily |

---

## 1.2 Indicator Deep Dives

---

### Ind 1 — `IND_NIFTY_01_PMI_MFG` — India PMI Manufacturing

**How data accumulates:**  
Entered manually via the admin manual-input route. No automated fetch exists. Someone must POST the Jodo or S&P Global PMI print each month.

**Modes of filling:**  
- `manual` (only mode)

**Route linked to frontend:**  
```
POST /api/admin/manual-input
Body: { indicator_code: "IND_NIFTY_01_PMI_MFG", observation_date: "YYYY-MM-DD", value: <number>, notes?: string }
```
- `allow_overwrite: true` is required if re-submitting the same date with a revised value.

**Cron job:**  
None — fully manual.

**Scoring logic:**  
Rule type: `threshold_with_direction`  
- `+1` if value ≥ 50 **AND** value ≥ previous value (expansionary and improving)  
- `-1` if value < 50 (contractionary)  
- `0` otherwise  
The scoring engine carries-forward the last known score if data is missing.

**Log stored as:**  
No automated log entry. Manual entry writes a `data_point` row with `source = 'manual'` and a `fetch_log` row with `job_name = 'manual_input'` (written by `manual-input.service.ts`).

**Data point key:**  
`indicatorId` for `IND_NIFTY_01_PMI_MFG` in the `data_points` table.

**Special conditions:**  
- `previous_value` on the data point must be populated for the scoring direction test to work. The manual-input service reads the prior data point and sets `previous_value` automatically.

---

### Ind 2 — `IND_NIFTY_02_PMI_SVC` — India PMI Services

Identical structure to Ind 1. Monthly manual entry.

**Scoring logic:**  
- `+1` if value ≥ 50 AND value ≥ previous value  
- `-1` if value < 50  
- `0` otherwise  

All other properties same as Ind 1.

---

### Ind 3 — `IND_NIFTY_03_CPI` — India CPI YoY

**How data accumulates:**  
Fetched from FRED series `INDCPIALLMINMEI` (India Consumer Prices). The FRED service does smart catch-up: on the first run it backfills 2 years; on subsequent runs it pulls from (latest observation − 30 days) to capture revisions.

**Modes of filling:**  
1. `cron` — daily job runs at **02:30 UTC**  
2. `manual` — POST to `fetch-fred-indicator/run` with `indicator_code: "IND_NIFTY_03_CPI"`  
3. `backfill` — POST with explicit `date_from` / `date_to` to backfill a range

**Route linked to frontend:**  
```
POST /api/admin/fetch-fred-indicator/run
Body: { indicator_code: "IND_NIFTY_03_CPI", date_from?: "YYYY-MM-DD", date_to?: "YYYY-MM-DD" }

POST /api/admin/fetch-all-fred-indicators/run
Body: {}   ← fetches ALL FRED indicators at once
```

**Cron job:**  
`fred_daily_fetch` — **02:30 UTC daily** (08:00 IST).  
Orchestrator log name: `fred_daily_fetch`.  
Per-indicator log name: `fetch_fred_IND_NIFTY_03_CPI`.

**Scoring logic:**  
Rule type: `band`  
- `+1` if value ≤ 6% AND falling (India RBI target ceiling = 6%)  
- `-1` if value > 6% AND rising  
- `0` otherwise  
The engine checks the current data point's value and `previous_value` to determine direction.

**Log stored as:**  
- Orchestrator: `job_name = 'fred_daily_fetch'`  
- Per-indicator: `job_name = 'fetch_fred_IND_NIFTY_03_CPI'`

**Data point key:**  
FRED data points use `source = 'fred'`, `sourceMetadata.seriesId = 'INDCPIALLMINMEI'`.

**Special conditions:**  
FRED uses `"."` for missing values — those are skipped (not stored as `null`). If FRED has a publication lag this month, the scorer will carry forward the prior score.

---

### Ind 4 — `IND_NIFTY_04_RBI_RATE` — RBI Repo Rate Direction

**How data accumulates:**  
Manual only — someone enters the rate direction after each MPC meeting. Typical value: `+1` (cut), `-1` (hike), `0` (hold).

**Modes of filling:**  
- `manual` only

**Route linked to frontend:**  
```
POST /api/admin/manual-input
Body: { indicator_code: "IND_NIFTY_04_RBI_RATE", observation_date: "YYYY-MM-DD", value: <number> }
```
Convention: value = rate level in % (e.g. `6.25`). The scoring rule interprets direction from movement.

**Cron job:**  
None.

**Scoring logic:**  
Rule type: `rate_direction`  
- `+1` if cutting OR paused after hikes  
- `-1` if hiking  
- `0` otherwise (pause, steady)  
The handler compares current value to previous value to infer direction.

**Log stored as:**  
`job_name = 'manual_input'` in `data_fetch_log`.

**Special conditions:**  
Because this is event-driven (every 6–8 weeks), the carry-forward mechanism is important. If no new data exists for the observation date, the engine carries forward the last score indefinitely until a new MPC decision is entered.

---

### Ind 5 — `IND_NIFTY_05_IIP` — India Industrial Production

**How data accumulates:**  
FRED series `INDPROINDMISMEI`. Same smart catch-up logic as Ind 3. Monthly frequency with publication lag of ~6 weeks.

**Modes of filling:**  
1. `cron` — 02:30 UTC daily  
2. `manual` — via `fetch-fred-indicator/run`  
3. `backfill` — with explicit dates

**Scoring logic:**  
Rule type: `direction`  
- `+1` if value > 0 AND value ≥ previous value  
- `-1` if value < 0  
- `0` otherwise  

**Log stored as:**  
- Orchestrator: `job_name = 'fred_daily_fetch'`  
- Per-indicator: `job_name = 'fetch_fred_IND_NIFTY_05_IIP'`

**Special conditions:**  
Like all FRED monthly indicators, IIP has ~6-week publication lag. Score will carry forward from the last available print. Confirm data point exists within ~45 days for scoring to be based on real data.

---

### Ind 6 — `IND_NIFTY_06_FII_FLOW` — FII 10-day Rolling Cash Flow

**How data accumulates:**  
Scraped from NSE endpoint `/api/fiidiiTradeReact`. The service finds the row where `category` contains `"FII"` or `"FPI"`, parses `netValue` (INR crore), and stores it as-is. DII data is fetched in the same call (same NSE response).

**Modes of filling:**  
1. `cron` — **13:00 UTC daily** (18:30 IST)  
2. `manual` — POST to `scrape-nse-fii-dii/run` (no body required)

**Route linked to frontend:**  
```
POST /api/admin/scrape-nse-fii-dii/run
Body: {}
```

**Cron job:**  
`scrape_nse_fii_dii` — **13:00 UTC daily**.

**Scoring logic:**  
Rule type: `rolling_direction` (lookback: 10 days)  
- Computes a 10-day rolling average of net FII flow  
- `+1` if rolling avg > 0 AND improving (trend rising)  
- `-1` if rolling avg < 0 AND worsening  
- `0` otherwise  
The scoring handler reads the last 10 `isCurrent = true` data points for this indicator.

**Log stored as:**  
`job_name = 'scrape_nse_fii_dii'`

**Data point key:**  
`source = 'nse_scrape'`, `sourceMetadata.category` = raw NSE category string.

**Special conditions:**  
- NSE only publishes provisional data by ~18:00 IST on trading days. On holidays the response is empty (returns `NSE_FIIDII_EMPTY` error) — the cron will fail gracefully and the log will show `status = 'failed'`.
- FII and DII are persisted in the **same DB transaction** — both succeed or both fail together.

---

### Ind 7 — `IND_NIFTY_07_DII_ABSORPTION` — DII Absorption Ratio

**How data accumulates:**  
Derived in the same NSE FII/DII scrape call as Ind 6. Formula: `dii_net / abs(fii_net)`, where `dii_net` is NSE's own precomputed DII net (buy − sell). A data point is written **every** trading day:
- **FII net seller** → ratio = `dii_net / abs(fii_net)`; `sourceMetadata.fii_was_net_seller = true`. This is the scoreable case. `dii_net` may be negative (DII also net selling → "both fleeing"), which yields a negative ratio.
- **FII net buyer** → absorption = `0` (a real stored value, not null); `sourceMetadata.fii_was_net_seller = false`. Nothing to absorb when FII isn't selling, so neutral by definition. These 0-valued rows are for display/series-completeness ONLY.

**Modes of filling:**  
Same as Ind 6 (same job, same route). No separate trigger.

**Scoring logic:**  
Rule type: `rolling_ratio_excluding` (5-day rolling average, excluding FII-net-buyer days via `fii_was_net_seller`)  
- `+1` if rolling avg ≥ 0.75 (DII absorbing ≥75% of FII outflow)  
- `0` if 0 ≤ rolling avg < 0.75  
- `-2` if rolling avg < 0 (DII also net selling — "both fleeing"); handler emits flag `DII_NET_SELLER_REGIME`  
- `all_excluded_fallback`: score `0` + flag `FII_NET_BUYERS_REGIME` when all 5 window days were FII-net-buyer days  

The buyer-day 0-valued rows carry `fii_was_net_seller = false` and are **excluded** from the rolling average — they never move the score.

**Log stored as:**  
`job_name = 'scrape_nse_fii_dii'` (same row as Ind 6)

**Data point key:**  
`source = 'derived'`, `sourceMetadata.formula = 'dii_net / abs(fii_net)'`, plus `dii_net_crore`, `dii_buy_crore`, `dii_sell_crore`, `fii_sell_crore`, `fii_net_crore`, `fii_was_net_seller`.

**Special conditions:**  
A data point IS now written on FII-net-buyer days (value `0`), a change from the prior behavior where buyer days stored nothing. Existing historical rows written before this change keep OLD formulas and OLD metadata — they were not recomputed (no backfill). Two prior formula generations exist in history: the original `dii_buy / abs(fii_sell)` and an intermediate `dii_net / abs(fii_sell)`; the current formula is `dii_net / abs(fii_net)`. `sourceMetadata.formula` on each row identifies which formula produced it.

---

### Ind 8 — `IND_NIFTY_08_VIX` — India VIX

**How data accumulates:**  
Scraped from NSE `/api/allIndices`. The service scans the returned array for the row where `index === "INDIA VIX"` and extracts `last` as the current close. The observation date is parsed from the NSE timestamp (`"16-May-2026 15:30:00"` → `2026-05-16`).

**Modes of filling:**  
1. `cron` — **10:45 UTC daily** (16:15 IST, 45 min after NSE close)  
2. `manual` — POST to `scrape-nse-vix/run`

**Route linked to frontend:**  
```
POST /api/admin/scrape-nse-vix/run
Body: {}
```

**Cron job:**  
`scrape_nse_vix` — **10:45 UTC daily**.

**Scoring logic:**  
Rule type: `band`  
| Range | Score | Flag |
|-------|-------|------|
| VIX < 12 | `+1` | — |
| 12 ≤ VIX < 15 | `0` | — |
| 15 ≤ VIX < 20 | `-1` | — |
| VIX ≥ 20 | `-1` | `contrarian_watch` |

**Log stored as:**  
`job_name = 'scrape_nse_vix'`

**Data point key:**  
`source = 'nse_scrape'`, `sourceMetadata.index = 'INDIA VIX'`, `sourceMetadata.nseTimestamp`.

**Special conditions:**  
- If NSE doesn't include the INDIA VIX row (rare), the job fails with `NSE_VIX_ROW_MISSING`.
- VIX ≥ 20 still scores `-1` (not a contrarian buy signal in this system — the `contrarian_watch` flag is informational only for the frontend).

---

### Ind 9 — `IND_NIFTY_09_USD_WEAKNESS` — USD Weakness (NIFTY-facing)

**How data accumulates:**  
Written by the **Ind 9 Bridge** — a special job that reads the EdgeFinder USD asset scorecard's `base_fundamentals_score` (raw sum of the 14 US indicator scores, range −14 to +14) and stores it as a `data_point` for this indicator. This creates a bridge between EdgeFinder and NIFTY.

**Modes of filling:**  
1. `cron` — **23:50 UTC daily** (after EdgeFinder pair-score assembly at 23:45)  
2. `manual` — via cron-trigger route with `job_name: "nifty_ind9_bridge"`

**Route linked to frontend:**  
```
POST /api/admin/cron/run
Body: { job_name: "nifty_ind9_bridge" }
```

**Cron job:**  
`nifty_ind9_bridge` — **23:50 UTC daily**.

**Scoring logic:**  
Rule type: `manual_raw_composite`  
- `+1` or `+2` if raw sum ≤ −4 (USD very weak → bullish NIFTY)  
- `−1` or `−2` if raw sum ≥ +4 (USD very strong → bearish NIFTY)  
- `0` otherwise  
The actual band boundaries live in the scoring rule `ruleDefinition` stored in the `scoring_rules` DB table.

**Log stored as:**  
`job_name = 'nifty_ind9_bridge'`

**Data point key:**  
`source = 'derived'`, `sourceMetadata.usdScorecardDate`, `sourceMetadata.indicatorBreakdown` (contains all 14 USD sub-indicator scores), `sourceMetadata.bridgeVersion = 'v1'`.

**Special conditions:**  
- **Quality gate:** requires ≥ 12 of 14 USD sub-indicators to be present in the EdgeFinder scorecard. If fewer than 12 are available, the bridge logs `status = 'failed'` with `reason = 'insufficient_data'` and **no data point is written**.
- If EdgeFinder hasn't run yet today, the bridge reads yesterday's USD scorecard (`isStaleScorecard = true` in metadata) and logs a warning.
- No data = no EdgeFinder USD scorecard at all → `reason = 'no_usd_scorecard'`.

---

### Ind 10 — `IND_NIFTY_10_DXY` — DXY 10-day Direction

**How data accumulates:**  
FRED series `DTWEXBGS` (Broad Dollar Index / DXY equivalent). Daily data. Smart catch-up same as other FRED indicators.

**Modes of filling:**  
1. `cron` — 02:30 UTC daily  
2. `manual` / `backfill` via `fetch-fred-indicator/run`

**Scoring logic:**  
Rule type: `direction` (lookback: 10 days)  
- Computes 10-day % change vs the data point from 10 observations ago  
- `+1` if % change < 0 (DXY falling = USD weakening = bullish NIFTY)  
- `−1` if % change > 0 (DXY rising)  
- `0` if % change in neutral band [−0.3%, +0.3%]

**Log stored as:**  
`job_name = 'fetch_fred_IND_NIFTY_10_DXY'` (per-indicator), `fred_daily_fetch` (orchestrator)

---

### Ind 11 — `IND_NIFTY_11_BRENT` — Brent Crude 10-day Direction

**How data accumulates:**  
FRED series `DCOILBRENTEU` (Brent crude daily price).

**Modes of filling:**  
Same as Ind 10.

**Scoring logic:**  
Rule type: `direction` (lookback: 10 days)  
- `+1` if % change < 0 (falling oil = lower import bill = bullish India)  
- `−1` if % change > 0  
- `0` if % change in neutral band [−0.5%, +0.5%]

**Log stored as:**  
`job_name = 'fetch_fred_IND_NIFTY_11_BRENT'`

---

### Ind 12 — `IND_NIFTY_12_USDINR` — USD/INR 10-day Direction

**How data accumulates:**  
FRED series `DEXINUS` (USD/INR exchange rate, daily).

**Modes of filling:**  
Same as Ind 10.

**Scoring logic:**  
Rule type: `direction` (lookback: 10 days)  
- `+1` if % change < 0 (INR strengthening = bullish NIFTY)  
- `−1` if % change > 0  
- `0` if in neutral band [−0.3%, +0.3%]

**Log stored as:**  
`job_name = 'fetch_fred_IND_NIFTY_12_USDINR'`

---

### Ind 13 — `IND_NIFTY_13_FII_LS_RATIO` — FII Long/Short Ratio (Futures)

**How data accumulates:**  
Fetched from NSE Archives CSV files at `fao_participant_oi_{DDMMYYYY}.csv`. The CSV is parsed, the FII row is found, and the ratio `futureIndexLong / (futureIndexLong + futureIndexShort) * 100` is stored as `longPct`.

**Modes of filling:**  
1. `cron` — **14:00 UTC daily** (19:30 IST) — fetches today's CSV  
2. `manual` (single date) — POST to `scrape-nse-participant-oi/run` with optional `observation_date`

**Route linked to frontend:**  
```
POST /api/admin/scrape-nse-participant-oi/run
Body: {}                                 ← today
Body: { observation_date: "YYYY-MM-DD" } ← specific date (single-date mode)
```

**Cron job:**  
`scrape_nse_participant_oi` — **14:00 UTC daily**.

**Scoring logic:**  
Rule type: `threshold_with_direction`  
- `+1` if `long_pct > 50` OR rising  
- `−1` if `long_pct < 40` OR falling  
- `0` otherwise

**Log stored as:**  
`job_name = 'scrape_nse_participant_oi'`

**Data point key:**  
`source = 'nse_scrape'`, `sourceMetadata.formula = 'long / (long + short) * 100'`, `sourceMetadata.futureIndexLong`, `sourceMetadata.futureIndexShort`.

**Special conditions:**  
- If the CSV is not yet published (holiday/weekend/pre-publication), the NSE Archives server returns HTTP 404 → outcome = `no_data` (not a failure — logged with `rowsSkipped` +=1).
- The CSV's internal date is authoritative. If it differs from the requested date (NSE sometimes serves a previous-day file at a holiday URL), the internal date is used and a warning is logged.

---

## 1.3 NIFTY Cron Schedule (All Jobs)

| Job Name | Cron | UTC Time | IST Equiv. | What It Does |
|----------|------|----------|-----------|--------------|
| `fred_daily_fetch` | `30 2 * * *` | 02:30 | 08:00 | Fetches all FRED-sourced NIFTY indicators (Ind 3, 5, 10, 11, 12) |
| `scrape_nse_vix` | `45 10 * * *` | 10:45 | 16:15 | Scrapes India VIX (Ind 8) |
| `scrape_nse_fii_dii` | `0 13 * * *` | 13:00 | 18:30 | Scrapes FII/DII cash flows (Ind 6 & 7) |
| `scrape_nse_participant_oi` | `0 14 * * *` | 14:00 | 19:30 | Downloads FII L/S OI CSV (Ind 13) |
| `assemble_scorecard` | `30 14 * * *` | 14:30 | 20:00 | Assembles NIFTY scorecard for today |
| `nifty_ind9_bridge` | `50 23 * * *` | 23:50 | 05:20+1 | Reads EdgeFinder USD scorecard → writes Ind 9 |

> **Note:** Ind 9 bridge runs at 23:50 UTC (after EdgeFinder's pair-score assembly at 23:45). However, the main scorecard assembly runs at 14:30 UTC. This means **Ind 9 in the current day's scorecard uses yesterday's EdgeFinder data** unless manually re-run after 23:50 UTC.

---

## 1.4 NIFTY Scoring Assembly

**Service:** `scorecard-assembly.service.ts`  
**Log name:** `job_name = 'assemble_scorecard'`

### Score Pipeline

1. **Compute all indicator scores** via `computeAllScoresForDate()` → calls `scoreIndicator()` per indicator → handlers return `{score: -2..+2, kind, flags, metadata}`.
2. **Split into Domestic/External buckets** and sum separately.
3. **Net Score** = `domesticScore + externalScore` (range: −13 to +13 in theory; practical range ≈ −13 to +13).
4. **Band assignment** from `scorecard_rating_rules` table:
   - +7 to +13 → `Strong Bullish`
   - +3 to +6 → `Bullish`
   - −2 to +2 → `Neutral`
   - −6 to −3 → `Bearish`
   - −13 to −7 → `Strong Bearish`
5. **Conflict flag** fires when `externalScore ≤ −3` (external macro headwinds dominating regardless of domestic indicators).
6. **Ind 9 raw composite** is extracted from the score's `computationMetadata.rawComposite` and stored on the scorecard for sub-tool consumption.
7. Sub-tools computed and attached: Velocity, Peak Score Ceiling, Composition Flag.
8. Scorecard persisted as a vintage-aware row in `nifty_scorecards`. Identical results → `outcome = 'skipped'`.

### Carry-Forward Rule
If `scoreIndicator()` returns `insufficient_data` and a prior score exists in `scores`, it promotes to `carry_forward` (copies prior score, adds `CARRY_FORWARD` flag, records `daysStale`).

---

## 1.5 NIFTY Routes (Frontend-linked)

### Public Routes (no auth required)
```
GET  /api/nifty/scorecard/latest            → latest scorecard
GET  /api/nifty/scorecard/:date             → scorecard for YYYY-MM-DD
GET  /api/nifty/scorecard/history           → ?from=&to=&limit=&include_breakdown=true
GET  /api/nifty/indicators                  → list all indicators
GET  /api/nifty/indicators/:code            → indicator detail (?include_history=true)
GET  /api/nifty/velocity                    → ?start_date=&end_date= (sub-tool)
GET  /api/nifty/v-bottom-check              → ?date= (sub-tool)
GET  /api/nifty/indicators/:code/data-points → ?limit=20&include_historical_vintages=false
```

### Admin Routes (auth required, role = admin)
```
POST /api/admin/manual-input                → submit manual data point
GET  /api/admin/data-gaps                   → ?as_of=YYYY-MM-DD (staleness report)
POST /api/admin/scrape-nse-vix/run          → manual trigger: NSE VIX
POST /api/admin/scrape-nse-fii-dii/run      → manual trigger: FII/DII
POST /api/admin/scrape-nse-participant-oi/run → manual trigger: FII L/S OI
POST /api/admin/fetch-fred-indicator/run    → manual trigger: single FRED indicator
POST /api/admin/fetch-all-fred-indicators/run → manual trigger: all FRED indicators
POST /api/admin/scoring/compute/:code       → re-score single indicator
POST /api/admin/scoring/compute-all         → re-score all indicators for a date
POST /api/admin/cron/run                    → fire any job by name
```

---

## 1.6 Data Storage: Log Table & Data Points

### `data_fetch_log` table — NIFTY job names
| Job Name | What it logs |
|----------|-------------|
| `fred_daily_fetch` | Orchestrator row covering all FRED indicators |
| `fetch_fred_IND_NIFTY_03_CPI` | Per-indicator FRED fetch |
| `fetch_fred_IND_NIFTY_05_IIP` | Per-indicator FRED fetch |
| `fetch_fred_IND_NIFTY_10_DXY` | Per-indicator FRED fetch |
| `fetch_fred_IND_NIFTY_11_BRENT` | Per-indicator FRED fetch |
| `fetch_fred_IND_NIFTY_12_USDINR` | Per-indicator FRED fetch |
| `scrape_nse_vix` | India VIX scrape |
| `scrape_nse_fii_dii` | FII + DII cash flow scrape |
| `scrape_nse_participant_oi` | FII L/S OI CSV download |
| `nifty_ind9_bridge` | EdgeFinder → NIFTY Ind 9 bridge |
| `assemble_scorecard` | NIFTY scorecard assembly |
| `manual_input` | Manual data entry |

### `data_points` table — NIFTY data point sources
| Indicator Code | `source` value | Key `sourceMetadata` fields |
|---------------|---------------|--------------------------|
| `IND_NIFTY_01_PMI_MFG` | `manual` | — |
| `IND_NIFTY_02_PMI_SVC` | `manual` | — |
| `IND_NIFTY_03_CPI` | `fred` | `seriesId: 'INDCPIALLMINMEI'` |
| `IND_NIFTY_04_RBI_RATE` | `manual` | — |
| `IND_NIFTY_05_IIP` | `fred` | `seriesId: 'INDPROINDMISMEI'` |
| `IND_NIFTY_06_FII_FLOW` | `nse_scrape` | `endpoint: '/api/fiidiiTradeReact'` |
| `IND_NIFTY_07_DII_ABSORPTION` | `derived` | `formula: 'dii_net / abs(fii_net)'`, `dii_net_crore`, `dii_buy_crore`, `dii_sell_crore`, `fii_sell_crore`, `fii_net_crore`, `fii_was_net_seller` |
| `IND_NIFTY_08_VIX` | `nse_scrape` | `endpoint: '/api/allIndices'` |
| `IND_NIFTY_09_USD_WEAKNESS` | `derived` | `usdScorecardDate`, `indicatorBreakdown` |
| `IND_NIFTY_10_DXY` | `fred` | `seriesId: 'DTWEXBGS'` |
| `IND_NIFTY_11_BRENT` | `fred` | `seriesId: 'DCOILBRENTEU'` |
| `IND_NIFTY_12_USDINR` | `fred` | `seriesId: 'DEXINUS'` |
| `IND_NIFTY_13_FII_LS_RATIO` | `nse_scrape` | `formula: 'long / (long + short) * 100'` |
| `IND_NIFTY_14_DII_FLOW` | `nse_scrape` | `endpoint: '/api/fiidiiTradeReact'`, `dii_buy_crore`, `dii_sell_crore`, `dii_net_crore` |

---

---

# 2. EdgeFinder Module

The EdgeFinder module produces daily **asset scorecards** for 5 assets (USD, EUR, GBP, JPY, XAUUSD) and **pair scores** for 5 forex pairs (EURUSD, GBPUSD, USDJPY, EURJPY, GBPJPY). Each asset scorecard has three score components: `baseFundamentalsScore`, `cotScore`, and a `compassAdjustment` from the regime classifier.

---

## 2.1 EdgeFinder Indicator Universe

EdgeFinder indicators are split by country. All are sourced from **Forex Factory** (except `US_02Y_SMA` which uses FRED) and **CFTC** (for COT).

### US Indicators (14 fundamentals + 1 FRED + 1 COT)

| Code | Name | Group | Source |
|------|------|-------|--------|
| `US_GDP_QOQ` | US GDP Growth QoQ | Growth | Forex Factory |
| `US_ISM_MFG` | US ISM Manufacturing PMI | Growth | Forex Factory |
| `US_ISM_SVC` | US ISM Services PMI | Growth | Forex Factory |
| `US_RETAIL_MOM` | US Retail Sales MoM | Growth | Forex Factory |
| `US_CB_CONSCONF` | US Consumer Confidence (CB) | Sentiment | Forex Factory |
| `US_CPI_YOY` | US CPI YoY | Inflation | Forex Factory |
| `US_PPI_MOM` | US PPI MoM | Inflation | Forex Factory |
| `US_PCE_YOY` | US Core PCE YoY | Inflation | Forex Factory |
| `US_02Y_SMA` | US 2Y Yield 21-day SMA | Rates | **FRED** (`DGS2`) |
| `US_FED_RATE` | Fed Funds Rate Decision | Rates | Forex Factory |
| `US_NFP` | Non-Farm Payrolls | Jobs | Forex Factory |
| `US_UNEMP` | Unemployment Rate | Jobs | Forex Factory |
| `US_JOBLESS_CLAIMS` | Initial Jobless Claims | Jobs | Forex Factory |
| `US_ADP` | ADP Employment | Jobs | Forex Factory |
| `US_JOLTS` | JOLTS Job Openings | Jobs | Forex Factory |
| `USD_COT` | USD COT Score | COT | CFTC (contract `098662`) |

### EU Indicators (7 fundamentals + 1 COT)

| Code | Name | Group |
|------|------|-------|
| `EU_GDP_QOQ` | GDP QoQ | Growth |
| `EU_MFG_PMI` | Manufacturing PMI | Growth |
| `EU_SVC_PMI` | Services PMI | Growth |
| `EU_RETAIL_MOM` | Retail Sales MoM | Growth |
| `EU_CCI` | Consumer Confidence | Sentiment |
| `EU_CPI_YOY` | CPI YoY (HICP) | Inflation |
| `EU_PPI_MOM` | PPI MoM | Inflation |
| `EU_UNEMP` | Unemployment Rate | Jobs |
| `EU_ECB_RATE` | ECB Rate Decision | Rates |
| `EUR_COT` | EUR COT Score | COT (contract `099741`) |

### UK Indicators (7 fundamentals + 1 COT)

| Code | Name | Group |
|------|------|-------|
| `UK_GDP_MOM` | GDP MoM | Growth |
| `UK_MFG_PMI` | Manufacturing PMI | Growth |
| `UK_SVC_PMI` | Services PMI | Growth |
| `UK_RETAIL_MOM` | Retail Sales MoM | Growth |
| `UK_GFK` | Consumer Confidence (GfK) | Sentiment |
| `UK_CPI_YOY` | CPI YoY | Inflation |
| `UK_PPI_MOM` | PPI Output MoM | Inflation |
| `UK_UNEMP` | Unemployment Rate | Jobs |
| `UK_BOE_RATE` | BoE Rate Decision | Rates |
| `GBP_COT` | GBP COT Score | COT (contract `096742`) |

### JP Indicators (9 fundamentals + 1 COT)

| Code | Name | Group |
|------|------|-------|
| `JP_GDP_QOQ` | GDP QoQ | Growth |
| `JP_MFG_PMI` | Manufacturing PMI | Growth |
| `JP_SVC_PMI` | Services PMI | Growth |
| `JP_RETAIL_YOY` | Retail Sales YoY | Growth |
| `JP_CONSCONF` | Consumer Confidence | Sentiment |
| `JP_CPI_YOY` | CPI YoY | Inflation |
| `JP_PPI_YOY` | PPI YoY | Inflation |
| `JP_HSHLD_SPEND` | Household Spending YoY | Inflation |
| `JP_UNEMP` | Unemployment Rate | Jobs |
| `JP_BOJ_RATE` | BoJ Rate Decision | Rates |
| `JPY_COT` | JPY COT Score | COT (contract `097741`) |

### XAUUSD (Gold)
Uses **all US fundamental indicators** (same as USD) + score flip (negation of non-COT scores) + a separate COT indicator:
- `XAUUSD_COT` — Gold COT Score (contract `088691`)

---

## 2.2 How Data Accumulates for EdgeFinder Indicators

### 2.2.1 Forex Factory Indicators (all countries, all groups except `US_02Y_SMA` and COT)

**Job:** `forex_factory_weekly_fetch`  
**Mechanism:** The ForexFactory client fetches the current week's calendar JSON. Each event is matched to an indicator via `forex-factory-event-mapping.ts` (country + event title → indicator code). For each matched event:

- **Regular events** (GDP, PMI, CPI, etc.): `actual` is parsed and stored as `value`; `forecast` and `previous` stored as metadata.
- **Rate decisions** (`US_FED_RATE`, `EU_ECB_RATE`, etc.): `value` stored as **basis-point change** from prior rate level (e.g., −25 for a 25bp cut). The current rate level is looked up from the last `data_points` row.
- **Future events** (no `actual` yet): **skipped** — not stored.

**Modes:**  
1. `cron` — **03:30 UTC daily**  
2. `manual` — via `cron/run` with `job_name: "forex_factory_fetch"`

**Log stored as:** `job_name = 'forex_factory_weekly_fetch'`

**Data point key:**  
`source = 'forex_factory'`, `sourceMetadata.ffTitle`, `sourceMetadata.ffCountry`

### 2.2.2 US_02Y_SMA — 21-day SMA of US 2Y Yield

**Source:** FRED series `DGS2`  
**Transformation:** The raw 2Y yield observations are fetched with an extended lookback buffer (+30 days). The service computes the **21-day trailing SMA** and stores the SMA value (not the raw yield).  
**Modes:** Same as NIFTY FRED indicators (cron at 02:30 UTC, manual, backfill).  
**Log:** `job_name = 'fetch_fred_US_02Y_SMA'`  
**Scoring:** `us02y_sma` handler — checks if SMA is rising or falling within a flat band of ±1bp.

### 2.2.3 COT Indicators (USD_COT, EUR_COT, GBP_COT, JPY_COT, XAUUSD_COT)

**Source:** CFTC Legacy Futures-only report  
**Mechanism:** COT data is **not** stored in `data_points`. It is stored in the separate **`cot_data` table**. The COT indicators (`USD_COT` etc.) exist in the `indicators` table but serve as pointers for the scoring engine — the `cot_two_component` handler reads from `cot_data` directly (not `data_points`).  
**See Section 3.1 for full COT details.**

---

## 2.3 EdgeFinder Cron Schedule

| Job Name | Cron | UTC Time | What It Does |
|----------|------|----------|--------------|
| `forex_factory_weekly_fetch` | `30 3 * * *` | 03:30 | Fetches weekly FF calendar → stores data points for all FF indicators |
| `cftc_cot_weekly_fetch` | `0 22 * * 5` | Fri 22:00 | Fetches CFTC COT report (60 days back) for all 5 assets |
| `compass_inputs_daily_fetch` | `30 22 * * *` | 22:30 | Fetches all 6 Compass inputs (VIX, HY OAS, 2s10s, DXY, Gold/DXY, US Stack) |
| `compass_classifier_daily_run` | `0 23 * * *` | 23:00 | Classifies regime (Risk-On/Caution/Risk-Off) from today's inputs |
| `edgefinder_scorecard_assembly` | `30 23 * * *` | 23:30 | Assembles asset scorecards for USD, EUR, GBP, JPY, XAUUSD |
| `edgefinder_pair_score_assembly` | `45 23 * * *` | 23:45 | Assembles pair scores for EURUSD, GBPUSD, USDJPY, EURJPY, GBPJPY |

> **Full daily pipeline order (UTC):** FRED (02:30) → FF (03:30) → Compass Inputs (22:30) → Compass Classifier (23:00) → Asset Scorecard (23:30) → Pair Score (23:45) → NIFTY Ind9 Bridge (23:50)

---

## 2.4 EdgeFinder Scoring Logic

### Asset Scorecard Assembly
**Service:** `asset-scorecard.service.ts`  
**Assets:** USD, EUR, GBP, JPY, XAUUSD

**Pipeline:**
1. `resolveAssetIndicators(assetCode)` → looks up all `tool='edgefinder'`, `isActive=true` indicators for the asset's country codes. For XAUUSD, uses US country codes but sets `flipScoreForGold=true`.
2. Each indicator is scored via `scoreIndicator()` → scoring engine dispatches to the appropriate handler per `ruleType`.
3. **Gold score flip:** For XAUUSD non-COT indicators, the raw score is negated (`finalScore = -rawScore`). A USD bearish signal (e.g., weak NFP → −1 for USD) becomes **+1 for Gold**.
4. `baseFundamentalsScore` = sum of all non-COT scores (before Compass).
5. `cotScore` = COT indicator score (from `cot_two_component` handler).
6. **Compass regime** is fetched from `compass_classifications` (latest row on or before `observationDate`). Defaults to `Caution` if no classification exists.
7. **Risk-Off overrides** applied (see Section 3.3).
8. `fundamentalsScore` = `baseFundamentalsScore + compassAdjustment`
9. `totalScore` = `fundamentalsScore + cotScore`
10. Rating labels: ≥+4 `Very Support`, +3 `Support`, −2..+2 `Neutral`, −3 `Weak`, ≤−4 `Very Weak`.

### Scoring Rule Types (EdgeFinder)

| Rule Type | Used By | Logic |
|-----------|---------|-------|
| `normal` | GDP, PMI, CPI (US), Retail, etc. | `actual > forecast + tolerance` → +1; `actual < forecast - tolerance` → −1; else 0 |
| `inverted` | `US_UNEMP`, `EU_UNEMP`, `UK_UNEMP`, `JP_UNEMP`, `US_JOBLESS_CLAIMS` | Same as `normal` but score is negated (lower unemployment = better for currency) |
| `cpi_rate_cycle` | `EU_CPI_YOY`, `UK_CPI_YOY`, `JP_CPI_YOY` | Considers CPI relative to the current rate-cycle stance of the central bank |
| `rate_decision` | `US_FED_RATE`, `EU_ECB_RATE`, `UK_BOE_RATE`, `JP_BOJ_RATE` | bps change > 0 → +1 (hike); bps change < 0 → −1 (cut); 0 → 0 (hold) |
| `us02y_sma` | `US_02Y_SMA` | Checks if 21d SMA is rising/falling vs flat band of ±1bp |
| `cot_two_component` | `USD_COT`, `EUR_COT`, `GBP_COT`, `JPY_COT`, `XAUUSD_COT` | Net-positioning label + weekly-change label → combined score (see Section 3.1) |
| `carry_forward` | Any indicator with no fresh data | Copies prior score, adds `CARRY_FORWARD` flag |

---

## 2.5 Pair Score Logic

**Service:** `pair-score.service.ts` / `pair-row-calculator.ts`  
**Pairs:** EURUSD, GBPUSD, USDJPY, EURJPY, GBPJPY

### Pair Template (15 rows per pair, from DB `pair_template_rows`)
Each row = one economic concept. For a pair (base/quote):

```
pairScore = clamp(effectiveBaseScore - effectiveQuoteScore, -2, +2)
```

Where `effectiveScore = isInverted ? -rawScore : rawScore`.

### Pair Template Rows

| Row | UI Group | USD | EUR | GBP | JPY | Notes |
|-----|----------|-----|-----|-----|-----|-------|
| GDP | Growth | US_GDP_QOQ | EU_GDP_QOQ | UK_GDP_MOM | JP_GDP_QOQ | |
| Manufacturing PMI | Growth | US_ISM_MFG | EU_MFG_PMI | UK_MFG_PMI | JP_MFG_PMI | |
| Services PMI | Growth | US_ISM_SVC | EU_SVC_PMI | UK_SVC_PMI | JP_SVC_PMI | |
| Retail Sales | Growth | US_RETAIL_MOM | EU_RETAIL_MOM | UK_RETAIL_MOM | JP_RETAIL_YOY | |
| Consumer Confidence | Sentiment | US_CB_CONSCONF | EU_CCI | UK_GFK | JP_CONSCONF | |
| CPI | Inflation | US_CPI_YOY | EU_CPI_YOY | UK_CPI_YOY | JP_CPI_YOY | |
| PPI | Inflation | US_PPI_MOM | EU_PPI_MOM | UK_PPI_MOM | JP_PPI_YOY | |
| PCE | Inflation | US_PCE_YOY | — | — | — | USD-only; scores 0 in non-USD pairs |
| Household Spending | Inflation | — | — | — | JP_HSHLD_SPEND | JPY-only; excluded from non-JPY pairs |
| NFP / Employment | Jobs | US_NFP | — | — | — | USD-only |
| Unemployment | Jobs | US_UNEMP | EU_UNEMP | UK_UNEMP | JP_UNEMP | |
| Jobless Claims | Jobs | US_JOBLESS_CLAIMS | — | — | — | USD-only |
| JOLTS | Jobs | US_JOLTS | — | — | — | USD-only |
| ADP | Jobs | US_ADP | — | — | — | USD-only |
| Interest Rate | Rates | US_FED_RATE | EU_ECB_RATE | UK_BOE_RATE | JP_BOJ_RATE | |

**Total pair score** = sum of all 15 row scores (range varies per pair based on included rows).

---

## 2.6 EdgeFinder Log & Data Storage

### `data_fetch_log` — EdgeFinder job names
| Job Name | What it logs |
|----------|-------------|
| `forex_factory_weekly_fetch` | Weekly FF calendar fetch |
| `cftc_cot_weekly_fetch` | CFTC COT fetch |
| `compass_inputs_daily_fetch` | All 6 compass input ingestions |
| `compass_classifier_daily_run` | Regime classification |
| `edgefinder_scorecard_assembly` | Asset scorecard orchestrator |
| `edgefinder_pair_score_assembly` | Pair score orchestrator |

### `data_points` — EdgeFinder sources
| Indicator Type | `source` value |
|---------------|----------------|
| All Forex Factory indicators | `forex_factory` |
| `US_02Y_SMA` | `fred` (with `sourceMetadata.seriesId = 'DGS2'`) |
| COT indicators | **NOT in `data_points`** — stored in `cot_data` table |

### Other tables
| Table | Populated by |
|-------|-------------|
| `cot_data` | CFTC COT fetch (`cftc_cot_weekly_fetch`) |
| `compass_inputs` | Compass input jobs (6 rows per observation date) |
| `compass_classifications` | Compass classifier job (1 row per observation date) |
| `edgefinder_scorecards` | Asset scorecard assembly (1 row per asset per date) |
| `edgefinder_pair_scores` | Pair score assembly (1 row per pair per date) |

---

## 2.7 EdgeFinder Routes

### Admin Routes
```
POST /api/admin/cron/run
Body: { job_name: "forex_factory_fetch" | "cftc_cot_fetch" | "compass_inputs_fetch" |
                  "compass_classifier_run" | "scorecard_assembly" | "pair_score_assembly" }

POST /api/edgefinder/admin/manual
Body: { ... }  ← manual data entry for EdgeFinder indicators
```

---

---

# 3. Sub-Tools Deep Dive

---

## 3.1 COT (Commitment of Traders)

**Source:** CFTC Legacy Futures-only report via the public CFTC data API.

### Data Flow
1. **Fetch:** `cftcClient.fetchRecentLegacyData()` — pulls ~60 days of rows for the 5 tracked contract codes.
2. **Match:** Contract code from CFTC row → asset ID via `asset.metadata.cotContractCode`.

| Asset | Contract Code |
|-------|---------------|
| USD | 098662 |
| EUR | 099741 |
| GBP | 096742 |
| JPY | 097741 |
| XAUUSD | 088691 |

3. **Derive:** From `nonComm_long_all` and `nonComm_short_all`:
   - `longContracts`, `shortContracts`
   - `longPct = longContracts / (longContracts + shortContracts) * 100`
   - `weeklyChangePct` = change in longPct vs prior week
4. **Classify labels:**
   - `netPositioningLabel` from `longPct` thresholds (e.g., "Extremely Long", "Neutral")
   - `changeLabel` from `weeklyChangePct` (e.g., "Strong Buying", "Slight Selling")
5. **Store:** `cotDataRepository.upsert()` → `cot_data` table (NOT `data_points`).
   - Vintage-aware: `releaseDate` computed as the Friday following the `reportDate`.

### Storage Table: `cot_data`
Key columns: `assetId`, `contractCode`, `reportDate`, `releaseDate`, `traderCategory`, `longPct`, `shortPct`, `weeklyChangePct`, `netPositioningLabel`, `changeLabel`, `source = 'cftc'`, `rawPayload`.

### Scoring (`cot_two_component` handler)
The `cot_two_component` scoring rule reads the most recent `cot_data` row for the asset (on or before `observationDate`) and combines two components:
1. **Net positioning component** (from `netPositioningLabel`)
2. **Weekly change component** (from `changeLabel`)
Final COT score: typically −1, 0, or +1.

### Cron
`cftc_cot_weekly_fetch` — **Friday 22:00 UTC**. CFTC publishes ~19:30–20:30 UTC on Fridays; 22:00 UTC adds buffer for late publication and DST.

### Log stored as:
`job_name = 'cftc_cot_weekly_fetch'`

### Testing checklist for COT
1. `SELECT * FROM cot_data WHERE asset_id = (SELECT id FROM assets WHERE code = 'USD') ORDER BY report_date DESC LIMIT 5;`
2. Verify `longPct`, `weeklyChangePct`, `netPositioningLabel`, `changeLabel` are all non-null.
3. Verify `releaseDate` = report date + (days to next Friday). Reports are typically Tuesday date of the data week.
4. Check `data_fetch_log WHERE job_name = 'cftc_cot_weekly_fetch' ORDER BY started_at DESC LIMIT 3` — should show `status = 'success'` on recent Fridays.
5. `COT_TWO_COMPONENT` scoring: check `scores` table for `USD_COT`, `EUR_COT`, etc. on a recent date — `score` should be −1, 0, or +1.

---

## 3.2 Velocity (NIFTY Sub-Tool)

**Location:** `src/modules/nifty/services/sub-tools/velocity.ts`  
**API Route:** `GET /api/nifty/velocity?start_date=&end_date=`

### What it calculates
Velocity = rate of change of NIFTY scorecard net score per **scorecard session** (trading day with a scorecard).

```
velocity = (endNetScore - startNetScore) / sessions_between
```

### Auto-Anchors
The system auto-selects start/end anchors if not specified:
- **High anchor:** Most recent scorecard with `netScore ≥ 10` in trailing 120 sessions. If none, uses the session with `netScore = 9` if it's the 120-session high.
- **Low anchor:** Most recent scorecard with `netScore ≤ 0` in trailing 120 sessions.
- **Default start:** Whichever anchor is more recent.

### Velocity Labels
| Velocity | Label |
|----------|-------|
| ≤ −1.0 | Emergency Deterioration |
| −1.0 to −0.5 | Warning |
| −0.5 to −0.3 | Alert |
| −0.3 to −0.1 | Mild Deterioration |
| −0.1 to +0.1 | Flat |
| +0.1 to +0.3 | Slow Repair |
| +0.3 to +0.75 | Fast Repair |
| > +0.75 | Ceiling Recovery |

### Stored on scorecard
`nifty_scorecards.score_velocity_1d` = `velocity` value.

### Testing checklist
1. `GET /api/nifty/velocity` — should return `velocity`, `label`, `sessions`, `start_date`, `end_date`, `start_net`, `end_net`.
2. Verify `sessions` > 0 and `start_date` < `end_date`.
3. If `velocity = null`, check `reason` field — likely "No qualifying anchor found in trailing 120 sessions" (not enough scorecard history yet).
4. Manual override: pass `?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD` to pin specific anchor dates.

---

## 3.3 Compass (EdgeFinder Sub-Tool)

The Compass is a regime classifier that classifies the macro environment as **Risk-On**, **Caution**, or **Risk-Off** daily. It drives the `compassAdjustment` on EdgeFinder asset scorecards.

### 6 Compass Inputs (all daily, stored in `compass_inputs` table)

| Input Code | Description | Source | Raw Value | Derived Value | Weight |
|------------|-------------|--------|-----------|---------------|--------|
| `VIX_5D_AVG` | VIX 5-day average | EODHD (`VIX.INDX`) | Today's VIX close | 5-day moving average | 1.0 |
| `HY_OAS` | High-Yield OAS spread | FRED (`BAMLH0A0HYM2`) | Today's OAS level (%) | 30-day change | 1.5 |
| `YIELD_2S10S` | 2s10s yield curve | FRED (`T10Y2Y`) | Today's spread | 30-day change | 1.5 |
| `DXY_TREND` | DXY trend vs 50d SMA | EODHD (`DXY.INDX`) | Today's close | % distance from 50d SMA | 1.0 |
| `GOLD_DXY_CORR` | Gold/DXY 60-day correlation | EODHD (`XAUUSD.FOREX` + `DXY.INDX`) | Pearson correlation | Same (correlation) | 1.0 |
| `US_DATA_STACK` | Composite: CPI+GDP+Jobs | FRED (4 series) | null | null | 2.0 |

**Total weight = 8.0**

### Band Classification (per input)

| Input | GREEN | YELLOW | RED |
|-------|-------|--------|-----|
| VIX_5D_AVG | < 18 | 18–25 | > 25 |
| HY_OAS | < 4.5% AND tightening (30d chg < 0) | otherwise | > 7.0% |
| YIELD_2S10S | level > 0 AND steepening | otherwise | level < 0 AND re-steepening (30d chg > 0.1) |
| DXY_TREND | `|pctDistFrom50d| > 2%` (clear direction) | `|5d pct chg| ≤ 3%` AND `|dist| ≤ 2%` | `|5d pct chg| > 3%` (sharp break) |
| GOLD_DXY_CORR | correlation < −0.5 (normal inverse) | −0.5 to 0 | > 0 (broken correlation) |
| US_DATA_STACK | majority of 3 sub-bands = GREEN | mixed | majority = RED |

**US_DATA_STACK sub-bands:**
- CPI trajectory (last 3 YoY): rising→RED, falling→GREEN, mixed→YELLOW
- GDP level (last 2 QoQ %): both > 1.5→GREEN, any < 0→RED, else→YELLOW
- Jobs (Sahm rule + NFP): Sahm triggered→RED, avg NFP > 100k→GREEN, avg < 50k→RED

### Regime Classification
1. **Sum weighted votes** by color band.
2. **Crisis override:** VIX 5d avg > 30 **AND** HY OAS > 7.0 → force `Risk-Off` regardless of votes.
3. **Candidate regime:** Red ≥ 4 → Risk-Off; Green ≥ 5 AND Red ≤ 1 → Risk-On; otherwise → Caution.
4. **Persistence rule:** Active regime only flips after the candidate matches for **5 consecutive days** (prevents whipsawing). Crisis override fires same-day without persistence.

### Risk-Off Compass Overrides
Applied only when `activeRegime = 'Risk-Off'`:

| Override | Applies To | Logic |
|----------|-----------|-------|
| `OVERRIDE_1_BAD_NEWS_GOOD_NEWS` | SPY, NAS100 | Each weak US jobs score (−1) → +2 adjustment (bad macro news = good for equities in rate-cut hope) |
| `OVERRIDE_2_GOLD_INFLATION_HEDGE` | XAUUSD | CPI/PPI/PCE scores are re-flipped to their USD-direction sign (Gold also benefits from inflation when USD is weak) |
| `OVERRIDE_3_JPY_SAFE_HAVEN` | JPY | +1 flat boost (yen rallies in risk-off regardless of fundamentals) |
| `OVERRIDE_4_USD_WEAK_JOBS` | USD | Each weak US jobs score (−1) → +1 adjustment (bad jobs data can pause Fed hiking, softening USD weakness slightly) |

### Cron
1. `compass_inputs_daily_fetch` — **22:30 UTC**: ingests all 6 inputs.
2. `compass_classifier_daily_run` — **23:00 UTC**: classifies regime from those inputs.

### Storage
- Inputs: `compass_inputs` table (`observationDate`, `inputCode`, `rawValue`, `derivedValue`, `colorBand`, `subChecks`, `source`).
- Classifications: `compass_classifications` table (`classificationDate`, `candidateRegime`, `activeRegime`, `persistenceDaysCount`, `crisisOverrideFired`, `totalGreenWeight`, `totalYellowWeight`, `totalRedWeight`, `voteBreakdown`).

### Log stored as
- Inputs: `job_name = 'compass_inputs_daily_fetch'`
- Classifier: `job_name = 'compass_classifier_daily_run'`

### Testing checklist for Compass
1. Check `compass_inputs` for today: should have exactly 6 rows (one per input code). If < 6, classifier will skip with `status = 'skipped_no_inputs'`.
2. Check `compass_classifications` for today: verify `activeRegime`, `candidateRegime`, `persistenceDaysCount`.
3. If `crisisOverrideFired = true`, verify `VIX_5D_AVG derivedValue > 30` AND `HY_OAS rawValue > 7.0`.
4. Check `data_fetch_log WHERE job_name IN ('compass_inputs_daily_fetch', 'compass_classifier_daily_run')` for recent dates.
5. In EdgeFinder scorecards, `regimeAtCompute` should match `activeRegime` in `compass_classifications` for the same date.

---

## 3.4 V-Bottom Check (NIFTY Sub-Tool)

**Location:** `src/modules/nifty/services/sub-tools/v-bottom.ts`  
**API Route:** `GET /api/nifty/v-bottom-check?date=YYYY-MM-DD`

### What it does
At the trough of a NIFTY sell-off, this sub-tool classifies whether a V-bottom reversal is "real" or a "counter-trend bounce" based on Ind 9 raw composite at the trough date.

### Classification
- `ind9Raw ≤ 0` → **REAL V-BOTTOM** — "USD regime broken. Recovery sustains."
- `ind9Raw 1–4` → **AMBIGUOUS** — "USD neutral. Watch — needs External flip confirmation."
- `ind9Raw ≥ 5` → **COUNTER_TREND_BOUNCE** — "USD regime intact. Bounce will fail."

### Historical examples embedded
The sub-tool includes 5 hardcoded historical examples (Apr 7 2025, Jun 13 2025, Mar 4 2025, Dec 16 2024, Feb 10 2025) with outcomes as validation anchors.

### Testing checklist
1. `GET /api/nifty/v-bottom-check?date=2025-04-07` — should return `classification = 'REAL_V_BOTTOM'` (ind9Raw = −8).
2. Verify `ind9Raw` matches the `data_points.value` for `IND_NIFTY_09_USD_WEAKNESS` on that date.
3. If `ind9Raw = null`, Ind 9 data is missing for that date — check the bridge job logs.

---

## 3.5 Peak Score Ceiling (NIFTY Sub-Tool)

**Location:** `src/modules/nifty/services/sub-tools/peak-score-ceiling.ts`  
**Stored on scorecard:** `nifty_scorecards.peak_score_ceiling_state` (JSON column)

### What it does
Tracks whether the NIFTY scorecard is in a "peak regime" — a period after reaching an unusually high net score, during which decay rate is monitored.

### Entry Conditions
- `netScore ≥ 10` → enters unconditionally
- `netScore = 9` AND is the 120-session high → enters with reason `plus_9_120d_high`

### State Machine
| State | Transitions |
|-------|------------|
| `inactive` | → `active` when entry condition met |
| `active` | → `pendingDeactivation` when netScore falls below threshold; → restarts if re-qualifies with higher peak |
| `pendingDeactivation` | → `inactive` after 5 consecutive sessions below threshold; → back to `active` if re-qualifies |

### Decay tracking
`decayPerDay = (currentNetScore - peakNetScore) / sessionsSincePeak`

| Decay Rate | Tier |
|------------|------|
| > −0.2 | PASSIVE |
| −0.2 to −0.5 | ACTIVE |
| < −0.5 | SHARP |

### Testing checklist
1. Check `nifty_scorecards.peak_score_ceiling_state` JSON for recent scorecards.
2. If `status = 'active'`, verify `peakDate`, `peakNetScore`, `decayPerDay`, `decayTier`.
3. Confirm `peakNetScore ≥ 9` and `peakDate` is in the last 120 sessions.

---

## 3.6 Composition Flag (NIFTY Sub-Tool)

**Location:** `src/modules/nifty/services/sub-tools/composition-flag.ts`  
**Stored on scorecard:** `nifty_scorecards.composition_flag`

### What it does
When Ind 9 raw composite is strongly negative (USD very weak, ≤ −4) or strongly positive (USD very strong, ≥ +4), this sub-tool classifies the **source of the USD move** into one of several flags.

### Activation Threshold
`|ind9Raw| ≥ 4`

### USD Weakness Flags (`ind9Raw ≤ −4`)
Uses EdgeFinder USD sub-indicator scores (from `getUsdSubIndicatorScoresForDate()`):
- **DEMAND_DESTRUCTION:** Growth+Labor negative count ≥ 6 AND Inflation negative count ≤ 1
- **INFLATION_LED:** Inflation negative count ≥ 2
- **MIXED:** neither above condition met

### USD Strength Flags (`ind9Raw ≥ +4`)
Mirror flags:
- **DEMAND_REACCEL:** Growth+Labor positive count ≥ 6 AND Inflation positive count ≤ 1
- **INFLATION_HOT:** Inflation positive count ≥ 2
- **MIXED:** otherwise

### Indicator Clusters
- **Inflation:** `US_CPI_YOY`, `US_PPI_YOY`, `US_PCE_YOY`
- **Growth:** `US_GDP_QOQ`, `US_ISM_MFG`, `US_ISM_SVC`, `US_RETAIL_MOM`
- **Labor:** `US_NFP`, `US_UNEMP`, `US_JOBLESS_CLAIMS`, `US_ADP`, `US_JOLTS`

### Testing checklist
1. Check `nifty_scorecards.composition_flag` for a date when Ind 9 raw ≤ −4.
2. If `composition_flag = null`, check: Ind 9 raw is between −3 and +3 (not in activation range) OR EdgeFinder sub-indicator scores unavailable.
3. Verify `nifty_scorecards.ind9_raw_composite` matches `data_points.value` for `IND_NIFTY_09_USD_WEAKNESS` on that date.

---

## 3.7 Pair Scores (EdgeFinder Sub-Tool)

**Service:** `pair-score.service.ts`, `pair-row-calculator.ts`  
**Stored in:** `edgefinder_pair_scores` table

### How it works
For each of the 5 pairs (EURUSD, GBPUSD, USDJPY, EURJPY, GBPJPY):
1. Load pair template rows from `pair_template_rows` DB table (15 rows, ordered by `rowOrder`).
2. For each row, look up the latest scored value for the base and quote indicators.
3. Compute `pairScore = clamp(effectiveBase - effectiveQuote, -2, +2)`.
4. Sum all row scores → `totalPairScore`.
5. Apply pair-level Compass overrides if `activeRegime = 'Risk-Off'` (from `pair-compass-overrides.ts`).

### Pair-Compass Overrides
Additional overrides beyond the per-asset overrides, specific to pair combinations (e.g., USDJPY in Risk-Off has special JPY safe-haven boost applied at the pair level).

### Storage
`edgefinder_pair_scores` table: `pairAssetId`, `scoreDate`, `totalPairScore`, `regime`, `rowBreakdown` (JSON), `isCurrent`.

### Testing checklist
1. Check `edgefinder_pair_scores WHERE pair_asset_id = (SELECT id FROM assets WHERE code = 'EURUSD') ORDER BY score_date DESC LIMIT 3`.
2. Verify `totalPairScore`, `regime`, `rowBreakdown` JSON.
3. Each row in `rowBreakdown` should have `indicatorA`, `indicatorB`, `pairScore`, `rowIncluded`.
4. For USDJPY/EURJPY/GBPJPY: verify `Household Spending` row has `rowIncluded = false` (only in JPY pairs, and only included when JPY is in the pair — actually it IS included in JPY pairs; the Household Spending hard-exclude only fires in non-JPY pairs).
5. Check that `USD-only` rows (NFP, PCE, JOLTS, ADP, Jobless Claims) score 0 in EURJPY and GBPJPY pairs (both sides absent).

---

## 3.8 Manual Data Entry

### NIFTY Manual Input
```
POST /api/admin/manual-input
Body: {
  indicator_code: "IND_NIFTY_01_PMI_MFG",
  observation_date: "YYYY-MM-DD",
  value: 55.2,
  notes: "optional",
  allow_overwrite: false,
  source_metadata: {}
}
```
- `allow_overwrite: false` (default) — rejects if a data point already exists for that date.
- `allow_overwrite: true` — marks existing point `isCurrent = false`, creates new vintage.
- Auth required: admin role.

### EdgeFinder Manual Data Entry
```
POST /api/edgefinder/admin/manual
```
Handled by `manual-data-entry.handler.ts` via `manual-data-entry.service.ts`.

---

## 3.9 Data Gaps Report

**Route:** `GET /api/admin/data-gaps?as_of=YYYY-MM-DD`

Shows which NIFTY indicators have stale data, classified by severity:
- `fresh` — within expected publication window
- `warning` — slightly overdue
- `critical` — significantly overdue
- `never` — no data ever entered

Use this to identify which manual indicators need attention.

---

## 4. Testing & Verification Checklist

### Quick DB Checks

```sql
-- 1. Latest NIFTY scorecard
SELECT observation_date, net_score, band, conflict_flag, composition_flag
FROM nifty_scorecards WHERE is_current = true ORDER BY observation_date DESC LIMIT 5;

-- 2. Check all NIFTY indicator data points for today
SELECT i.code, dp.observation_date, dp.value, dp.source, dp.is_current
FROM data_points dp
JOIN indicators i ON i.id = dp.indicator_id
WHERE i.tool = 'nifty' AND dp.is_current = true
ORDER BY i.display_order;

-- 3. Check recent fetch logs
SELECT job_name, status, rows_inserted, rows_updated, rows_skipped, started_at
FROM data_fetch_log ORDER BY started_at DESC LIMIT 20;

-- 4. EdgeFinder asset scorecards
SELECT a.code, es.observation_date, es.base_fundamentals_score, es.cot_score,
       es.compass_adjustment, es.total_score, es.rating_label, es.regime_at_compute
FROM edgefinder_scorecards es
JOIN assets a ON a.id = es.asset_id
WHERE es.is_current = true ORDER BY es.observation_date DESC, a.code;

-- 5. Compass inputs for today
SELECT input_code, raw_value, derived_value, color_band, source
FROM compass_inputs WHERE observation_date = CURRENT_DATE AND is_validation = false;

-- 6. Compass classification
SELECT classification_date, candidate_regime, active_regime, persistence_days_count, crisis_override_fired
FROM compass_classifications WHERE is_validation = false ORDER BY classification_date DESC LIMIT 5;

-- 7. COT data
SELECT a.code, cd.report_date, cd.long_pct, cd.weekly_change_pct, cd.net_positioning_label, cd.change_label
FROM cot_data cd JOIN assets a ON a.id = cd.asset_id
ORDER BY cd.report_date DESC, a.code;

-- 8. Pair scores
SELECT a.code, eps.score_date, eps.total_pair_score, eps.regime
FROM edgefinder_pair_scores eps
JOIN assets a ON a.id = eps.pair_asset_id
WHERE eps.is_current = true ORDER BY eps.score_date DESC, a.code;
```

### Common Issues & What to Check

| Symptom | Likely Cause | Check |
|---------|-------------|-------|
| Ind 9 missing from NIFTY scorecard | Ind9 bridge didn't run or EdgeFinder USD scorecard absent | `data_fetch_log` for `nifty_ind9_bridge`; `edgefinder_scorecards` for USD on that date |
| NIFTY scorecard has many `carry_forward` | Data not fetching (FRED/NSE down or holiday) | `data_fetch_log` for relevant job; check for `status = 'failed'` |
| Ind 7 (DII Absorption) scored 0 today | FII was net buyer today | Ind 7 now stores `0` on FII-buyer days (`sourceMetadata.fii_was_net_seller = false`); those rows are excluded from the rolling average, so score reflects prior seller days |
| COT score unchanged for weeks | CFTC fetch only runs Fridays; data should update weekly | Check `cot_data` for latest `report_date`; should be within past 10 days |
| Compass shows `skipped_no_inputs` | Not all 6 inputs were ingested (market holiday or API failure) | Check `compass_inputs` for the date — count rows; missing ones indicate which service failed |
| EdgeFinder scorecard `regime = 'Caution'` even when expected Risk-Off | Compass classifier: persistence rule needs 5 consecutive days | Check `persistence_days_count` in `compass_classifications` |
| Pair score row `pairScore = 0` for PCE in EURJPY | Expected — PCE is USD-only and both EUR and JPY sides are absent | This is correct behavior per spec |
| VIX ≥ 20 scores −1, frontend shows flag | `contrarian_watch` flag is informational; score is still −1 | Expected behavior |
