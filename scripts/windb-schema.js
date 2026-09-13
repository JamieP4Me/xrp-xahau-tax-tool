#!/usr/bin/env node
/**
 * What columns WinDB actually has — asked, not assumed.
 *
 * WHY THIS EXISTS
 *
 * Three fields this project needs are missing from the cache, and each one
 * costs something specific:
 *
 *   DestinationTag   without it a shared exchange address cannot be split
 *                    between "my own deposit" and "a gift to my brother".
 *   Fee              4,768,506 signed transactions, every one costing XAH.
 *                    The hosting business's largest countable expense.
 *   Remit's Amounts  171 transactions whose payload is an ARRAY; the
 *                    flattened export has one scalar slot and dropped it.
 *
 * The temptation is to add plausible column names to the SELECT list and
 * re-sync overnight. This project has already done exactly that once:
 * Asset_currency was added on a schema-level guess, the cache was re-pulled
 * over several hours, and it recovered nothing because the column is empty on
 * every row that mattered. A full re-sync is too expensive to spend on a
 * guess, so ask the schema first and add only what is really there.
 *
 * The Payment-Claim is read from the ENVIRONMENT only. Never argv, never
 * logged, never written to a file.
 *
 *   export DHALI_PAYMENT_CLAIM='...'
 *   npm run windb:schema
 */
'use strict';

const claim = process.env.DHALI_PAYMENT_CLAIM;
if (!claim) {
  console.error('\nDHALI_PAYMENT_CLAIM is not set in the environment.\n');
  console.error("    export DHALI_PAYMENT_CLAIM='<your claim>'");
  console.error('    npm run windb:schema\n');
  console.error('It is read from the environment only — never pass it as an argument,');
  console.error('where it would land in your shell history.\n');
  process.exit(1);
}

const EP = 'https://run.api.dhali.io/8d0eb161-551f-4471-bae7-ff9ef205d62b/';

async function q(sql) {
  const res = await fetch(EP + '?Payment-Claim=' + encodeURIComponent(claim), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: sql.trim() + '\nFORMAT JSONEachRow',
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

// What we are hunting for, and why — printed against the real schema so the
// answer is "present" or "absent", not "probably".
const WANTED = [
  [/^DestinationTag$/i,        'splits a shared exchange address by account'],
  [/^(Source)?Tag$/i,          'the other half of the same question'],
  [/fee/i,                     'per-transaction cost: the hosting expense'],
  [/remit|amounts/i,           "Remit's multi-asset payload"],
  [/uritoken/i,                'URIToken lease and reputation mechanics'],
  [/taker/i,                   'both sides of a DEX trade'],
  [/memo/i,                    'often carries the purpose of a transfer'],
  [/invoice/i,                 'invoice id, sometimes used like a tag'],
  [/ledger|ctid|index|seq/i,   'stable identity for a transaction'],
  [/hook|emit/i,               'Xahau hook execution — Evernode runs on these'],
];

(async () => {
  for (const table of ['xrpl.transactions', 'xahau.transactions']) {
    console.log(`\n${'='.repeat(74)}\n${table}\n${'='.repeat(74)}`);
    let cols;
    try {
      cols = (await q(`DESCRIBE TABLE ${table}`)).map(r => r.name);
    } catch (e) {
      console.error(`  could not read schema: ${e.message}`);
      continue;
    }
    console.log(`  ${cols.length} column(s)\n`);
    console.log('  FIELDS THIS PROJECT NEEDS:');
    for (const [re, why] of WANTED) {
      const hit = cols.filter(c => re.test(c));
      if (hit.length) {
        console.log(`    FOUND    ${hit.join(', ')}`);
        console.log(`             -> ${why}`);
      } else {
        console.log(`    ABSENT   /${re.source}/  -> ${why}`);
      }
    }
    console.log('\n  ALL COLUMNS:');
    for (let i = 0; i < cols.length; i += 4) {
      console.log('    ' + cols.slice(i, i + 4).map(c => c.padEnd(28)).join(''));
    }
  }
  console.log('');
})().catch(e => { console.error('\n' + e.message + '\n'); process.exit(1); });
