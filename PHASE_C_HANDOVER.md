# Compass Phase C — Handover

Two-layer rebuild. Completed 2026-09-09. Config version **v3**.

Source of truth for the research this builds on: `research/phase-b/FINDINGS.md`.
System documentation: `SYSTEM_REFERENCE.md` §3.3 (rewritten — it previously
documented the retired v1 as if it were current).

---

## 1. What shipped

**The trading-calendar gate.** `runCompassClassifier` now refuses to write on a
non-trading day, using a rule-derived NYSE/SIFMA calendar
(`src/core/utils/us-market-calendar.ts`). The holidays are computed — n-th weekday,
fixed date with the Saturday/Sunday observation rule, Good Friday via the computus —
so the calendar is correct back to 1962 rather than being a maintained list. The
only enumerated entries are unscheduled closures no rule can derive (9/11, Sandy,
four national days of mourning). 30 unit tests.

**Live series archived and restarted clean.** 104 classification rows and 785 input
rows moved to `compass_classifications_archive` / `compass_inputs_archive`, still
queryable. See §5. EdgeFinder scorecards untouched.

**Schema.** `config_version_label`, `research_tag` and `is_trading_day` on
classifications and inputs; `research_tag` added to the two singleton cache keys;
`compass_module_readings` / `compass_module_states` / `compass_synthesis`; the two
archive tables. Five migrations.

**Point-in-time ingestion.** `realtimeStart` / `realtimeEnd` threaded through the
shared `fredClient` (additively — omitted means byte-identical behaviour for
EdgeFinder and NIFTY) into `compassFredClient` and the Data Stack. Verified live:
an unbounded request as of 2008-09-02 returns an observation dated 2008-09-01,
which nobody could have known; the point-in-time request correctly stops at
2008-07-01. PAYEMS for June 2008 reads 137,700 today and was 137,666 then.

