import { prisma } from '@core/db/prisma';

/**
 * Returns true if the most recent log entry for this job is within
 * the lookback window AND status is 'running'. Used by cron jobs
 * to prevent concurrent execution.
 */
export async function isJobRunning(
  jobName: string,
  lookbackMinutes: number,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - lookbackMinutes * 60 * 1000);

  const recentRunning = await prisma.dataFetchLog.findFirst({
    where: {
      jobName,
      status: 'running',
      startedAt: { gte: cutoff },
    },
    orderBy: { startedAt: 'desc' },
  });

  return recentRunning !== null;
}
