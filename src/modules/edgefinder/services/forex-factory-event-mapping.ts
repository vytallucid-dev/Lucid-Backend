/**
 * Forex Factory event (country, title) → EdgeFinder indicator code + release variant.
 *
 * Confidence levels:
 *   VERIFIED — confirmed from real FF JSON feed
 *   HIGH     — standard FF naming convention
 *   MEDIUM   — multiple candidate names exist; best guess
 *   LOW      — unusual / rare release; verify on first occurrence
 *
 * RESOLUTION IS EXACT-STRING ONLY. Never `includes()`, never fuzzy or
 * similarity matching. Title alone is not unique in the feed — "Final
 * Manufacturing PMI" arrives under JPY, EUR, GBP and USD in a single week,
 * and "Unemployment Rate" under NZD, CHF, CAD and USD. Substring matching
 * collides across countries; that exact pattern produced the JP_CPI_YOY
 * duplicate-key collision. The (country, title) pair IS unique across a
 * whole week's feed (verified against a live 99-event fetch), so it is a
 * sound composite key and nothing looser is needed.
 *
 * `country` keys are the values FF actually sends, which are currency codes,
 * NOT the ISO country codes the database stores on Indicator.country. FF
 * sends CNY where the database stores CN, and AUD where it stores AU. The
 * keys below must match the feed, not the database.
 *
 * A variant of `null` means the indicator is single-release (its DataPoint
 * rows carry variant = null). A non-null variant MUST correspond to a
 * registered IndicatorVariant row for that indicator — the registry
 * (indicator_variants, seeded by prisma/seed-indicator-variants.ts) is the
 * authority on the allowed set and their ordinals; this table only names
 * which feed string denotes which rung.
 *
 * JP CPI: FF publishes "National Core CPI y/y" but no national headline
 * title. The tracked series is headline (user rule 2026-09-13), so that title
 * is ALERT-ONLY — see ALERT-ONLY MAPPINGS below.
 *
 * ---------------------------------------------------------------------------
 * DELIBERATELY NOT MAPPED — euro-area national sub-PMIs
 * ---------------------------------------------------------------------------
 * These strings appear in the feed every month under country EUR and are the
 * single most tempting false positive it contains:
 *
 *   "Spanish Manufacturing PMI"        "Spanish Services PMI"
 *   "Italian Manufacturing PMI"        "Italian Services PMI"
 *   "French Final Manufacturing PMI"   "French Final Services PMI"
 *   "German Final Manufacturing PMI"   "German Final Services PMI"
 *   (and their "Flash" equivalents)
 *
 * They are MEMBER-STATE prints. EU_MFG_PMI / EU_SVC_PMI represent the
 * euro-area AGGREGATE, which the feed sends as the unprefixed
 * "Final Manufacturing PMI" / "Final Services PMI" under EUR. Mapping any
 * prefixed string to EU_MFG_PMI would silently overwrite the aggregate with
 * one country's data — a wrong number that looks entirely plausible.
 *
 * Do not "helpfully" add these. They are intended to fall to the unmapped
 * queue permanently, and their presence there is correct behaviour, not a gap.
 *
 * ---------------------------------------------------------------------------
 * COMPANION EVENTS — one release, two calendar rows, same instant
 * ---------------------------------------------------------------------------
 * A handful of codes are deliberately registered under TWO titles because
 * Forex Factory itself sends the one real-world release as two separate
 * calendar rows at the same scheduledAt. Both mappings are correct — the
 * titles genuinely describe the same release — but leaving both as
 * undifferentiated `one()` entries means the row downstream (overdue
 * resolver, badge, calendar) treats them as two independent occurrences of
 * one indicator, demanding two data entries for one number.
 *
 * The `companion()` helper marks the SECONDARY title. Exactly one title per
 * code is primary (the plain `one()` call, no flag needed — it's the
 * default); the rest are `companion()`. Primary drives overdue/due-today/the
 * badge; companion is context-only and can never go overdue (see
 * overdue-resolver.ts's isPrimary filter).
 *
 *   AU_RBA_RATE   primary "Cash Rate" (carries the number), companion
 *                 "RBA Rate Statement"
 *   UK_GDP_MOM    primary "GDP m/m" (the tracked monthly series), companion
 *                 "Prelim GDP q/q" (a quarterly print that happens to share
 *                 the instant — see the pre-existing note on UK_GDP_MOM below)
 *   JP_BOJ_RATE   primary "BOJ Policy Rate" (carries the number), companion
 *                 "Monetary Policy Statement"
 *
 * NOT companion pairs, despite also having >1 one() title for their code —
 * each is a DIFFERENT bug shape, deliberately left untouched here:
 *
 *   US_PCE_YOY   RESOLVED 2026-09-14. "Core PCE Price Index m/m" was a
 *                mis-registration — a different measure than the tracked
 *                core YoY line — and is no longer mapped. Only
 *                "Core PCE Price Index y/y" resolves to this code.
 *   EU_CPI_YOY   RESOLVED 2026-09-14. "CPI Flash Estimate y/y" and
 *                "Final CPI y/y" are now rung('flash') / rung('final') of a
 *                registered ladder (seed-indicator-variants.ts), so Final no
 *                longer overwrites Flash.
 *   CN_CAIXIN_PMI_MFG  "RatingDog Manufacturing PMI" / "Caixin Manufacturing
 *                PMI" are an old/new sponsor name for one release (see the
 *                CNY block's own comment) — the feed sends only ONE spelling
 *                per fetch, never both. No companion relationship to encode.
 */

