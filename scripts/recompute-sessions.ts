// Re-derives every trade's stored `session` from its `date_opened` using the
// current sessionFromDate() windows, and reports what would change.
//
// DRY RUN BY DEFAULT — prints the before/after for every trade whose stored
// session differs from the current rule and writes nothing. Pass --apply to
// write the `session` column for exactly those rows (and nothing else: no
// price, P&L, R, snapshot or timestamp field is touched).
//
//   npx tsx scripts/recompute-sessions.ts            # report only
//   npx tsx scripts/recompute-sessions.ts --apply    # write
//
// Why this exists: until 2026-09-12 the 11:30–13:30 IST window fell through to
// "New York". The rule now assigns it to London (journal plan decision D9 —
// a default, not yet confirmed by the trader), but stored rows keep their old
// tag until they are edited or this script is applied.
import { prisma } from '../src/core/db/prisma';
import { sessionFromDate } from '../src/modules/trading/services/trade-metrics';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const trades = await prisma.trade.findMany({
    select: { id: true, userId: true, pair: true, dateOpened: true, session: true },
    orderBy: { dateOpened: 'asc' },
  });

  const changes = trades
    .map((t) => ({ ...t, next: sessionFromDate(t.dateOpened) }))
    .filter((t) => t.next !== t.session);

  console.log(`${trades.length} trades scanned; ${changes.length} would change.`);
  for (const c of changes) {
    console.log(
      `  ${c.dateOpened.toISOString().slice(0, 16)}Z  ${c.pair.padEnd(8)} ${c.session} -> ${c.next}  (${c.id.slice(0, 8)}, user ..${c.userId.slice(-6)})`,
    );
  }

  const tally = (rows: { session: string }[]): Record<string, number> =>
    rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.session]: (acc[r.session] ?? 0) + 1 }), {});
  console.log('Before:', JSON.stringify(tally(trades)));
  console.log('After: ', JSON.stringify(tally(trades.map((t) => ({ session: sessionFromDate(t.dateOpened) })))));

  if (!apply) {
    console.log('Dry run — nothing written. Re-run with --apply to write.');
    return;
  }
  await prisma.$transaction(
    changes.map((c) => prisma.trade.update({ where: { id: c.id }, data: { session: c.next } })),
  );
  console.log(`Applied: ${changes.length} session value(s) written.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
