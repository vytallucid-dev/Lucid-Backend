/// <reference types="node" />
/* eslint-disable no-console */

/**
 * One-off: sync `name` + `description` on existing `indicators` rows to match
 * the values now in prisma/seed-edgefinder.ts, without touching any other
 * column (code/category/frequency/country/uiGroup/dataSource/sourceSeriesId
 * are left exactly as they are) and without deleting/reseeding anything.
 *
 * Safe to re-run: each row is updated by its unique `code`, and the values
 * below are the literal desired end-state (idempotent).
 *
 * Usage:
 *   npx tsx scripts/update-indicator-labels.ts          # apply
 *   npx tsx scripts/update-indicator-labels.ts --dry-run # preview only, no writes
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type LabelUpdate = {
  code: string;
  name: string;
  description: string | null;
};

const UPDATES: LabelUpdate[] = [
  // US
  { code: 'US_GDP_QOQ', name: 'US GDP Growth Rate QoQ', description: 'Latest release (Adv→2nd→Final). Take whichever print is current.' },
  { code: 'US_ISM_MFG', name: 'US ISM Manufacturing PMI', description: 'ISM, NOT S&P Global.' },
  { code: 'US_ISM_SVC', name: 'US ISM Services PMI', description: 'ISM Services (Non-Mfg), NOT S&P Global.' },
  { code: 'US_RETAIL_MOM', name: 'US Retail Sales MoM', description: 'Headline, NOT control group.' },
  { code: 'US_CB_CONSCONF', name: 'US Consumer Confidence (Conf. Board)', description: 'Conference Board, NOT Michigan Sentiment.' },
  { code: 'US_CPI_YOY', name: 'US CPI YoY (Headline)', description: 'Headline all-items, NOT Core.' },
  { code: 'US_PPI_MOM', name: 'US PPI MoM (Headline)', description: 'Headline final demand, NOT Core.' },
  { code: 'US_PCE_YOY', name: 'US Core PCE YoY', description: 'CORE PCE (~3.4), NOT headline (~4.1). Most common error.' },
  { code: 'US_02Y_SMA', name: 'US 2Y Yield (21-day SMA)', description: '2Y yield, 21-day SMA computed. Not a calendar print.' },
  { code: 'US_NFP', name: 'US Non-Farm Payrolls', description: 'Original print, not later revision.' },
  { code: 'US_UNEMP', name: 'US Unemployment Rate', description: null },
  { code: 'US_JOBLESS_CLAIMS', name: 'US Initial Jobless Claims', description: 'Initial, NOT continuing.' },
  { code: 'US_ADP', name: 'US ADP Employment Change', description: null },
  { code: 'US_JOLTS', name: 'US JOLTS Job Openings', description: null },

  // EU
  { code: 'EU_GDP_QOQ', name: 'EU GDP Growth Rate QoQ', description: 'Latest print (flash→final).' },
  { code: 'EU_MFG_PMI', name: 'EU HCOB Manufacturing PMI', description: 'Eurozone aggregate, flash→final. NOT country-level.' },
  { code: 'EU_SVC_PMI', name: 'EU HCOB Services PMI', description: 'Eurozone aggregate, flash→final.' },
  { code: 'EU_RETAIL_MOM', name: 'EU Retail Sales MoM', description: 'First estimate.' },
  { code: 'EU_CPI_YOY', name: 'EU CPI YoY (HICP Headline)', description: 'HICP headline final (~mid-month). NOT flash, NOT Core.' },
  { code: 'EU_PPI_MOM', name: 'EU PPI MoM (Headline)', description: 'Headline, NOT ex-energy.' },
  { code: 'EU_UNEMP', name: 'EU Unemployment Rate', description: null },

  // UK
  { code: 'UK_GDP_MOM', name: 'UK GDP Growth Rate MoM', description: 'MONTHLY GDP — UK only. Not QoQ.' },
  { code: 'UK_MFG_PMI', name: 'UK S&P/CIPS Manufacturing PMI', description: 'Flash→final.' },
  { code: 'UK_SVC_PMI', name: 'UK S&P/CIPS Services PMI', description: 'Flash→final.' },
  { code: 'UK_RETAIL_MOM', name: 'UK Retail Sales MoM', description: 'Incl. fuel.' },
  { code: 'UK_CPI_YOY', name: 'UK CPI YoY', description: 'CPI (~3.0), NOT CPIH (~3.2). Headline, not Core.' },
  { code: 'UK_PPI_MOM', name: 'UK PPI Output MoM', description: 'OUTPUT PPI, NOT Input.' },
  { code: 'UK_UNEMP', name: 'UK Unemployment Rate', description: '3-month ILO rate.' },

  // JP
  { code: 'JP_GDP_QOQ', name: 'JP GDP Growth Rate QoQ', description: 'Latest print. Heavy prelim→final revisions.' },
  { code: 'JP_MFG_PMI', name: 'JP Jibun Bank Manufacturing PMI', description: 'Flash→final.' },
  { code: 'JP_SVC_PMI', name: 'JP Jibun Bank Services PMI', description: 'WARNING: EdgeFinder source feed was frozen (Jul 2024). Enter fresh from source; verify date is current.' },
  { code: 'JP_RETAIL_YOY', name: 'JP Retail Sales YoY', description: 'YoY, NOT MoM.' },
  { code: 'JP_CPI_YOY', name: 'JP CPI YoY (National)', description: 'National all-items headline. NOT Core, NOT Tokyo.' },
  { code: 'JP_PPI_YOY', name: 'JP PPI YoY (CGPI)', description: 'Corporate Goods Price Index.' },
  { code: 'JP_HSHLD_SPEND', name: 'JP Household Spending YoY', description: null },
  { code: 'JP_UNEMP', name: 'JP Unemployment Rate', description: null },
];

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`${dryRun ? '[DRY RUN] ' : ''}Updating name/description for ${UPDATES.length} indicators by code...`);

  let updated = 0;
  let missing = 0;

  for (const u of UPDATES) {
    const existing = await prisma.indicator.findUnique({
      where: { code: u.code },
      select: { code: true, name: true, description: true },
    });

    if (!existing) {
      console.warn(`  ✗ SKIP (not found in DB): ${u.code}`);
      missing++;
      continue;
    }

    const nameChanged = existing.name !== u.name;
    const descChanged = existing.description !== u.description;
    if (!nameChanged && !descChanged) {
      console.log(`  = ${u.code} already up to date`);
      continue;
    }

    console.log(
      `  ${dryRun ? '~' : '✓'} ${u.code}: ` +
        (nameChanged ? `name "${existing.name}" → "${u.name}" ` : '') +
        (descChanged ? `description "${existing.description ?? ''}" → "${u.description ?? ''}"` : ''),
    );

    if (!dryRun) {
      await prisma.indicator.update({
        where: { code: u.code },
        data: { name: u.name, description: u.description },
      });
    }
    updated++;
  }

  console.log();
  console.log(`${dryRun ? 'Would update' : 'Updated'}: ${updated}`);
  if (missing > 0) console.log(`Missing from DB (skipped): ${missing}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
