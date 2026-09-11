import type { ExplanationRef } from './module-types';

/**
 * The deterministic template registry.
 *
 * EVERY piece of interpretive text in Compass is rendered from one of these, by
 * a pure function of (templateId, params). Nothing is generated, and nothing is
 * stored as prose — a template edit must never be able to silently rewrite what
 * a past reading said, and a rendered sentence must always be reproducible from
 * the numbers that produced it.
 *
 * LANGUAGE RULES, enforced by a test over this file:
 *
 *   DESCRIPTIVE, NEVER PRESCRIPTIVE. No "favour", "buy", "sell", "should".
 *     This is a regulatory boundary as much as an editorial one — the same
 *     discipline as a no-buy/sell-ratings rule.
 *   PROBABILISTIC AND HISTORICAL, NEVER PREDICTIVE. "has historically
 *     coincided with", not "will". Phase B found no forward-return effect at
 *     any horizon for anything; text implying otherwise would be false.
 *   REAL TERMINOLOGY, EXPLAINED. "long-end term premium", not "long-term worry
 *     level". The audience is an analyst who must be able to verify and a
 *     beginner willing to work — both need the mechanics visible.
 */

export type TemplateFn = (p: Record<string, unknown>) => string;

const n = (v: unknown, dp = 2): string =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(dp) : '—';
const signed = (v: unknown, dp = 0): string =>
  typeof v === 'number' && Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(dp)}` : '—';
/** Strings get the same treatment as numbers: never render "undefined" at a user. */
const t = (v: unknown): string => (typeof v === 'string' && v.length > 0 ? v : '—');

export const TEMPLATES: Record<string, TemplateFn> = {
  // ---------------------------------------------------------------- readings
  'reading.real_yield_shock': (p) =>
    `The 10-year TIPS real yield has moved ${signed(p.bp, 0)}bp over the last 60 trading days. ` +
    `Fast rises have historically coincided with gold weakness, with the relationship holding ` +
    `at similar strength in and out of sample; it says nothing about direction from here.`,
  'reading.real_yield_shock.unavailable': () =>
    `Not computable. The 10-year TIPS series begins in January 2003, and this reading needs 60 ` +
    `trading days of it.`,
  'reading.curve_2s10s': (p) =>
    `The 2s10s spread is ${n(p.level)}pp, ${signed(p.delta30, 2)}pp over 30 trading days.`,
  'reading.curve_2s10s.gated': (p) =>
    `The 2s10s spread is ${n(p.level)}pp and would otherwise read as healthy, but that reading is ` +
    `suppressed while real yields are rising fast: a steepening curve looks the same whether it ` +
    `comes from recovery or from a long-end selloff.`,
  'reading.term_premium_single': (p) =>
    `The Kim-Wright model puts the 10-year term premium at ${n(p.kw)}pp. It is a model estimate ` +
    `of a quantity nobody can observe directly, and other published models put it elsewhere — ` +
    `the level is an indication, not a measurement.`,
  'reading.breakeven': (p) =>
    `The 10-year breakeven inflation rate is ${n(p.value)}%, with the real yield at ${n(p.real)}%.`,
  'reading.long_end_steepening': (p) =>
    `The 10s30s spread has moved ${signed(p.bp, 0)}bp over 60 trading days.`,
  'reading.twenty_thirty': (p) =>
    `The 20s30s spread is ${n(p.value)}pp. This is a supply artifact of the 20-year point, not a ` +
    `stress signal: it has been inverted on 55.8% of all days since 1977, including every ` +
    `trading day of 2022, 2023 and 2024.`,
  'reading.two_year_vs_policy': (p) =>
    `${t(p.country)} 2-year at ${n(p.twoYear)}% against a policy rate of ${n(p.policy)}% — ` +
    `${signed(p.gapBp, 0)}bp, which is how much tightening or easing the market has priced.`,
  'reading.vix': (p) => `VIX 5-day average ${n(p.value, 1)}.`,
  'reading.vix_term_structure': (p) =>
    `VIX / VIX3M ratio ${n(p.value, 3)}. Above 1.0 is backwardation — near-term risk priced above ` +
    `longer-dated.`,
  'reading.hy_oas': (p) =>
    `High-yield option-adjusted spread ${n(p.level)}%, ${signed(p.delta10, 2)}pp over 10 trading days.`,
  'reading.hy_oas.no_history': () =>
    `No history before 11 September 2023. FRED has retroactively truncated every ICE BofA ` +
    `option-adjusted spread series across all vintages, so this input cannot describe any earlier ` +
    `episode, and the shock trigger that depends on it cannot fire before that date.`,
  'reading.baa_spread': (p) =>
    `Moody's Baa corporate spread over Treasuries ${n(p.value)}pp. Daily from 1986 — the ` +
    `long-history credit reading that high-yield spreads cannot provide.`,
  'reading.data_stack': (p) =>
    `CPI trajectory ${t(p.cpi)}, GDP ${t(p.gdp)}, jobs ${t(p.jobs)} — aggregated by majority of three.`,
  'reading.dxy_trend': (p) =>
    `The dollar index is ${n(p.devPct, 2)}% from its 50-day average, with a ${n(p.move5Pct, 2)}% ` +
    `move over 5 trading days.`,
  'reading.dxy_yield_correlation': (p) =>
    `The 60-day correlation between daily dollar moves and 10-year yield moves is ${n(p.value)}. ` +
    `It has averaged about 0.15 since 1990 and is a transient state with entry and exit, not a ` +
    `persistent regime: the April 2025 decoupling took three months to arrive and four to unwind.`,
  'reading.policy_rate': (p) => `${t(p.bank)} policy rate ${n(p.value)}%.`,
  'reading.hedged_jgb_pickup': (p) =>
    `A yen-based investor hedging currency risk earns ${n(p.value)}pp on a US 30-year relative to ` +
    `a 30-year JGB. Negative every single day since 28 July 2022.`,
  'reading.gbp_carry': (p) =>
    `UK-Japan policy rate differential ${n(p.value)}pp. The same funding arithmetic as the yen-dollar ` +
    `carry on a different pair: what an investor collects for borrowing yen against sterling. The ` +
    `Bank Rate side is entered by hand, so this reading is only as current as its last update.`,
  'reading.jpy_carry': (p) =>
    `US-Japan policy rate differential ${n(p.value)}pp. Higher carry has historically preceded ` +
    `higher realised volatility and deeper drawdowns in the yen cross — a sizing consideration, ` +
    `not a direction. The related claim about return skewness does not survive testing on ` +
    `non-overlapping windows.`,

  // ---------------------------------------------------------------- module headlines
  'module.yields.calm': () =>
    `The yield curve and real yields are not signalling stress.`,
  'module.yields.real_shock': (p) =>
    `Real yields are rising quickly — ${signed(p.bp, 0)}bp over 60 trading days.`,
  'module.yields.curve_red': () =>
    `The curve is inside a post-inversion window with a weakening labour market.`,
  'module.vol_credit.calm': () => `Volatility and credit spreads are contained.`,
  'module.vol_credit.stressed': (p) =>
    `Volatility and credit are showing stress: ${n(p.redInputs, 0)} of three inputs are red.`,
  'module.vol_credit.mixed': () => `Volatility and credit are mixed.`,
  'module.econ.green': () => `The macro data is reading constructively.`,
  'module.econ.yellow': () => `The macro data is mixed.`,
  'module.econ.red': () => `The macro data is deteriorating.`,
  'module.dollar.calm': () => `The dollar is trading close to trend.`,
  'module.dollar.break': () => `The dollar has made a sharp move against its recent trend.`,
  'module.policy.descriptive': (p) =>
    `The Fed is at ${n(p.fed)}% and the Bank of Japan at ${n(p.boj)}%, a gap of ` +
    `${n(p.gap)}pp — the rate an investor collects for borrowing yen and holding dollars, and ` +
    `the anchor every yield on this page is read against. The ECB sits at ${n(p.ecb)}%.`,

  // ---------------------------------------------------------------- synthesis
  'synth.regime': (p) =>
    `The risk-appetite reading is ${t(p.regime)}, from a weighted vote of ${n(p.green, 1)} green, ` +
    `${n(p.yellow, 1)} yellow and ${n(p.red, 1)} red out of ${n(p.total, 1)}.`,
  'synth.regime.pending': (p) =>
    `The reading is ${t(p.active)}, with ${t(p.candidate)} pending — ${n(p.count, 0)} of ${n(p.required, 0)} ` +
    `consecutive days needed to confirm the change.`,
  'synth.shock': (p) =>
    `A volatility shock is active and forces the reading to Risk-Off until ${t(p.expiry)}, ` +
    `independently of the standard vote.`,
  'synth.vol_credit': (p) =>
    `Volatility and credit: ${t(p.detail)}`,
  'synth.yields_calm_but_shock': (p) =>
    `Real yields have risen ${signed(p.bp, 0)}bp over 60 trading days while the curve itself ` +
    `reads as healthy — the condition under which the curve input has historically been least ` +
    `informative.`,
  'synth.history_restart': (p) =>
    `Live classification history restarted on ${t(p.date)} and currently holds ${n(p.days, 0)} trading ` +
    `day(s). Comparisons over longer periods are unavailable until more accumulate.`,

  // ---------------------------------------------------------------- disagreement
  'disagree.modules': (p) =>
    `The modules disagree: ${t(p.greenModules)} reading constructively while ${t(p.redModules)} reads ` +
    `as stressed. That divergence is itself the information.`,
  'disagree.curve_vs_real_yields': () =>
    `The curve reads healthy while real yields are rising fast. Across 28 long-end episodes since ` +
    `1990 the curve input voted green at the term-premium peak in 26 of them, so this particular ` +
    `combination is where it has been least reliable.`,
};

/** Render a template. Unknown ids throw rather than silently rendering nothing. */
export function render(ref: ExplanationRef): string {
  const fn = TEMPLATES[ref.templateId];
  if (!fn) throw new Error(`Unknown template id: ${ref.templateId}`);
  return fn(ref.params);
}

export function explanation(
  templateId: string,
  params: Record<string, string | number | boolean | null> = {},
): ExplanationRef {
  if (!TEMPLATES[templateId]) throw new Error(`Unknown template id: ${templateId}`);
  return { templateId, params };
}
