import type { ModuleCode } from './module-types';

/**
 * Per-module standing copy: what the module reads, and — the part that matters —
 * what it CANNOT see.
 *
 * The blind spots are stated on the module itself rather than in a footnote,
 * because a reading is only interpretable alongside its limits. Every one below
 * is a measured finding, not a disclaimer.
 */
export const MODULE_COPY: Record<ModuleCode, { whatItReads: string; blindSpot: string }> = {
  YIELDS: {
    whatItReads:
      'The shape of the US curve, how fast real yields are moving, what the market has priced ' +
      'against each central bank, and how much of the long-end yield is risk premium rather than ' +
      'expected policy.',
    blindSpot:
      'It cannot tell a steepening driven by recovery from one driven by a long-end selloff. ' +
      'Across 28 long-end episodes since 1990 the 2s10s input voted green at the term-premium ' +
      'peak in 26 of them, and green on 76.9% of days inside episodes against 49.3% outside. ' +
      'The real-yield gate corrects that only when real yields are RISING — it stays silent in a ' +
      'flight-to-quality crash, where real yields fall instead. It also cannot compute the ' +
      'real-yield reading at all before 2003, and the two term-premium models it displays ' +
      'disagree with each other, sometimes on the sign.',
  },
  VOL_CREDIT: {
    whatItReads:
      'Equity volatility now and relative to three months out, and the compensation demanded for ' +
      'corporate credit risk.',
    blindSpot:
      'The high-yield spread has NO history before 11 September 2023 — FRED retroactively ' +
      'truncated every ICE BofA option-adjusted spread series across all vintages — so this ' +
      'module cannot describe any earlier episode, and the volatility shock trigger that depends ' +
      'on it cannot fire before that date. The Baa spread is shown alongside precisely because it ' +
      'reaches back to 1986. Volatility is also a coincident measure: it tells you stress has ' +
      'arrived, not that it is coming.',
  },
  ECON_DATA: {
    whatItReads:
      'Inflation direction, growth and the labour market, each scored separately and combined by ' +
      'majority of three.',
    blindSpot:
      'The majority-of-three rule is the binding constraint, not any single check. It scored ' +
      'GREEN on all 260 trading days of 2022, the worst inflation year in four decades, because ' +
      'CPI was FALLING from a high level and the rule reads direction rather than level. Adding ' +
      'an inflation level floor was tested across 2.0-5.0% and cannot add a single risk-off day ' +
      'by construction. Nothing here improves without changing the aggregation.',
  },
  DOLLAR_POSITIONING: {
    whatItReads:
      'Where the dollar sits against its own recent trend, and how sharply it has moved.',
    blindSpot:
      'It reads the dollar\'s behaviour, not its cause. The reading that would have distinguished ' +
      'a globally-driven long-end move from a US-specific one was tested out of sample in Phase C ' +
      'against criteria fixed in advance and failed — the relationship holds after 2015 but ' +
      'inverts before it — so it is not shown. The retired gold/dollar correlation input stays ' +
      'retired: the inversion it assumed is not present in the data.',
  },
  POLICY_STANCE: {
    whatItReads:
      'What borrowing costs, at the four central banks whose decisions set the price of money for ' +
      'most of the world. Every yield on this page is a bet about where these rates go, so the ' +
      'rates themselves are what makes a yield readable: a 2-year above its policy rate means the ' +
      'market has priced hikes, below it cuts. It also reads the gaps between them, because a gap ' +
      'is what a carry trade earns — and what a yen-based investor is left with on a hedged US ' +
      'long bond after paying for the hedge.',
    blindSpot:
      'This module deliberately has NO verdict. Policy rates are the anchor that makes a 2-year ' +
      'yield interpretable; they are not a risk signal, and the 2-year-minus-policy gap has no ' +
      'predictive content beyond the 2-year itself. The hedge cost is approximated by the policy ' +
      'differential rather than actual forward points, which embed a cross-currency basis that ' +
      'has been materially negative for the yen — so the true pickup is worse than shown, not ' +
      'better.',
  },
};
