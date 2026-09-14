# Manual Data Collection — what you need to gather

> **Status 2026-09-14 — superseded in part.** The prints were collected by a parallel session from
> **Trading Economics**, not ForexFactory (FF supplies release dates only), into
> `scripts/data/manual-backfill/*.csv` with a per-row `status` column. "Forecast" below means TE's
> market **consensus** (the CSV `consensus` column), never TE's own forecast — except where TE states
> no consensus, when its forecast is used. Several series differ from what their codes suggest:
> `US_CB_CONSCONF` is Michigan sentiment; all CPI is headline YoY; all PPI is YoY despite the `_MOM`
> codes; all retail sales is MoM despite `JP_RETAIL_YOY`. The indicator lists, the release-date rule
> (§1.1) and the lead-in ranges (§2) still apply; §7's ForexFactory paste workflow does not.

Companion to [DATABASE_RECOVERY_PLAN.md](./DATABASE_RECOVERY_PLAN.md), Stage 5.

This is the only part of the recovery that cannot be automated. Everything listed here comes from
ForexFactory's calendar, whose feed is current-week-only — last week's file 404s, so no amount of code
can fetch it back. You read it off the website; I load it.

---

## 1. Three rules that decide whether this works

### 1.1 The date is the RELEASE date, not the reference period

`DataPoint.observationDate` is set by `parseForexFactoryDate()`, which takes the calendar event's own
date and truncates it to a UTC date. So:

> US CPI **for August**, published on **11 September** → `observation_date = 2026-09-11`

Not `2026-08-31`, not `2026-08-01`. Record the date the number came out, exactly as ForexFactory
lists it. If this is wrong, every score lands on the wrong day and nothing downstream verifies.

### 1.2 Forecast is mandatory, not optional

I said earlier that forecast was "optional but improves fidelity." Reading the handlers, that was
wrong, and the correction matters for what you collect.

Almost every Oracle indicator scores the **surprise against forecast**, not the level:

```
surprise = actual − forecast        (normal.handler.ts)
  surprise >  0.05  →  +1  BEAT
  surprise < −0.05  →  −1  MISS
  otherwise         →   0  MET
```

- If forecast is missing, the handler falls back to `previous` and flags `USED_PREVIOUS_AS_BASELINE`.
  That scores a **different number** than the original did, and Stage 7's 22-snapshot check will fail.
- For the five central-bank rate decisions, there is no fallback at all. `rate-decision.handler.ts`
  returns `insufficient_data` with the comment "never a fabricated" score when forecast is null.

**So: actual AND forecast for every row.** Previous as well where you can get it — it's required for
rate decisions (to classify hike/cut/hold) and for the NIFTY PMI and IIP rules.

### 1.3 Collect every release in the window, not one per indicator

A score changes the day a new print lands and holds until the next one. To rebuild a continuous
history, every release inside the window is needed, plus the one immediately before the window starts
(otherwise the first weeks score as `insufficient_data`).

---

## 2. Date ranges

Window being rebuilt: **2026-05-26 → 2026-09-13**.

| Indicator type | Collect from | Why |
|---|---|---|
| Monthly (all tools) | **2026-04-01** | Catches the release active at window start |
| Weekly (US jobless claims) | **2026-05-01** | Short lead-in is enough |
| Quarterly (GDP, AU PPI) | **2026-02-01** | The release active at window start may be from April |
| Central-bank rate decisions | **2026-03-01** | Needs the prior decision to classify the current one |
| **NIFTY CPI only** | **2026-01-01** | `two_component_cpi` compares against a 3-month average — needs 4 monthly prints of lead-in |

Everything runs through **2026-09-13** (or the day we execute).

---

## 3. Oracle — 55 indicators

All from the ForexFactory calendar. Columns needed: **date, actual, forecast, previous**.

### 3.1 United States — 14

| Code | Release | Freq |
|---|---|---|
| `US_ISM_MFG` | ISM Manufacturing PMI | monthly |
| `US_ISM_SVC` | ISM Services PMI | monthly |
| `US_RETAIL_MOM` | Retail Sales MoM | monthly |
| `US_CB_CONSCONF` | CB Consumer Confidence | monthly |
| `US_CPI_YOY` | CPI YoY (headline) | monthly |
| `US_PPI_MOM` | PPI MoM (headline) | monthly |
| `US_PCE_YOY` | Core PCE YoY | monthly |
| `US_NFP` | Non-Farm Payrolls | monthly |
| `US_UNEMP` | Unemployment Rate | monthly |
| `US_ADP` | ADP Employment Change | monthly |
| `US_JOLTS` | JOLTS Job Openings | monthly |
| `US_JOBLESS_CLAIMS` | Initial Jobless Claims | **weekly** |
| `US_GDP_QOQ` | GDP Growth QoQ | quarterly |
| `US_FED_RATE` | Fed Funds Rate Decision | event-driven |

### 3.2 Eurozone — 9

