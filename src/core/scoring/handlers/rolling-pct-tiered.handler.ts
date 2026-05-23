import { rollingPctDirectionHandler } from './rolling-pct-direction.handler';
import { ScoringContext, ScoringResult } from '../types';

export async function rollingPctTieredHandler(ctx: ScoringContext): Promise<ScoringResult> {
  return rollingPctDirectionHandler(ctx);
}
