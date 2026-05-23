import { Prisma, DataFetchLog, FetchTriggerType, FetchStatus } from '@prisma/client';
import { prisma } from '@core/db/prisma';

export interface StartFetchLogParams {
  jobName: string;
  triggerType: FetchTriggerType;
  triggeredBy?: string | null;
  targetDateFrom?: Date | null;
  targetDateTo?: Date | null;
  metadata?: Prisma.InputJsonValue;
}

export interface CompleteFetchLogParams {
  logId: string;
  status: FetchStatus;
  rowsInserted?: number;
  rowsUpdated?: number;
  rowsSkipped?: number;
  errors?: Prisma.InputJsonValue;
  metadata?: Prisma.InputJsonValue;
}

export const dataFetchLogRepository = {
  async start(params: StartFetchLogParams): Promise<DataFetchLog> {
    return prisma.dataFetchLog.create({
      data: {
        jobName: params.jobName,
        triggerType: params.triggerType,
        triggeredBy: params.triggeredBy ?? null,
        targetDateFrom: params.targetDateFrom ?? null,
        targetDateTo: params.targetDateTo ?? null,
        status: 'running',
        metadata: params.metadata ?? Prisma.JsonNull,
      },
    });
  },

  async complete(params: CompleteFetchLogParams): Promise<DataFetchLog> {
    const log = await prisma.dataFetchLog.findUniqueOrThrow({
      where: { id: params.logId },
    });

    const completedAt = new Date();
    const durationMs = completedAt.getTime() - log.startedAt.getTime();

    return prisma.dataFetchLog.update({
      where: { id: params.logId },
      data: {
        status: params.status,
        completedAt,
        durationMs,
        rowsInserted: params.rowsInserted ?? 0,
        rowsUpdated: params.rowsUpdated ?? 0,
        rowsSkipped: params.rowsSkipped ?? 0,
        errors: params.errors ?? Prisma.JsonNull,
        metadata: params.metadata ?? log.metadata ?? Prisma.JsonNull,
      },
    });
  },
};