| Code | Release | Freq |
|---|---|---|
| `EU_MFG_PMI` | HCOB Manufacturing PMI | monthly |
| `EU_SVC_PMI` | HCOB Services PMI | monthly |
| `EU_RETAIL_MOM` | Retail Sales MoM | monthly |
| `EU_CCI` | Consumer Confidence (EC) | monthly |
| `EU_CPI_YOY` | CPI YoY (HICP headline) | monthly |
| `EU_PPI_MOM` | PPI MoM | monthly |
| `EU_UNEMP` | Unemployment Rate | monthly |
| `EU_GDP_QOQ` | GDP Growth QoQ | quarterly |
| `EU_ECB_RATE` | ECB Main Refinancing Rate | event-driven |

### 3.3 United Kingdom — 9

| Code | Release | Freq |
|---|---|---|
| `UK_GDP_MOM` | GDP Growth MoM | monthly |
| `UK_MFG_PMI` | S&P/CIPS Manufacturing PMI | monthly |
| `UK_SVC_PMI` | S&P/CIPS Services PMI | monthly |
| `UK_RETAIL_MOM` | Retail Sales MoM | monthly |
| `UK_GFK` | GfK Consumer Confidence | monthly |
| `UK_CPI_YOY` | CPI YoY | monthly |
| `UK_PPI_MOM` | PPI Output MoM | monthly |
| `UK_UNEMP` | Unemployment Rate | monthly |
| `UK_BOE_RATE` | BoE Bank Rate | event-driven |

### 3.4 Japan — 12

| Code | Release | Freq |
|---|---|---|
| `JP_MFG_PMI` | Jibun Bank Manufacturing PMI | monthly |
| `JP_SVC_PMI` | Jibun Bank Services PMI | monthly |
| `JP_RETAIL_YOY` | Retail Sales YoY | monthly |
| `JP_CONSCONF` | Consumer Confidence | monthly |
| `JP_CPI_YOY` | National CPI YoY | monthly |
| `JP_PPI_YOY` | PPI YoY (CGPI) | monthly |
| `JP_HSHLD_SPEND` | Household Spending YoY | monthly |
| `JP_UNEMP` | Unemployment Rate | monthly |
| `JP_CASH_EARNINGS_YOY` | Labor Cash Earnings YoY | monthly |
| `JP_TOKYO_CPI_YOY` | Tokyo Core CPI YoY | monthly |
| `JP_GDP_QOQ` | GDP Growth QoQ | quarterly |
| `JP_BOJ_RATE` | BoJ Policy Rate | event-driven |

### 3.5 Australia — 10

| Code | Release | Freq |
|---|---|---|
| `AU_PMI_MFG` | Judo Bank Manufacturing PMI | monthly |
| `AU_PMI_SVC` | Judo Bank Services PMI | monthly |
| `AU_MHSI_MOM` | Household Spending MoM | monthly |
| `AU_CONSCONF` | Westpac Consumer Confidence | monthly |
| `AU_CPI_YOY` | CPI YoY | monthly |
| `AU_UNEMPLOYMENT` | Unemployment Rate | monthly |
| `AU_EMPLOYMENT_CHANGE` | Employment Change | monthly |
| `AU_GDP_QOQ` | GDP Growth QoQ | quarterly |
| `AU_PPI_YOY` | PPI YoY | quarterly |
| `AU_RBA_RATE` | RBA Cash Rate | event-driven |

### 3.6 China — 1

| Code | Release | Freq |
|---|---|---|
| `CN_CAIXIN_PMI_MFG` | RatingDog/Caixin China Manufacturing PMI | monthly |

*(Feeds AUD as an industrial-demand proxy.)*

### 3.7 Release variants

A few indicators publish more than once for the same period (GDP Advance/Second/Third, PMI
Flash/Final). The database stores them as separate rows on the same date, ranked by an ordinal. If
ForexFactory shows two prints for one period, **record both** and note which is which — the loader
resolves them against `indicator_variants`.

---

## 4. NIFTY — 4 indicators

| Code | Release | Freq | Collect from | Notes |
|---|---|---|---|---|
| `IND_NIFTY_01_PMI_MFG` | India PMI Manufacturing | monthly | 2026-04-01 | Rule needs **previous** |
| `IND_NIFTY_02_PMI_SVC` | India PMI Services | monthly | 2026-04-01 | Rule needs **previous** |
| `IND_NIFTY_03_CPI` | India CPI YoY % | monthly | **2026-01-01** | 3-month-average trajectory — needs **four prints of lead-in** |
| `IND_NIFTY_05_IIP` | India IIP YoY % | monthly | 2026-04-01 | Rule needs **previous** |
| `IND_NIFTY_04_RBI_RATE` | RBI Repo Rate decision | event-driven | 2026-03-01 | Needs **actual level + expected level + prior level** |

**India CPI — confirmed manual (2026-09-13).** It is seeded as FRED `INDCPIALLMINMEI`, but it was
hand-filled in production; the source switch never made it into the repo. Stage 2 sets
`IND_NIFTY_03_CPI.data_source = 'manual'` explicitly, and `assert-config.ts` checks it.

---

## 5. Judgment inputs — 6 values, and these are easy to overlook

