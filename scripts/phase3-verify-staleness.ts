/* eslint-disable no-console */
/** Phase 3 — confirm AU_PPI_YOY inherits the QUARTERLY freshness band. */
import { PrismaClient } from '@prisma/client';
import { getDataGapsReport, THRESHOLDS_BY_FREQUENCY, classifySeverity } from '@modules/nifty/services/data-gaps.service';

const prisma = new PrismaClient();
async function main(): Promise<void> {
  console.log('=== frequency bands actually in use (shared with the admin data-gaps report) ===');
  for (const [f, t] of Object.entries(THRESHOLDS_BY_FREQUENCY)) {
    console.log(`  ${f.padEnd(14)} fresh<=${t.fresh}d  warning<=${t.warning}d  critical>${t.warning}d`);
  }
  const report = await getDataGapsReport(new Date());
  const watch = ['AU_PPI_YOY', 'AU_CPI_YOY', 'JP_TOKYO_CPI_YOY', 'JP_CASH_EARNINGS_YOY', 'US_PPI_MOM'];
  console.log('\n=== these indicators in the existing gap report ===');
  for (const code of watch) {
    const r = report.find((x) => x.indicatorCode === code);
    if (!r) { console.log(`  ${code}: NOT IN REPORT`); continue; }
    console.log(`  ${r.indicatorCode.padEnd(22)} freq=${r.frequency.padEnd(10)} band=${r.expectedFreshnessDays}d ` +
      `last=${r.lastObservationDate ?? 'never'} days=${r.daysSinceLastObservation ?? '-'} severity=${r.severity}`);
  }
  console.log('\n=== proof AU_PPI is judged on the quarterly band, not the monthly one ===');
  for (const days of [50, 90, 110, 140]) {
    console.log(`  ${String(days).padStart(3)}d old -> as quarterly: ${classifySeverity(days, 'quarterly').padEnd(9)}` +
      ` | as monthly would be: ${classifySeverity(days, 'monthly')}`);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
