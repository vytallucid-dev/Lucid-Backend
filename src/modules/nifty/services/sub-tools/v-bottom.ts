import { VBottomClassification, VBottomExample, VBottomResult } from './types';

const REAL_V_BOTTOM_UPPER = 0;
const COUNTER_TREND_LOWER = 5;

const HISTORICAL_EXAMPLES: VBottomExample[] = [
  {
    date: '2025-04-07',
    description: 'Phase 18 Apr 7',
    rawAtTrough: -8,
    outcome: 'Real V-bottom; raw -8 → +0.75/day repair',
  },
  {
    date: '2025-06-13',
    description: 'Phase 19A Jun 13',
    rawAtTrough: -8,
    outcome: 'Real V-bottom; raw -8 → +3.7% rally',
  },
  {
    date: '2025-03-04',
    description: 'Phase 15 Mar 4',
    rawAtTrough: -1,
    outcome: 'Real V-bottom; raw -1 → +8% rally',
  },
  {
    date: '2024-12-16',
    description: 'Phase 15 Dec 16',
    rawAtTrough: 5,
    outcome: 'Counter-trend bounce; raw +5 → bounce failed',
  },
  {
    date: '2025-02-10',
    description: 'Phase 15 Feb 10',
    rawAtTrough: 5,
    outcome: 'Counter-trend bounce; raw +5+ → bounce failed',
  },
];

function classify(ind9Raw: number): VBottomClassification {
  if (ind9Raw <= REAL_V_BOTTOM_UPPER) return 'REAL_V_BOTTOM';
  if (ind9Raw >= COUNTER_TREND_LOWER) return 'COUNTER_TREND_BOUNCE';
  return 'AMBIGUOUS';
}

function forwardExpectation(c: VBottomClassification): string {
  switch (c) {
    case 'REAL_V_BOTTOM':
      return 'USD regime broken. Recovery sustains.';
    case 'AMBIGUOUS':
      return 'USD neutral. Watch — needs External flip confirmation. Cannot call directionally.';
    case 'COUNTER_TREND_BOUNCE':
      return 'USD regime intact. Bounce will fail.';
  }
}

export function classifyVBottom(date: string, ind9Raw: number | null): VBottomResult {
  if (ind9Raw === null) {
    return {
      date,
      ind9Raw: null,
      classification: null,
      forwardExpectation: 'No Ind 9 raw data available for this date.',
      examples: HISTORICAL_EXAMPLES,
    };
  }
  const classification = classify(ind9Raw);
  return {
    date,
    ind9Raw,
    classification,
    forwardExpectation: forwardExpectation(classification),
    examples: HISTORICAL_EXAMPLES,
  };
}