**New data sources, zero new dependencies.** BIS policy rates (US/JP/XM, daily),
Japan MOF JGB curve, Bundesbank German curve, plus FRED `DFII10`, `BAA10Y`,
`DGS30/20/10`, `T10YIE` and `THREEFYTP10`. Each reproduces its Phase B manifest
exactly. The BIS zip is read by a ~90-line reader on Node's own `zlib` that takes
the compressed size from the central directory (the archive sets the
data-descriptor bit, so the local header's size field is zero).

**The 2s10s GREEN gate.** `yields.curve_green_requires_no_real_shock`. See §3.

**Layer 1 and layer 2.** Five modules, ~22 readings, deterministic synthesis. Every
explanation is `{templateId, params}` rendered server-side; nothing is stored as
prose. Every synthesis sentence carries traces that must resolve to a reading
present for the same date — `assertTraceable` enforces it at write time.

**UI.** Synthesis leads the page, then five openable module cards, then the
existing sections. Every number renders its source, as-of date and staleness.
Each module states what it cannot see, on the card rather than in a footnote.

**Validation.** Rebuilt as a replay. See §4.

---

## 2. What is in shadow

**`REAL_YIELD_SHOCK` (R1)** — the 60-day change in the 10-year TIPS real yield.
Computed and displayed daily, carries **no weight**, and is absent from
`EXPECTED_INPUT_CODES` and `config.weights`. It is not inert: the 2s10s GREEN gate
reads its band, so it affects scoring at zero weight. That is intended.

**The rescaling report says do not promote it.** Run
`npx tsx scripts/phase7-c6-reports.ts rescale`.

| Window | A: current 8.0 | B: naive 9.5 | C: rescaled 9.5 |
|---|---|---|---|
| V1 2008 Risk-Off% | 72.7 | 72.7 | **57.8** |
| V2 2020 Risk-Off% | 51.1 | 51.1 | **34.0** |
| V7 2025 Risk-Off% | 20.6 | 20.6 | **6.3** |
| V5 2024 Risk-On% | 55.6 | **73.4** | 48.0 |
| V6 2024 Risk-On% | 73.5 | **91.6** | 73.5 |
| V8 2026 Risk-On% | 0 | **14.3** | 0 |

Two things. Column B is the silent loosening — holding thresholds calibrated for a
scale of 8.0 against a scale of 9.5 makes Risk-On far too easy, and **V8 fires
14.3% Risk-On in a window built to never fire**, which is the false-optimism
failure landing exactly where you would least want it. Column C, properly rescaled,
**degrades every window that currently passes on Risk-Off**: V1 drops to 57.8% and
would fail its ≥60% criterion.

This is a report, not a decision. R1 stays in shadow. If a future phase wants to
revisit it, this is the evidence it must overturn.

---

## 3. The gate: what it does and does not do

`npx tsx scripts/phase7-c6-reports.ts gate`.

Across the eight windows: **71 curve-GREEN votes suppressed, 5 false Risk-On days
removed** — all five in 2022, the window where the architecture was most wrong.
Risk-Off share is unchanged everywhere, by construction: the gate moves weight from
green to yellow and can never add red.

| Window | curve GREEN% off → on | GREENs gated | Risk-On off → on |
|---|---|---|---|
| V1 2008_GFC | 72.7 → 42.2 | 39 | 0 → 0 |
| V4 2022_HIKES | 19.6 → 5.4 | 24 | **33 → 28** |
| V5 2024 | 19.8 → 16.7 | 8 | 140 → 140 |
| V2 2020_COVID | 75.5 → 75.5 | **0** | 8 → 8 |

**The gate corrects the curve during long-end repricing stress and is inert during
flight-to-quality stress.** Those are different crises and this fix addresses one
of them. In V2 the gate did nothing — not because of the weight arithmetic, but
because **R1 was never RED during COVID**: the 60-day real-yield change on
2020-03-16 was **−14.0bp**. Real yields collapsed. R1 detects fast rises only.

---

## 4. Validation: 5 of 8, and they are not a score

`runValidation()` replays eight windows through the shipped pure scoring modules
with point-in-time macro. Report `be8bcd75`, config v3.

**PASS:** V1 2008_GFC · V5 2024_FULL_YEAR · V6 2024_YEN_UNWIND · V7 2025_TARIFF_SHOCK ·
V8 2026_IRAN_SHOCK
**FAIL:** V2 2020_COVID · V3 2018_Q4 · V4 2022_HIKES

The three failures are three different kinds of thing, and collapsing them into
"5 of 8" loses the point.

**V4 2022_HIKES is a true architectural limit.** Mean red weight 0.73 against a 3.5
threshold; `US_DATA_STACK` GREEN on 100% of the window. It **survives HY OAS pinned
RED**, so it is not a data artifact. Compass measures fear; 2022 was repricing
without fear — credit spreads never above ~6%, no funding event. Correct behaviour
against a criterion this architecture cannot satisfy.

**V3 2018_Q4 is a data artifact, not a model failure.** The BAA10Y-derived proxy
scores HY OAS GREEN across 100% of a window where the real index reached ~5.4%. It
is unmeasurable, and stays unmeasurable while FRED's truncation stands.

**V2 2020_COVID is the interesting one.** Shortfall 0.92 — the smallest of the
three — with `YIELD_2S10S` voting GREEN on 75.5% of the fastest crash in modern
history. That is the inversion defect caught mid-failure. See §7.

Two windows changed verdict, both for defect reasons rather than tuning. V1 was
failing a criterion that was **structurally unsatisfiable** (Phase 4 retired the
crisis clause; the classifier writes `crisisOverrideFired: false` unconditionally,
so 2008 and 2020 could never pass under any data). V6 was measuring **duration
against a three-day spike** while reading `activeRegime`, a field the Shock Layer
deliberately never writes — Trigger A fired correctly on 2024-08-05 and the harness
counted zero.

**Independent reproduction.** The port lands on Phase B's numbers from a separately
built code path: V1 proxy **72.7%** (FINDINGS: 72.7%), V4 forcered 10.1% (9.8%),
V4 mean red weight **0.73** (0.73), `US_DATA_STACK` GREEN on **100%** of 2022,
V7 Trigger A on 4/7/8/9 April and V6 on 2024-08-05 — both exact.

---

## 5. The data discontinuity

Live history restarts **2026-09-09**. Everything before is in the archive tables
and remains queryable. Reasons, all verified against the database:

1. Straddles the v1→v2 config cutover mid-series, with nothing on the row recording
   which config produced it.
2. **28 of 104 classification rows are weekends**; three more are US market holidays
   (Juneteenth, 3 July observed, Labor Day 2026). All advanced the persistence
   counter, so a regime transition could complete on a closed market.
3. **All 46 pre-cutover `DXY_TREND` rows are mis-scaled** — 39 YELLOW that should be
   GREEN, and 7 GREEN that should be YELLOW.
4. `final_regime` is empty on the 45 pre-Phase-4 rows.

**Consequence for the UI:** the audit log and every period-over-period reading will
be empty or thin until history accumulates. Layer 2 handles this explicitly — it
renders a sentence saying how many trading days exist rather than a comparison
against one data point, and drops that notice past 20 days.

**Correction to FINDINGS.md §10.2.** It describes the DXY defect as storing
`abs(close − sma50)` "in index points". That is wrong. Tested against the stored
values, the index-points formula matches **0 of 46** rows; `abs(close/sma50 − 1) * 100`
matches **46 of 46** (worst error 8.4e-7). They stored the correct formula expressed
as a percent. It went unnoticed because `sma50 ≈ 99`, so the two agree to within
~1%. FINDINGS also caught only the 39 YELLOW→GREEN rows and missed the 7
GREEN→YELLOW, which are false-GREEN — the more dangerous direction.

**Correction to the "25 consecutive trading days" premise.** It is **24**. The
35-row run contains 10 weekends and one holiday (Labor Day 2026-09-07).

---

## 6. What the tool still cannot see

- **A repricing regime.** 2022 was severe and orderly. Compass reads fear, and
  there was none to read. The schema supports a non-voting `state_label` precisely
  so a future repricing detector needs no migration — but it does not exist.
- **Credit before 2023-09-11.** FRED truncated every ICE BofA OAS series across all
  vintages. `HY_OAS` cannot describe any earlier episode, and Trigger A —
  one of whose two legs is OAS velocity — is structurally unable to fire before
  that date. `BAA10Y` is shown alongside because it reaches back to 1986.
- **Real yields before 2003.** `DFII10` starts 2003-01-02, so R1 and the curve gate
  are inert before then.
- **Flight-to-quality real-yield collapses.** R1 is one-sided. See §7.
- **Why the dollar is moving.** R3 was tested and failed. See §8.
- **Inflation level.** The Data Stack reads CPI *direction*. It scored GREEN on all
  260 trading days of 2022. A level floor was tested at 2.0–5.0% and cannot add a
  single Risk-Off day by construction.
- **Its own forward returns.** Phase B found no significant forward effect for
  anything at any horizon. Nothing here predicts.

---

## 7. Top Phase D candidate: the R1 asymmetry

R1 detects fast **rises** in real yields and is therefore structurally blind to
flight-to-quality. Phase B explicitly declined to add a symmetric negative leg
without its own evidence, and that remains right — but V2 is now the case that
motivates testing one properly.

The shape of the question: a fast **fall** in real yields is the signature of a
deflationary crash. V2 fails by 0.92 with the curve voting GREEN on 75.5% of the
COVID window, and R1 sat at −14.0bp through it.

This is a **research task, not a patch**: a properly specified rule with a
pre-registered out-of-sample split and a sensitivity curve, held to the same bar
that just failed R3. Do not add a negative leg by symmetry.

---

## 8. R3 was tested and failed

`research/phase-b/scripts/c1_r3_out_of_sample.py`. Criteria fixed before running.

| Criterion | Result |
|---|---|
| Signs hold in both halves | **PASS** |
| US-specific = dollar story, global = gold story, in both halves | **FAIL** |
| Gold separation does not reverse across the quantile sweep | **FAIL** |

The characteristic split holds **after** 2015 (DXY ratio 1.71, gold 0.68) and
**inverts before it** (0.91, 1.14). The full-sample result FINDINGS reports is
driven entirely by the recent half — the same shape as the BNP carry-to-skewness
result Phase B rejected. The gold gap also reverses sign inside both halves.

R3 does not render. Layer 2 has no "why the dollar is moving" sentence family.

**That is six for six.** Every relationship in this project not split out of sample
has failed: term premium and the dollar, the dollar-yield decoupling axis, gold and
real yields, BNP skewness, the CPI floor, and now R3.

*Method note:* the first run of this analysis produced a false failure because only
one of the two regressors was standardised, making the ratio an artifact of scale.
Caught by cross-checking the full-sample gold ratio against FINDINGS §6.1 (0.73);
the unstandardised version gave 1.50, the corrected one 0.89.

---

## 9. An architectural finding, larger than R1

The rescaling report's mechanism is not specific to R1. **R1 votes GREEN most of the
time, so it adds green weight on nearly every day while the red threshold rises for
all days.** That is true of *any* mostly-quiet input added to a weighted-sum
classifier.

**The classifier cannot be materially improved by adding indicators. Adding inputs
dilutes.** A future phase that wants a better classifier will have to change the
**aggregation**, not extend the input list — the same conclusion Phase B reached
about the Data Stack's majority-of-three rule.

This is the most important thing in this document for roadmap purposes.

---

## 10. A testing pattern to watch for

The `/status` endpoint computed `expectedRows = tradingDaysExpected * 6` while the
backfill ingested 8 inputs, so it could never report `completed`. Its test
hardcoded `mockResolvedValue(6)` — **the same stale constant as the code it
covered**. Both were wrong and the suite stayed green.

A test that re-encodes a constant instead of deriving it cannot detect that
constant drifting. Both now derive from `orderedCompassInputs().length`. Worth
grepping for elsewhere.

The NIFTY `ind9-bridge` failures in §11 are the same family seen from the other
side: the service moved from `findUnique` to `findMany` and the test's hand-written
prisma mock never followed, so all eight cases now fall into a generic catch and
assert on the wrong thing. A mock that enumerates methods drifts from the code it
stands in for.

---

## 11. Verification

```bash
npx tsx scripts/phase7-stage0-ground-truth.ts    # read-only health check
npx tsx scripts/phase7-c6-reports.ts both        # gate + rescaling reports
npm run test:run                                  # 894 pass
npx tsc --noEmit
```

**Test position: 934 passing, 17 failing on the full suite.** All seventeen are
pre-existing and none are Compass:

- 9 in EdgeFinder/core — COT, Yahoo, CFTC, ForexFactory, cpiRateCycle. Baseline
  established by temporarily reverting the calendar change and re-running.
- 8 in NIFTY `ind9-bridge` — the test mocks `prisma.indicator` with only
  `findUnique` while the service calls `findMany`, so every case falls into the
  generic catch. A service/mock mismatch in NIFTY code this phase did not touch,
  and out of scope; worth fixing separately.

This phase introduced **zero** regressions.

Frontend has no test framework; verification is `npx tsc --noEmit`, `npm run lint`
and `npm run build`, all clean. The 39 lint problems are pre-existing and in files
this phase did not touch.

---

## 12. Two engineering decisions worth knowing

**`research_tag` is `NOT NULL DEFAULT ''` wherever it is part of a unique key,**
not nullable as originally planned. Postgres treats NULLs as distinct in a unique
index, so a nullable column would have silently permitted duplicate live rows and
destroyed the singleton guarantee on `compass_curve_state` and
`compass_shock_state`.

**The replay never writes `compass_inputs`.** It keeps per-input state in memory
and reports input detail through the classification's `voteBreakdown`. That left
that table's unique key untouched and avoided migrating three call sites.

---

## 13. ACM removed; Kim-Wright retained

**Dropped 2026-09-10.** ACM was the only manually refreshed source in Compass,
and the reason it went is maintenance cost, not accuracy.

**Why it existed.** The term premium is not observable, only modelled, so the
page showed two Federal Reserve estimates side by side and treated the gap
between them as the honest measure of how well the quantity can be known. That
framing was right and is kept — it now lives in the Kim-Wright reading's
standing copy, where it holds whether or not a second series is on the page.

**Why it went.** The NY Fed publishes ACM only as a ~10MB legacy `.xls`, not on
FRED. Automating it meant a spreadsheet dependency for a monthly, display-only
series, so it shipped as a checked-in CSV with a documented manual refresh:
download the workbook, read the "ACM Daily" sheet, rewrite
`data/compass/acm_term_premium_daily.csv`. Against 40+ indicators already under
manual maintenance, one more recurring chore for a number that casts no vote is
the wrong trade — and a forgotten refresh degrades quietly, sitting stale beside
fresh numbers until somebody reads the chip.

**What it read at runtime.** `acm-source.ts` resolved
`path.resolve(process.cwd(), 'data', 'compass', 'acm_term_premium_daily.csv')` —
the application's own data directory. Worth stating plainly because it was
suspected of reading from `research/`: it did not, and no application file in
either codebase ever did. See §14.

**Where the code is, if it is ever wanted back.** `acm-source.ts` is archived at
`Lucid-Research/scripts/backend/acm-source.ts.retired` and the CSV extract at
`Lucid-Research/research/phase-b/acm_term_premium_daily.csv`. Both are intact.
The call sites are in git history at
`src/modules/edgefinder/services/compass/modules/readings-builder.service.ts`.
Restoring means re-adding the loader, the `TERM_PREMIUM_ACM` reading, the
`reading.term_premium_pair` and `disagree.term_premium_models` templates, and
the synthesis clash block.

**What went with it.** The `TERM_PREMIUM_ACM` reading, the two-model comparison
figure in the UI (`TermPremiumSplit.tsx`), the term-premium clash disagreement
sentence, and its two synthesis tests — replaced by tests asserting that a lone
model produces no manufactured disagreement.

---

## 14. Research, analysis scripts and harnesses moved out

`Lucid-Backend` and `Lucid-Frontend` now hold application code only. Everything
else sits in `Lucid-Research/` alongside them.

**Moved:** `research/phase-b/` in full (337 files, 131MB — scripts, output,
data, replay harness, FINDINGS.md); the Phase 2-7 analysis and one-off
verification scripts; the frontend copy language check; the retired ACM loader
and its CSV.

**The dependency scan came back clean.** No application file in either codebase
read from `research/` at runtime. The five `src/` matches for that path were
provenance comments on the production replay port ("ported from
research/phase-b/replay/..."), now reworded to name the archive instead. The
single runtime file read anywhere in `src/` was ACM's, and it pointed at
`data/compass/`.

**References updated:** seven dead `verify:compass-*` entries removed from
`package.json`. One of them, `verify-compass-phase2a.ts`, imported
`checkCrisisOverride` — a symbol retired in Phase 4 — so the script could not
even load. The moved copy check had its import path repointed and still runs.

**What deliberately stayed.** `tests/`, because the suite is a quality gate and
its baseline is a stated verification bar; and the operational scripts —
`seed-edgefinder-data.ts`, `update-indicator-labels.ts`,
`cutover-dxy-to-eodhd.ts`, `verify-currency-codes.ts`, plus the new
`repair-rate-decision-units.ts`.

**One caveat on the copy check.** It is a quality gate, not analysis. Moved out
of the frontend it now reaches across into that repo to lint strings that ship
there, which makes it easier to forget. If the frontend ever grows a test
runner, it belongs back inside as a test.

**Side effect worth knowing.** Moving the scripts made a pre-existing ESLint gap
visible: `eslint.config.js` configured the TypeScript parser for `src/**` only,
so every `.ts` file under `tests/`, `scripts/`, `prisma/` and `dist/` went to the
default parser and failed on the first type annotation — roughly 70 "Parsing
error" entries that said nothing about the code and buried the few real
findings. The config now ignores build output and parses the rest properly.
Backend lint went from 87 problems (72 errors, essentially all noise) to 22
warnings and 0 errors, and surfaced two genuine unused variables in tests, both
fixed.

---

## 15. The central-bank rate display bug

**Symptom.** Every central-bank rate on the asset scorecard read
`0.00% / 0.00% / 0.00%`. Re-entering the values changed nothing.

**Not a write bug.** Every figure the admin had entered was in the database the
whole time. Rate decisions are scored on SURPRISE, not level, so ingestion
stores a bps CHANGE in `value`, writes `previousValue: null` deliberately, and
puts the absolute level in `sourceMetadata.rate_level`. On a first release the
bps change is hardcoded `0`. So `value = 0` was a correct stored zero, not a
lost write.

**The read was the bug.** `oracle.routes.ts` built each scorecard row from
`Number(dp.value)` / `dp.forecastValue` / `dp.previousValue` and never consulted
`sourceMetadata`, so it served the delta as though it were the rate and
formatted the two nulls as zero beside it. Fixed by `resolveDisplayValues` in
`oracle-mappers.ts`, which branches on `isRateDecisionCode` and recovers the
prior level by inverting ingestion's own formula — `priorLevel = level -
value/100` — exactly, and with no extra query.

**A second, worse bug on the edit path.** `manual-data-edit.service.ts` wrote
`input.actual/forecast/previous` straight into the columns for every indicator,
with no rate-decision branch. Editing a rate decision therefore put a LEVEL into
a column the scoring handler reads as a bps DELTA, and left the metadata holding
the old level, so display and scoring disagreed silently. Both paths now share
`isRateDecisionCode` and the same conversion helpers.

**The two bugs formed a loop, and one row carried its fingerprint.**
`AU_RBA_RATE` 2026-08-11 was the only row in the table with a non-null
`previous_value`, sitting at `0/0/0` while its metadata correctly held
4.36/4.35. The card showed zeros, they were re-submitted, and the edit path
wrote those zeros into the columns. Repaired by
`scripts/repair-rate-decision-units.ts` (dry-run by default), which rebuilds the
columns from metadata using ingestion's formula; exactly one row changed. The
admin edit form now seeds from the levels, so it cannot re-enter that loop.

---

## 16. What BIS supplies for the Fed

Checked against the live series rather than assumed. `POLICY_RATE_US` reads
**3.625** from `BIS:CBPOL_US` — the **midpoint** of the 3.50-3.75 target range,
not either bound and not effective fed funds. EdgeFinder's `US_FED_RATE` holds
**3.75**, the upper bound, per that row's own seed note.

Both are correct under different conventions, and the difference was previously
unexplained on the page. The new optional lower/upper range field on the rate
entry card makes it checkable: enter 3.50/3.75 and the card shows the range and
its midpoint, which is the figure BIS publishes. Stored in `sourceMetadata`
beside `rate_level` — no migration, and null for the BoE, BoJ and ECB, which
announce a single rate.

The same convention gap exists elsewhere and is worth knowing before it is
mistaken for an error: BIS BoJ **1.00** against EdgeFinder **0.75**; BIS ECB
**2.25** against EdgeFinder **2.15**, whose seed note cites the Deposit Facility
Rate.

---

## 17. BoE Bank Rate, and GBP carry

BIS `WS_CBPOL` carries no UK series this system reads (`BisArea` is
`US | JP | XM`), so there was no Bank Rate in Compass and GBPJPY carry could not
be computed at all.

`POLICY_RATE_GB` now reads the level from the `UK_BOE_RATE` data points the
admin panel already maintains — one entry, two consumers, no duplicate data
path. `GBP_CARRY` (UK minus Japan) follows from it.

The staleness limit is **55 trading days**, wider than the 10 used for the BIS
series, and the reasoning is in `admin-policy-rate.source.ts`: those are daily
observations, this is a step function that only moves at a meeting. At roughly
eight meetings a year the inter-meeting gap is about 32 trading days, so 55
clears one full gap without tripping on a normal one, while still surfacing a
missed decision within weeks.

Readings sourced `ADMIN:` also carry a **Manual** chip in the UI. With 40+
hand-maintained indicators, which ones carry a standing obligation should be
visible before one rots, not after.

---

## 18. Rate decisions now store levels, like every other indicator

**Changed 2026-09-10.** Central-bank rate decisions were the only indicator in
the system that did not store what it displayed. They now do.

### What was wrong

Every other indicator stores three LEVELS in the three DataPoint columns and
computes the difference where it is needed:

```
US_CPI_YOY    value=3.400000   forecast_value=3.400000   previous_value=3.500000
US_UNEMP      value=4.100000   forecast_value=4.100000   previous_value=4.100000
```

Rate decisions converted the entered levels into a bps CHANGE against the
previous decision, stored those deltas in the columns, wrote
`previousValue: null` because there was no column left for the prior rate, and
pushed the real numbers into `sourceMetadata`:

```
US_FED_RATE   value=0.000000   forecast_value=0.000000   previous_value=null
              metadata: rate_level=3.75, expected_rate_level=3.75
```

The stated reason was that rate decisions are scored on SURPRISE rather than on
the absolute action, and that both columns had to share a unit for the handler
to diff them honestly. The first half is true and unchanged. The second half did
not require the conversion, because the shared baseline cancels:

```
(actual - prior) - (forecast - prior)  ==  actual - forecast
```

Verified against the real helper before changing anything:

```
actual 3.75  forecast 3.50  prior 3.25  ->  stored 50bp / 25bp  surprise=25bp
                                         |  from levels directly: 25bp
```

So the conversion did no work for scoring, and cost a great deal:

- **The asset scorecard rendered every central-bank rate as `0.00% / 0.00% /
  0.00%`** for as long as it existed. It read the three columns, which held a
  delta of zero for a held rate and two deliberate nulls.
- **The edit path corrupted the score.** It wrote the typed level straight into
  a column the handler reads as basis points, and left the metadata holding the
  old level, so display and scoring disagreed silently.
- **A first decision could never be scored, even with a forecast on file**,
  because converting the forecast needed a prior rate that did not exist yet.
  The surprise was knowable from the two levels the whole time.

### What changed

`value` is the announced rate, `forecastValue` the expected rate,
`previousValue` the rate this decision moved from. The handler diffs actual
against forecast, exactly as it always did; only the unit moved from basis
points to percentage points, and the tolerance moved with it (0.01bp == 0.0001pp
— the same threshold, restated).

Touched: `rate-decision.helpers.ts`, `rate-decision.handler.ts`,
`manual-data-entry.service.ts`, `manual-data-edit.service.ts`,
`forex-factory-indicator.service.ts` (the FF cron ingests rate decisions too),
`oracle-mappers.ts`, `oracle.routes.ts`, `admin-indicators.routes.ts`,
`admin-policy-rate.source.ts`, and the admin card on the frontend.

**Net deletion.** `resolveDisplayValues`, `rateLevelsFromDataPoint` and
`levelToBpsChange` are gone, along with the whole rate branch in the edit
service and the level-seeding special case in the admin edit modal. Rate
decisions are ordinary rows now, so most of the code that existed to handle
their oddity had nothing left to do.

### Proof that no score moved

Every rate-decision data point was scored before the change and again after,
and compared:

```
SAME AU_RBA_RATE@2026-06-16    kind=insufficient_data score=null dir=null
SAME AU_RBA_RATE@2026-08-11    kind=scored score=1 dir=HAWKISH
SAME EU_ECB_RATE@2026-04-30    kind=insufficient_data score=null dir=null
SAME JP_BOJ_RATE@2026-04-28    kind=insufficient_data score=null dir=null
SAME UK_BOE_RATE@2026-04-30    kind=insufficient_data score=null dir=null
SAME UK_BOE_RATE@2026-06-08    kind=insufficient_data score=null dir=null
SAME US_FED_RATE@2026-04-28    kind=insufficient_data score=null dir=null
SAME US_FED_RATE@2026-04-30    kind=insufficient_data score=null dir=null
SAME US_FED_RATE@2026-06-17    kind=scored score=0 dir=AS_EXPECTED

9 identical. No score changed.
```

### Two behaviours that did change, both deliberate

**A first decision with a forecast is now scorable.** This was a capability the
bps shape could not express. No existing row is affected — none of the
first-release rows on file carried a forecast — but new ones will score where
they previously could not.

**`decision` is null on a first release rather than `HOLD`.** The old shape
hardcoded a zero bps change when there was no prior rate, so "we do not know
what this moved from" and "it did not move" were the same value. They are
different facts. `decision` is metadata only and has never driven the score.

### Migration

`scripts/migrate-rate-decisions-to-levels.ts` (dry-run by default). Exact: every
value written came from the metadata already on the row, and `previousValue`
from the preceding row's level. Nine rows across five indicators;
`rate_level` / `expected_rate_level` removed so the columns are the single
source of truth. `rate_range_lower` / `rate_range_upper` stay in metadata —
there is no column for them and no scoring use.

**Scope by scoring rule, never by code.** `IND_NIFTY_04_RBI_RATE` ends in
`_RATE` but is a NIFTY `cycle_regime` indicator scored by a different handler,
and it has always stored levels. The migration selects on
`scoring_rules.rule_type = 'rate_decision'`, so it was correctly left untouched
— verified after the run. The same trap applies to anything else that reaches
the database through `isRateDecisionCode`; that predicate is safe only on the
EdgeFinder write paths where it is currently used, and the helper file says so.

### Also fixed while here

`formatIndicatorValue` rendered rate decisions at one decimal place, so an
entered 3.75 displayed as **"3.8%"** — a figure no central bank has announced.
Rates and their surprises now format at two decimals, matching the 25bp
increments they actually move in. `US_02Y_SMA` already had its own 2dp branch
for the same reason.

### Verification

Backend tsc, lint (0 errors) and build clean. Test suite **936 passing, 17
failing** — the same 17 pre-existing failures as the documented baseline, with
two more tests than before: the rate-decision handler suite was rewritten in
levels (each case naming its old bps framing so the equivalence stays
checkable) and gained coverage for the two changed behaviours above.

Scorecard assembly re-run for all nine assets, none failed. `US_FED_RATE` on the
USD scorecard went from `outcome: insufficient_data` with three em dashes to
`outcome: scored, score: 0` rendering **3.75% / 3.75% / 3.75%**, surprise
+0.00%.
