/// <reference types="node" />
/* eslint-disable no-console */
/**
 * Stage 0.2 tripwire — has anything written since the writer was stopped?
 *
 * Baseline (see BASELINE below): the row counts at the last check, after
 * which no writer should have run. Any change means a writer is still alive.
 *
 * STRICTLY READ-ONLY. Prints one TRIPWIRE line: CLEAR or FIRED.
 *
 *   npx tsx recovery/scripts/00e-tripwire.ts
 */
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

const prisma = new PrismaClient({ log: ['warn', 'error'] });
// Re-baselined 2026-09-14 04:08 UTC after the second FIRED check (writer still
// alive through 2026-09-14 02:35). Earlier baseline: 19 / 177.
const BASELINE = { logs: 27, events: 184, lastStartedAt: '2026-09-14 02:35:01.290' };

async function main(): Promise<void> {
  const [counts] = await prisma.$queryRawUnsafe<Array<{ logs: bigint; events: bigint }>>(
    `SELECT (SELECT count(*) FROM data_fetch_log) AS logs,
            (SELECT count(*) FROM calendar_events) AS events`,
  );
  const newer = await prisma.$queryRawUnsafe<
    Array<{ job_name: string; trigger_type: string; started_at: Date }>
  >(
    `SELECT job_name, trigger_type::text AS trigger_type, started_at
     FROM data_fetch_log WHERE started_at > '${BASELINE.lastStartedAt}' ORDER BY started_at`,
  );

  const logs = Number(counts.logs);
  const events = Number(counts.events);
  const fired = logs !== BASELINE.logs || events !== BASELINE.events || newer.length > 0;

  console.log(
    `TRIPWIRE ${fired ? 'FIRED' : 'CLEAR'} at ${new Date().toISOString()} — ` +
      `data_fetch_log=${logs} (baseline ${BASELINE.logs}), calendar_events=${events} (baseline ${BASELINE.events})`,
  );
  for (const r of newer) {
    console.log(`TRIPWIRE NEW ${new Date(r.started_at).toISOString()} ${r.job_name} ${r.trigger_type}`);
  }
}

main()
  .catch((e) => {
    console.log(`TRIPWIRE ERROR ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
