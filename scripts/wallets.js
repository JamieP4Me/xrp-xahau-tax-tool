#!/usr/bin/env node
/**
 * Every wallet the cache actually holds, and what is missing from it.
 *
 * WHY THIS EXISTS
 *
 * The whole ledger rests on one assumption: that the set of fetched wallets
 * IS the taxpayer's set of wallets. Everything downstream inherits it.
 *
 *   - A wallet NOT in the set has its internal transfers scored as real
 *     disposals, because the own-wallet rule cannot recognise an address it
 *     has never seen. With 54 Evernode hosts and their reputation addresses
 *     shuffling stake continuously, one missing address invents disposals by
 *     the thousand.
 *   - A wallet not in the set also contributes no balance, so a reconciliation
 *     fails with no indication of where the gap is. Measured: the EVR ledger
 *     nets +77,508 while the monitored hosts hold about 6,700.
 *
 * So this lists what is there, with volume and coverage dates, and answers
 * membership directly for an address you name.
 *
 * READONLY.
 *
 *   npm run wallets
 *   npm run wallets -- --find rXXXXXXXX
 *   npm run wallets -- --chain Xahau
 */
'use strict';

const { parseArgs, openCache } = require('./iou-inventory');

let find = null;
const argv = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--find') { find = String(process.argv[++i] || '').trim(); continue; }
  argv.push(process.argv[i]);
}
const args = parseArgs(argv);
const db = openCache(args.db);
const chains = args.chain ? [args.chain] : ['XRPL', 'Xahau'];

const all = new Map();   // address -> {chains:Set, n, first, last, seenAsCounterparty}
for (const chain of chains) {
  for (const r of db.prepare(
    `SELECT wallet, COUNT(*) n, MIN(timestamp) lo, MAX(timestamp) hi
       FROM raw_transactions WHERE chain = ? GROUP BY wallet`).iterate(chain)) {
    const e = all.get(r.wallet) || { chains: new Set(), n: 0, first: 'zzzz', last: '' };
    e.chains.add(chain); e.n += r.n;
    if (String(r.lo) < e.first) e.first = String(r.lo);
    if (String(r.hi) > e.last) e.last = String(r.hi);
    all.set(r.wallet, e);
  }
}

if (find) {
  const e = all.get(find);
  console.log('');
  if (e) {
    console.log(`IN THE CACHE: ${find}`);
    console.log(`  ${e.n.toLocaleString()} row(s) on ${[...e.chains].join(' + ')}`);
    console.log(`  ${e.first.slice(0, 19)} .. ${e.last.slice(0, 19)}`);
    console.log('\n  Transfers to and from this address are therefore recognised as');
    console.log('  internal and are NOT scored as disposals.');
  } else {
    console.log(`NOT IN THE CACHE: ${find}`);
    console.log('\n  This address was never fetched, so nothing it holds appears in any');
    console.log('  balance, and every transfer between it and a fetched wallet is being');
    console.log('  scored as a REAL DISPOSAL to an outside party. Both halves are wrong:');
    console.log('  the holdings are missing and the disposals are invented.');
    // Is it at least visible as a counterparty of a fetched wallet?
    let asSrc = 0, asDst = 0;
    for (const chain of chains) {
      for (const r of db.prepare(
        'SELECT raw_json FROM raw_transactions WHERE chain = ?').iterate(chain)) {
        let raw; try { raw = JSON.parse(r.raw_json); } catch (e2) { continue; }
        if (raw.Account === find) asSrc++;
        if (raw.Destination === find) asDst++;
      }
    }
    console.log(`\n  It DOES appear as a counterparty in the cached rows:`);
    console.log(`    ${asSrc.toLocaleString()} row(s) where it is the Account (it paid a fetched wallet)`);
    console.log(`    ${asDst.toLocaleString()} row(s) where it is the Destination (a fetched wallet paid it)`);
    if (asSrc + asDst > 0) {
      console.log('\n  Every one of those is currently mis-scored. Add it to the wallet');
      console.log('  list and re-fetch.');
    }
  }
  db.close();
  process.exit(0);
}

console.log(`\n${all.size} distinct wallet(s) in the cache\n`);
const rows = [...all].sort((a, b) => b[1].n - a[1].n);
console.log('  rows        chains        coverage                     address');
console.log('-'.repeat(96));
for (const [a, e] of rows) {
  console.log(`  ${String(e.n).padStart(9)}  ${[...e.chains].join('+').padEnd(12)}` +
              `${e.first.slice(0, 10)} .. ${e.last.slice(0, 10)}   ${a}`);
}
const thin = rows.filter(([, e]) => e.n < 5);
if (thin.length) {
  console.log(`\n  ${thin.length} wallet(s) have fewer than 5 rows. A real wallet with almost no`);
  console.log('  history is usually a fetch that did not complete, not an idle account.');
}
db.close();
