/* eslint-disable no-console */
/**
 * Phase 3 (A1b) — currency-code integrity check.
 *
 * Phase 2 widened `Currency` from a union to `string` so no currency is named in
 * code. The trade-off is that a typo'd currency_code in
 * pair_template_row_currencies is now a silent no-op (the row simply never
 * applies to any pair) rather than a compile error. The database is the only
 * remaining guard, so assert it here:
 *
 *   every distinct currency_code in pair_template_row_currencies must correspond
 *   to an ACTIVE asset of assetClass 'currency'.
 *
 * Also flags the inverse — an active currency asset that no template row
 * references — which is not an error but is worth seeing.
 *
 * Exit code 1 on any orphan.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const used = await prisma.pairTemplateRowCurrency.groupBy({
    by: ['currencyCode'],
    _count: { _all: true },
  });

  const currencyAssets = await prisma.asset.findMany({
    where: { assetClass: 'currency' },
    select: { code: true, isActive: true, toolScope: true },
  });

  const activeCurrencies = new Set(
    currencyAssets.filter((a) => a.isActive).map((a) => a.code),
  );
  const knownCurrencies = new Map(currencyAssets.map((a) => [a.code, a]));

  console.log('=== currency codes used by pair_template_row_currencies ===');
  const orphans: string[] = [];
  for (const u of used.sort((a, b) => a.currencyCode.localeCompare(b.currencyCode))) {
    const asset = knownCurrencies.get(u.currencyCode);
    let verdict: string;
    if (!asset) {
      verdict = 'ORPHAN — no asset with this code';
      orphans.push(u.currencyCode);
    } else if (!asset.isActive) {
      verdict = 'ORPHAN — asset exists but is inactive';
      orphans.push(u.currencyCode);
    } else {
      verdict = 'ok';
    }
    console.log(`  ${u.currencyCode.padEnd(5)} used by ${String(u._count._all).padStart(2)} row(s)  -> ${verdict}`);
  }

  const unused = [...activeCurrencies].filter(
    (c) => !used.some((u) => u.currencyCode === c),
  );
  if (unused.length > 0) {
    console.log(
      `\nNOTE: active currency assets with no template rows (not an error): ${unused.join(', ')}`,
    );
  }

  // Same guard for the asset_indicator_map side: every mapped asset should exist.
  const mapped = await prisma.assetIndicatorMap.findMany({
    select: { asset: { select: { code: true, isActive: true } } },
    distinct: ['assetId'],
  });
  console.log('\n=== assets holding asset_indicator_map rows ===');
  for (const m of mapped.sort((a, b) => a.asset.code.localeCompare(b.asset.code))) {
    console.log(`  ${m.asset.code.padEnd(8)} active=${m.asset.isActive}`);
  }

  if (orphans.length > 0) {
    console.error(`\nFAIL: ${orphans.length} orphan currency code(s): ${orphans.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('\nPASS: every currency_code maps to an active currency asset.');
  }
}

main()
  .catch((e) => {
    console.error('verify-currency-codes failed', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
