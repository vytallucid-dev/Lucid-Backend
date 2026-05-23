import { prisma } from '@core/db/prisma';
import { AppError } from '@core/middleware/error-handler';
import { computeAutoAnchors, computeVelocity } from './sub-tools/velocity';
import { classifyVBottom } from './sub-tools/v-bottom';
import type {
  ScorecardHistoryRow,
  VelocityResult,
  AutoAnchors,
  VBottomResult,
} from './sub-tools/types';

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface VelocityServiceResult {
  velocity: VelocityResult;
  autoAnchors: AutoAnchors;
  trajectory: Array<{ date: string; net: number }>;
}

export interface VelocityServiceParams {
  startDate?: Date;
  endDate?: Date;
}

const HISTORY_DEPTH_FOR_ANCHORS = 130;

/**
 * Compute velocity for the /api/nifty/velocity endpoint.
 *
 * Resolution logic:
 *  - endDate omitted → use latest scorecard
 *  - startDate omitted → run auto-anchor logic against trailing 120 sessions
 *  - both provided → use as-is
 *
 * Throws 404 if endDate is supplied but no scorecard exists for that date.
 */
export async function getVelocity(
  params: VelocityServiceParams,
): Promise<VelocityServiceResult> {
  let endScorecard: { observationDate: Date; netScore: number } | null = null;
  if (params.endDate) {
    endScorecard = await prisma.niftyScorecard.findFirst({
      where: { observationDate: params.endDate, isCurrent: true },
      select: { observationDate: true, netScore: true },
    });
    if (!endScorecard) {
      throw new AppError(
        404,
        `No scorecard for end_date ${toIsoDate(params.endDate)}`,
        'SCORECARD_NOT_FOUND',
      );
    }
  } else {
    endScorecard = await prisma.niftyScorecard.findFirst({
      where: { isCurrent: true },
      orderBy: { observationDate: 'desc' },
      select: { observationDate: true, netScore: true },
    });
    if (!endScorecard) {
      return {
        velocity: {
          velocity: null,
          label: null,
          sessions: null,
          startDate: null,
          endDate: null,
          startNet: null,
          endNet: null,
          reason: 'No scorecards exist',
        },
        autoAnchors: {
          highAnchorDate: null,
          highAnchorNet: null,
          lowAnchorDate: null,
          lowAnchorNet: null,
          defaultStartDate: null,
          defaultStartNet: null,
        },
        trajectory: [],
      };
    }
  }

  const historyRows = await prisma.niftyScorecard.findMany({
    where: {
      observationDate: { lt: endScorecard.observationDate },
      isCurrent: true,
    },
    orderBy: { observationDate: 'desc' },
    take: HISTORY_DEPTH_FOR_ANCHORS,
    select: { observationDate: true, netScore: true, peakScoreCeilingState: true },
  });
  const history: ScorecardHistoryRow[] = historyRows.map((r) => ({
    observationDate: r.observationDate,
    netScore: r.netScore,
    peakScoreCeilingState: r.peakScoreCeilingState,
  }));
  const currentRow: ScorecardHistoryRow = {
    observationDate: endScorecard.observationDate,
    netScore: endScorecard.netScore,
    peakScoreCeilingState: null,
  };

  const anchors = computeAutoAnchors(currentRow, history);

  let startRow: ScorecardHistoryRow | null = null;
  if (params.startDate) {
    const startSc = await prisma.niftyScorecard.findFirst({
      where: { observationDate: params.startDate, isCurrent: true },
      select: { observationDate: true, netScore: true },
    });
    if (!startSc) {
      throw new AppError(
        404,
        `No scorecard for start_date ${toIsoDate(params.startDate)}`,
        'SCORECARD_NOT_FOUND',
      );
    }
    startRow = {
      observationDate: startSc.observationDate,
      netScore: startSc.netScore,
      peakScoreCeilingState: null,
    };
  } else if (anchors.defaultStartDate) {
    const found = history.find(
      (r) => toIsoDate(r.observationDate) === anchors.defaultStartDate,
    );
    startRow = found ?? null;
  }

  const velocityResult = computeVelocity(startRow, currentRow, history);

  let trajectory: Array<{ date: string; net: number }> = [];
  if (startRow) {
    const trajRows = await prisma.niftyScorecard.findMany({
      where: {
        observationDate: {
          gte: startRow.observationDate,
          lte: endScorecard.observationDate,
        },
        isCurrent: true,
      },
      orderBy: { observationDate: 'asc' },
      select: { observationDate: true, netScore: true },
    });
    trajectory = trajRows.map((r) => ({
      date: toIsoDate(r.observationDate),
      net: r.netScore,
    }));
  } else {
    trajectory = [
      { date: toIsoDate(endScorecard.observationDate), net: endScorecard.netScore },
    ];
  }

  return { velocity: velocityResult, autoAnchors: anchors, trajectory };
}

export interface VBottomServiceParams {
  date?: Date;
}

/**
 * Compute v-bottom classification for the /api/nifty/v-bottom-check endpoint.
 *
 * Throws 404 if date is supplied but no scorecard exists for that date.
 */
export async function getVBottomCheck(
  params: VBottomServiceParams,
): Promise<VBottomResult> {
  let scorecard: { observationDate: Date; ind9RawComposite: number | null } | null = null;

  if (params.date) {
    scorecard = await prisma.niftyScorecard.findFirst({
      where: { observationDate: params.date, isCurrent: true },
      select: { observationDate: true, ind9RawComposite: true },
    });
    if (!scorecard) {
      throw new AppError(
        404,
        `No scorecard for ${toIsoDate(params.date)}`,
        'SCORECARD_NOT_FOUND',
      );
    }
  } else {
    scorecard = await prisma.niftyScorecard.findFirst({
      where: { isCurrent: true },
      orderBy: { observationDate: 'desc' },
      select: { observationDate: true, ind9RawComposite: true },
    });
    if (!scorecard) {
      throw new AppError(404, 'No scorecards exist', 'SCORECARD_NOT_FOUND');
    }
  }

  return classifyVBottom(
    toIsoDate(scorecard.observationDate),
    scorecard.ind9RawComposite,
  );
}