export interface FfEventResolution {
  code: string;
  /** Registered variant name, or null for a single-release indicator. */
  variant: string | null;
  /**
   * Companion designation — see COMPANION EVENTS below. true for every
   * registration except the small set of explicitly-marked companion
   * titles. Ladder rungs (registered via rung()) are always primary: a
   * variant already distinguishes Flash from Final, so there is no
   * companion relationship to encode on top of it.
   */
  isPrimary: boolean;
  /**
   * ALERT-ONLY registration — see ALERT-ONLY MAPPINGS above
   * FF_EVENT_TO_INDICATOR. Present (and true) only on titles whose feed number
   * is a DIFFERENT measure than the tracked series. The calendar row still
   * links to the indicator (dates, due-today, overdue), but ingestion never
   * writes the feed's value into data_points. Absent everywhere else.
   */
  alertOnly?: true;
}

type CountryTitleMap = Record<string, Record<string, FfEventResolution>>;

/**
 * Single-release indicator — no variant ladder registered.
 * `companion: true` marks a title as the SECONDARY row of a companion pair
 * (see COMPANION EVENTS below) — every other one() registration is primary
 * by default, so most call sites never pass the second argument.
 */
const one = (code: string, opts?: { companion?: boolean }): FfEventResolution => ({
  code,
  variant: null,
  isPrimary: !opts?.companion,
});
/** One rung of a registered release ladder. Always primary — see isPrimary doc above. */
const rung = (code: string, variant: string): FfEventResolution => ({ code, variant, isPrimary: true });
const companion = (code: string): FfEventResolution => one(code, { companion: true });
/**
 * Alert-only single-release registration. Always primary: it is the only title
 * for its code, and overdue must still prompt the hand-filled entry.
 */
const alertOnly = (code: string): FfEventResolution => ({ code, variant: null, isPrimary: true, alertOnly: true });