Five Oracle CPI indicators don't score on the surprise alone. `cpi_rate_cycle.handler.ts` reads the
currency's **cycle stance** and looks the score up in a matrix — a hot CPI means something different
in a cutting cycle than in a hiking one. Stances are effective-dated. The seed writes them at
**2026-01-01**, so any change you made during 2026 is lost.

The seeded values, for you to confirm or correct:

| Currency | Seeded stance | Note in the seed |
|---|---|---|
| USD | `NEUTRAL` | Fed data-dependent |
| EUR | `CUTTING` | ECB cutting through 2025–26 |
| GBP | `CUTTING` | BoE cutting |
| JPY | `HIKING` | BoJ slow hiking |
| AUD | `NEUTRAL` | **marked PLACEHOLDER in the seed** — "must be set before AUD scores are trusted" |

What I need from you:

1. Was each stance correct for the whole window 2026-05-26 → today? If any changed, give the new
   stance and the date it took effect.
2. The **real AUD/RBA stance** — the seed value is an explicit placeholder, not a judgment.
3. The **Fed constraint** flag (`FREE` or `CONSTRAINED`), stored on the USD row. It gates the gold
   override. Defaults to `FREE` if absent, which restores classic behaviour — tell me if it was
   `CONSTRAINED` at any point.

Valid stances: `HIKING`, `CUTTING`, `NEUTRAL`.

---

## 6. What you do NOT need to collect

Don't spend time on any of these — they re-fetch:

- **COT** — all 9 (USD, EUR, GBP, JPY, AUD, XAUUSD, SPY, NAS100, US30). CFTC's API serves full
  history. One code fix needed on our side (a hardcoded 100-row limit).
- **US 2Y yield** — FRED.
- **DXY, USDINR, NIFTY close** — EODHD. **Brent** — Yahoo.
- **FII/DII cash flows, NSE VIX, participant OI** — NSE archives.
- **Compass inputs** — VIX, HY OAS, real yields, USDJPY, DXY trend, the US data stack. All automated,
  with a replay harness already built.
- **Everything in the trading journal** — restored from the dump.

---

## 7. How to hand it over

### Preferred: paste the ForexFactory week view

Rather than typing ~350 rows into a spreadsheet, open ForexFactory's calendar one week at a time,
select the table, and paste it. Each paste covers every currency and every indicator for that week —
roughly **16 pastes** for the whole window.

I'll write a parser that maps each row to an indicator code, ignores everything not in the registry
(FF publishes far more events than we track), and produces a dry-run report for you to review before
anything is written. Turning 16 pastes into a clean dataset is a much better use of your time than
manual transcription.

Filter FF to the currencies we track — USD, EUR, GBP, JPY, AUD, CNY — and set the timezone before
copying. Any consistent timezone works as long as it doesn't shift a release across midnight; the
loader truncates to a UTC date.

### Fallback: CSV

If you'd rather fill a sheet, I'll generate a template with one row per expected release, pre-filled
with indicator code and a blank date. Format:

```csv
indicator_code,observation_date,actual,forecast,previous,variant,notes
US_CPI_YOY,2026-09-11,2.9,3.0,2.7,,
US_GDP_QOQ,2026-07-30,2.1,2.3,0.5,Advance,
```

`variant` is blank for single-release indicators.

---

## 8. Volume, honestly

| Group | Rough count |
|---|---|
| Oracle monthly (44 indicators × ~6 releases) | ~260 |
| Oracle weekly (jobless claims) | ~24 |
| Oracle quarterly (5 × 2–3) | ~13 |
| Central-bank decisions (5 banks × ~4 meetings) | ~18 |
| NIFTY (4–5 indicators) | ~30 |
| Judgment inputs | 6 |
| **Total** | **~350 values** |

This is larger than the 150–170 I estimated before working through the handlers. Two things drove it
up: the window starts 2026-05-26 rather than mid-June (to cover all 22 verification snapshots), and
forecast turned out to be required rather than optional, so each row carries three numbers.

Via the paste route it's roughly 16 weekly copies — realistically an evening's work, not a week's.

### If you want it smaller

Moving `W_start` to **2026-07-30** cuts the collection to about half. The cost: only 12 of the 22
Oracle snapshots fall inside the window, so the verification gate gets materially weaker, and you get
six weeks of history instead of sixteen.

My recommendation is to keep 2026-05-26. The snapshots are the only independent evidence of what the
old system produced, and once they're spent there's no second way to prove the rebuild is right.

---

## 9. Start here

You don't need to wait for me. In priority order:

1. **The 6 judgment inputs** (§5) — two minutes, and they block 5 CPI indicators.
2. **US** (§3.1) — the most indicators, and it feeds USD, which sits on one side of most of your pairs.
3. **EU and UK** (§3.2, §3.3) — EURUSD and GBPUSD carry 17 of the 22 verification snapshots.
4. **JP, AU, CN** (§3.4–3.6).
5. **NIFTY** (§4).

While you collect, I'll be running Stages 0–3 — freeze, schema, config, journal restore — none of
which depend on this data. Your journal should be back and usable before you finish the collection.