/**
 * ---------------------------------------------------------------------------
 * ALERT-ONLY MAPPINGS — the feed's number is the wrong measure
 * ---------------------------------------------------------------------------
 * Every Oracle macro value is hand-filled from Trading Economics; Forex Factory
 * supplies release dates and alerts. For most titles FF's figure is the same
 * measure as the tracked series, so writing it is harmless. For the titles
 * below it is NOT — and Forex Factory publishes no title carrying the tracked
 * measure (checked against the live feed, 2026-09-14). Writing FF's value
 * would silently mix two measures in one series, so these link the calendar
 * row for alerts and overdue only:
 *
 *   US_PPI_MOM / EU_PPI_MOM   tracked: PPI YoY      FF: "PPI m/m"
 *   UK_PPI_MOM                tracked: PPI Output YoY  FF: "PPI Output m/m"
 *   JP_RETAIL_YOY             tracked: Retail MoM   FF: "Retail Sales y/y"
 *   JP_CPI_YOY                tracked: headline YoY FF: "National Core CPI y/y"
 *   JP_TOKYO_CPI_YOY          tracked: headline YoY FF: "Tokyo Core CPI y/y"
 *   AU_PPI_YOY                tracked: PPI YoY      FF: "PPI q/q"
 *   AU_CONSCONF               tracked: index level  FF: "Westpac Consumer Sentiment" (shown as m/m %)
 *
 * The codes keep their historical suffixes (_MOM / _YOY); the indicator NAMES
 * carry the measure actually tracked. User rules confirmed 2026-09-13.
 */
export const FF_EVENT_TO_INDICATOR: CountryTitleMap = {
  USD: {
    // VERIFIED from real fetch
    'Unemployment Claims': one('US_JOBLESS_CLAIMS'),
    // "ADP Weekly Employment Change" is DELIBERATELY NOT MAPPED. Only the
    // monthly release ("ADP Non-Farm Employment Change" below) is tracked as
    // US_ADP; the weekly print has no EdgeFinder counterpart. Falls to the
    // unmapped queue like any other untracked title — do not "helpfully"
    // remap it back to US_ADP.
    // HIGH confidence — standard FF naming
    'CPI y/y': one('US_CPI_YOY'),
    'PPI m/m': alertOnly('US_PPI_MOM'),
    'Retail Sales m/m': one('US_RETAIL_MOM'),
    'ISM Manufacturing PMI': one('US_ISM_MFG'),
    'ISM Services PMI': one('US_ISM_SVC'),
    // US_CB_CONSCONF tracks University of Michigan sentiment (user rule
    // 2026-09-13), NOT the Conference Board — the code keeps its historical
    // name. Prelim VERIFIED from the live feed; "Revised" is FF's standard
    // name for the final UoM print (HIGH).
    'Prelim UoM Consumer Sentiment': rung('US_CB_CONSCONF', 'prelim'),
    'Revised UoM Consumer Sentiment': rung('US_CB_CONSCONF', 'final'),
    'Non-Farm Employment Change': one('US_NFP'),
    'Unemployment Rate': one('US_UNEMP'),
    'ADP Non-Farm Employment Change': one('US_ADP'),
    'JOLTS Job Openings': one('US_JOLTS'),
    'Federal Funds Rate': one('US_FED_RATE'),
    // US GDP ladder: Advance → Second → Third. FF's names for the second and
    // third prints are "Prelim" and "Final"; the registry's variant names
    // (advance/second/third) follow the BEA's own terminology.
    'Advance GDP q/q': rung('US_GDP_QOQ', 'advance'),
    'Prelim GDP q/q': rung('US_GDP_QOQ', 'second'),
    'Final GDP q/q': rung('US_GDP_QOQ', 'third'),
    // MEDIUM confidence
    'Core PCE Price Index y/y': one('US_PCE_YOY'),
    // FLAGGED, NOT a companion — see the COMPANION EVENTS doc above. This
    // maps a DIFFERENT measure (m/m) to the y/y-tracked code, not a second
    // row of the same release. Left as-is pending its own fix; do not mark
    // this companion() — that would misrepresent it as a resolved case.
  },

  EUR: {
    // VERIFIED
    'Consumer Confidence': one('EU_CCI'),
    'Final CPI y/y': rung('EU_CPI_YOY', 'final'),
    // Euro-area AGGREGATE PMIs only — see the sub-PMI note in the file header.
    'Flash Manufacturing PMI': rung('EU_MFG_PMI', 'flash'),
    'Flash Services PMI': rung('EU_SVC_PMI', 'flash'),
    // HIGH
    'Final Manufacturing PMI': rung('EU_MFG_PMI', 'final'),
    'Final Services PMI': rung('EU_SVC_PMI', 'final'),
    // EU GDP ladder — ORDER IS INTENTIONAL AND READS BACKWARDS.
    //
    // Forex Factory's naming is counterintuitive here. "Prelim Flash GDP q/q"
    // is the FIRST print (~30 days after quarter end, partial sample);
    // "Flash GDP q/q" is the SECOND (~45 days, fuller sample). The word
    // "Prelim" carries the chronological meaning, NOT "Flash" — the opposite
    // of what the names suggest at a glance.
    //
    // So prelim outranks flash: prelim = ordinal 1, flash = ordinal 2,
    // final = ordinal 3 (see prisma/seed-indicator-variants.ts, which holds
    // the ordinals). Ordinal is the PRIMARY tiebreaker in
    // core/scoring/helpers/latest-release.ts, so swapping these two silently
    // resolves scoring to the wrong release on any date where both exist.
    //
    // If you are here because this looks inverted: it is not. Do not "fix" it.
    'Prelim Flash GDP q/q': rung('EU_GDP_QOQ', 'prelim'),
    'Flash GDP q/q': rung('EU_GDP_QOQ', 'flash'),
    'Final GDP q/q': rung('EU_GDP_QOQ', 'final'),
    'Retail Sales m/m': one('EU_RETAIL_MOM'),
    'PPI m/m': alertOnly('EU_PPI_MOM'),
    'CPI Flash Estimate y/y': rung('EU_CPI_YOY', 'flash'),
    'Unemployment Rate': one('EU_UNEMP'),
    'Main Refinancing Rate': one('EU_ECB_RATE'),
  },

  GBP: {
    // VERIFIED
    'CPI y/y': one('UK_CPI_YOY'),
    'GfK Consumer Confidence': one('UK_GFK'),
    'Unemployment Rate': one('UK_UNEMP'),
    'Flash Manufacturing PMI': rung('UK_MFG_PMI', 'flash'),
    'Flash Services PMI': rung('UK_SVC_PMI', 'flash'),
    'Retail Sales m/m': one('UK_RETAIL_MOM'),
    // HIGH
    'Final Manufacturing PMI': rung('UK_MFG_PMI', 'final'),
    'Final Services PMI': rung('UK_SVC_PMI', 'final'),
    // UK_GDP_MOM is the monthly GDP series and has no registered ladder.
    // Companion pair (see COMPANION EVENTS above): "GDP m/m" is primary —
    // it's the tracked monthly series; "Prelim GDP q/q" is a quarterly print
    // that happens to share the release instant, marked companion so it
    // renders as context and never independently goes overdue.
    'GDP m/m': one('UK_GDP_MOM'),
    'Prelim GDP q/q': companion('UK_GDP_MOM'),
    'PPI Output m/m': alertOnly('UK_PPI_MOM'),
    'Official Bank Rate': one('UK_BOE_RATE'),
  },

  JPY: {
    // VERIFIED
    'National Core CPI y/y': alertOnly('JP_CPI_YOY'),
    'Flash Manufacturing PMI': rung('JP_MFG_PMI', 'flash'),
    // HIGH
    'Final Manufacturing PMI': rung('JP_MFG_PMI', 'final'),
    'Flash Services PMI': rung('JP_SVC_PMI', 'flash'),
    'Final Services PMI': rung('JP_SVC_PMI', 'final'),
    // JP GDP ladder: Prelim → Final.
    'Prelim GDP q/q': rung('JP_GDP_QOQ', 'prelim'),
    'Final GDP q/q': rung('JP_GDP_QOQ', 'final'),
    'PPI y/y': one('JP_PPI_YOY'),
    'Household Spending y/y': one('JP_HSHLD_SPEND'),
    'Retail Sales y/y': alertOnly('JP_RETAIL_YOY'),
    'Consumer Confidence': one('JP_CONSCONF'),
    'Unemployment Rate': one('JP_UNEMP'),
    // GAP FILL — Tokyo Core CPI. Leads the national print by ~3 weeks and is
    // its own indicator, never a variant of JP_CPI_YOY.
    'Tokyo Core CPI y/y': alertOnly('JP_TOKYO_CPI_YOY'),
    // GAP FILL — Labor Cash Earnings, Prelim → Final ladder.
    'Average Cash Earnings y/y': rung('JP_CASH_EARNINGS_YOY', 'prelim'),
    'Final Average Cash Earnings y/y': rung('JP_CASH_EARNINGS_YOY', 'final'),
    // LOW
    // Companion pair (see COMPANION EVENTS above): the BOJ policy statement
    // and the rate itself publish at the same instant. "BOJ Policy Rate" is
    // primary — it carries the number, matching the AU_RBA_RATE precedent.
    'BOJ Policy Rate': one('JP_BOJ_RATE'),
    'Monetary Policy Statement': companion('JP_BOJ_RATE'),
  },

  // GAP FILL — the ten AUD indicators. FF sends country "AUD"; the database
  // stores Indicator.country = "AU". The key here must match the FEED.
  AUD: {
    'CPI y/y': one('AU_CPI_YOY'),
    'PPI q/q': alertOnly('AU_PPI_YOY'),
    'Employment Change': one('AU_EMPLOYMENT_CHANGE'),
    'Unemployment Rate': one('AU_UNEMPLOYMENT'),
    'GDP q/q': one('AU_GDP_QOQ'),
    'Westpac Consumer Sentiment': alertOnly('AU_CONSCONF'),
    // Companion pair (see COMPANION EVENTS above): "Cash Rate" is primary —
    // it carries the number; "RBA Rate Statement" is companion context.
    'Cash Rate': one('AU_RBA_RATE'),
    'RBA Rate Statement': companion('AU_RBA_RATE'),
    // VERIFIED from live feed — FF renamed AU retail sales to this in 2025.
    'Household Spending m/m': one('AU_MHSI_MOM'),
    // AU PMIs carry a Flash/Final ladder (Judo Bank).
    'Flash Manufacturing PMI': rung('AU_PMI_MFG', 'flash'),
    'Final Manufacturing PMI': rung('AU_PMI_MFG', 'final'),
    'Flash Services PMI': rung('AU_PMI_SVC', 'flash'),
    'Final Services PMI': rung('AU_PMI_SVC', 'final'),
  },

  // GAP FILL — China manufacturing PMI. FF sends country "CNY"; the database
  // stores Indicator.country = "CN". The key here must match the FEED.
  //
  // The sponsor renamed from Caixin to RatingDog in 2025 and the live feed now
  // sends "RatingDog Manufacturing PMI". Both spellings are mapped to the same
  // code deliberately: it costs one line, and a stale cache or an upstream
  // revert resolves cleanly instead of landing in the unmapped queue. The
  // indicator code keeps its CN_CAIXIN_ prefix — renaming a code is a
  // migration, not a mapping change. Single release, no ladder.
  CNY: {
    'RatingDog Manufacturing PMI': one('CN_CAIXIN_PMI_MFG'),
    'Caixin Manufacturing PMI': one('CN_CAIXIN_PMI_MFG'),
  },
};

/**
 * Resolve a feed event to an indicator code + variant. Exact match only.
 * Returns null when the (country, title) pair is not mapped — the caller is
 * expected to route that to the unmapped queue rather than drop it.
 */
export function resolveEvent(country: string, title: string): FfEventResolution | null {
  const countryMap = FF_EVENT_TO_INDICATOR[country];
  if (!countryMap) return null;
  return countryMap[title] ?? null;
}

/**
 * Back-compat code-only resolution. Retained because callers that only need
 * the indicator code (and never the variant) read better without destructuring.
 */
export function mapEventToIndicator(country: string, title: string): string | null {
  return resolveEvent(country, title)?.code ?? null;
}
