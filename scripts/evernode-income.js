#!/usr/bin/env node
/**
 * Evernode host activity: how much EVR actually came in, and from what.
 *
 * WHY THIS EXISTS
 *
 * 53 Evernode hosts, each holding a lease URIToken, rented in one-hour slots
 * for a fraction of an EVR. That is the explanation for 749,529 URITokenBuy
 * rows and it changes what this engagement is about: hosting revenue is
 * ORDINARY INCOME, recognised at fair market value when received, and at that
 * transaction count it is almost certainly larger than every token question
 * in this project combined.
 *
 * But the cache says something odd: the taxpayer's wallet is the *Account* on
 * all 749,529 URITokenBuys. On Evernode the TENANT buys the lease, so if these
 * were inbound rentals the tenant should be the Account and these wallets
 * should not be. Either the host re-acquires the lease token after each lease
 * (making the host the buyer), or the cache is attributing rows to the wrong
 * account. Those have opposite tax meanings -- money out versus money in --
 * so this measures both sides instead of assuming either.
 *
 * READONLY. Reports; books nothing; prices nothing.
 *
 *   npm run evernode
 *   npm run evernode -- --wallet rXXXX      one host
 */
'use strict';

const { parseArgs, openCache, decodeCurrency } = require('./iou-inventory');

let only = null;
const gifts = new Set();
const argv = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--wallet') { only = String(process.argv[++i] || ''); continue; }
  // A gift realises nothing for the donor. Without this the girls' gift
  // wallets sit inside "sent to third parties" as if they were sales.
  if (process.argv[i] === '--gift') {
    String(process.argv[++i] || '').split(',').map(x => x.trim()).filter(Boolean)
      .forEach(x => gifts.add(x));
    continue;
  }
  argv.push(process.argv[i]);
}
const args = parseArgs(argv);
const db = openCache(args.db);

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const pick = (...v) => { for (const x of v) { const s = String(x ?? '').trim(); if (s && s !== '0') return s; } return ''; };

// EVERY wallet in the cache belongs to the same taxpayer -- the 54 hosts,
// their reputation addresses, the lot, all owned by a single-member
// disregarded LLC. So EVR moving between any two of them is an internal
// transfer and NOT income, however many times it happens.
//
// The first version of this script filtered only self-payments
// (Account === Destination) and counted everything else as revenue. That
// reported 583,994 EVR of "hosting income" when four of the top eight
// "payers" were this taxpayer's own node01-node04 addresses. Same mistake as
// the inventory's own-wallet bug, made again an hour after fixing it.
const own = new Set();
for (const r of db.prepare(
  'SELECT DISTINCT wallet FROM raw_transactions WHERE chain = ?').iterate('Xahau')) {
  own.add(r.wallet);
}

const evrIn = new Map();      // year -> {n, evr}  THIRD PARTY only
const evrInternal = new Map();// year -> {n, evr}  wallet to wallet, not income
const evrOut = new Map();
const buyByWallet = new Map(); // wallet -> {n, evrPaid}
const buyByYear = new Map();
const counterIn = new Map();   // who pays us EVR
// Every transaction a host SIGNS costs a fee, and a fleet that heartbeats
// around the clock signs millions of them. At that volume the fee burn is a
// real operating cost, and nobody has ever counted it.
const feeByYear = new Map();
const evrGift = new Map();
const outDest = new Map();     // third-party destination -> what we sent it
const reg750 = [];             // exactly 750 EVR: the host registration fee
let rows = 0, feeKeyFound = false, signed = 0;

for (const r of db.prepare(
  'SELECT wallet, timestamp, raw_json FROM raw_transactions WHERE chain = ?').iterate('Xahau')) {
  let raw; try { raw = JSON.parse(r.raw_json); } catch (e) { continue; }
  if (raw.TransactionResult && raw.TransactionResult !== 'tesSUCCESS') continue;
  if (only && r.wallet !== only) continue;
  rows++;
  const yr = String(r.timestamp).slice(0, 4);
  if (raw.Account === r.wallet) {
    signed++;
    // Fee_Drops, from DESCRIBE TABLE. The first cut of this guessed at
    // 'Fee_XRP' / 'Fee' an hour after running the schema probe that named the
    // real column, so it reported "the cache stores NO fee field" against a
    // cache that had just been re-synced to include it. Same mistake the
    // renderer made with 'Fee', and with Asset_currency before that: the
    // safeCols guard silently drops a column name that does not exist, so a
    // wrong guess looks exactly like an absent field.
    for (const k of ['Fee_Drops']) {
      if (raw[k] == null || String(raw[k]).trim() === '') continue;
      feeKeyFound = true;
      const e = feeByYear.get(yr) || { n: 0, fee: 0, key: k };
      e.n++; e.fee += num(raw[k]) / 1e6;   // drops -> whole XAH
      feeByYear.set(yr, e);
      break;
    }
  }
  const cur = decodeCurrency(pick(raw.delivered_amount_currency, raw.Amount_currency));
  const val = num(pick(raw.delivered_amount_value, raw.Amount_value));

  if (raw.TransactionType === 'URITokenBuy') {
    const c = decodeCurrency(raw.Amount_currency);
    const v = num(raw.Amount_value);
    const w = buyByWallet.get(r.wallet) || { n: 0, evr: 0, cur: new Set() };
    w.n++; if (c === 'EVR') w.evr += v; w.cur.add(c || 'XAH(native)');
    buyByWallet.set(r.wallet, w);
    const y = buyByYear.get(yr) || { n: 0, evr: 0 };
    y.n++; if (c === 'EVR') y.evr += v;
    buyByYear.set(yr, y);
    continue;
  }
  if (raw.TransactionType !== 'Payment' || cur !== 'EVR' || !val) continue;
  if (raw.Destination === r.wallet && raw.Account !== r.wallet) {
    if (own.has(raw.Account)) {
      const e = evrInternal.get(yr) || { n: 0, evr: 0 }; e.n++; e.evr += val; evrInternal.set(yr, e);
    } else {
      const e = evrIn.get(yr) || { n: 0, evr: 0 }; e.n++; e.evr += val; evrIn.set(yr, e);
      counterIn.set(raw.Account, (counterIn.get(raw.Account) || 0) + 1);
    }
  } else if (raw.Account === r.wallet && raw.Destination !== r.wallet && !own.has(raw.Destination)) {
    if (gifts.has(raw.Destination)) {
      const g = evrGift.get(yr) || { n: 0, evr: 0 }; g.n++; g.evr += val; evrGift.set(yr, g);
      continue;
    }
    const e = evrOut.get(yr) || { n: 0, evr: 0 }; e.n++; e.evr += val; evrOut.set(yr, e);
    // Outbound EVR is not one thing. Host registration costs 750 EVR and buys
    // an asset; a sale is proceeds; a protocol burn is a cost. They are
    // different lines on a return, so split them by size and destination
    // rather than reporting one total.
    const d = outDest.get(raw.Destination) || { n: 0, evr: 0, sizes: new Map() };
    d.n++; d.evr += val;
    const bucket = val === 750 ? '750 (host registration)'
      : val >= 1000 ? '>=1000'
      : val >= 100 ? '100-999'
      : val >= 1 ? '1-99' : '<1';
    d.sizes.set(bucket, (d.sizes.get(bucket) || 0) + 1);
    outDest.set(raw.Destination, d);
    if (val === 750) reg750.push({ yr, dest: raw.Destination, wallet: r.wallet });
  }
}
db.close();

const f = (n, d = 6) => n.toLocaleString(undefined, { maximumFractionDigits: d });
console.log(`\nScanned ${rows.toLocaleString()} successful Xahau row(s).\n`);

console.log(`${own.size} wallet(s) in this cache, ALL one taxpayer. Movements between them`);
console.log('are internal transfers and are reported separately below, not as income.\n');
console.log('EVR RECEIVED FROM THIRD PARTIES — candidate hosting revenue');
console.log('-'.repeat(74));
console.log('  year        payments              EVR');
let tIn = 0, nIn = 0;
for (const y of [...evrIn.keys()].sort()) {
  const e = evrIn.get(y); tIn += e.evr; nIn += e.n;
  console.log(`  ${y}   ${String(e.n).padStart(12)}   ${f(e.evr).padStart(16)}`);
}
console.log(`  TOTAL ${String(nIn).padStart(12)}   ${f(tIn).padStart(16)}`);

console.log('\nEVR MOVED BETWEEN YOUR OWN WALLETS — NOT income, NOT a disposal');
console.log('-'.repeat(74));
let tInt = 0, nInt = 0;
for (const y of [...evrInternal.keys()].sort()) {
  const e = evrInternal.get(y); tInt += e.evr; nInt += e.n;
  console.log(`  ${y}   ${String(e.n).padStart(12)}   ${f(e.evr).padStart(16)}`);
}
console.log(`  TOTAL ${String(nInt).padStart(12)}   ${f(tInt).padStart(16)}`);

console.log('\nEVR SENT TO THIRD PARTIES (you -> outside)');
console.log('-'.repeat(74));
let tOut = 0, nOut = 0;
for (const y of [...evrOut.keys()].sort()) {
  const e = evrOut.get(y); tOut += e.evr; nOut += e.n;
  console.log(`  ${y}   ${String(e.n).padStart(12)}   ${f(e.evr).padStart(16)}`);
}
console.log(`  TOTAL ${String(nOut).padStart(12)}   ${f(tOut).padStart(16)}`);
console.log(`\n  NET EVR: ${f(tIn - tOut)}`);

if (evrGift.size) {
  console.log('\nEVR GIFTED — realises nothing for you (IRC 1015 carryover basis)');
  console.log('-'.repeat(74));
  let tg = 0, ng = 0;
  for (const y of [...evrGift.keys()].sort()) {
    const e = evrGift.get(y); tg += e.evr; ng += e.n;
    console.log(`  ${y}   ${String(e.n).padStart(12)}   ${f(e.evr).padStart(16)}`);
  }
  console.log(`  TOTAL ${String(ng).padStart(12)}   ${f(tg).padStart(16)}`);
  console.log('  Check each recipient-year against the annual exclusion for Form 709.');
} else if (!gifts.size) {
  console.log('\n  NOTE: no --gift addresses supplied, so any gift to the daughters is');
  console.log('  counted above as a third-party send. A gift is not a disposal.');
}

console.log('\nWHERE THE OUTBOUND EVR WENT — these are different tax lines');
console.log('-'.repeat(74));
for (const [d, e] of [...outDest].sort((a, b) => b[1].evr - a[1].evr).slice(0, 10)) {
  console.log(`  ${f(e.evr).padStart(14)} EVR in ${String(e.n).padStart(6)} payment(s)  ${d.slice(0, 22)}…`);
  console.log(`                 ${[...e.sizes].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}x${v}`).join('  ')}`);
}
console.log(`\n  Payments of EXACTLY 750 EVR (the host registration fee): ${reg750.length}`);
if (reg750.length) {
  const byYear = new Map();
  for (const r2 of reg750) byYear.set(r2.yr, (byYear.get(r2.yr) || 0) + 1);
  for (const y of [...byYear.keys()].sort()) {
    console.log(`    ${y}: ${byYear.get(y)} registration(s) = ${f(byYear.get(y) * 750)} EVR`);
  }
  console.log(`    TOTAL ${f(reg750.length * 750)} EVR capitalised into host registrations`);
}

console.log('\nURITokenBuy — where YOUR wallet is the Account (the buyer)');
console.log('-'.repeat(74));
console.log('  year           buys        EVR paid');
for (const y of [...buyByYear.keys()].sort()) {
  const e = buyByYear.get(y);
  console.log(`  ${y}   ${String(e.n).padStart(12)}   ${f(e.evr).padStart(16)}`);
}
console.log(`\n  across ${buyByWallet.size} wallet(s); top 12 by count:`);
for (const [w, e] of [...buyByWallet].sort((a, b) => b[1].n - a[1].n).slice(0, 12)) {
  console.log(`    ${w.slice(0, 16)}…  ${String(e.n).padStart(8)} buys  ${f(e.evr).padStart(14)} EVR` +
              `  [${[...e.cur].join(',')}]`);
}

console.log('\nTRANSACTION FEES on rows YOUR wallets signed');
console.log('-'.repeat(74));
if (!feeKeyFound) {
  console.log(`  ${signed.toLocaleString()} signed transaction(s), but the cache stores NO fee`);
  console.log('  field. Every one of them cost XAH. That is a deductible operating');
  console.log('  expense of the hosting business and it is invisible here — it needs a');
  console.log('  re-fetch or a ledger query to quantify.');
} else {
  console.log('  year         signed         fee (XAH)');
  let tf = 0, nf = 0;
  for (const y of [...feeByYear.keys()].sort()) {
    const e = feeByYear.get(y); tf += e.fee; nf += e.n;
    console.log(`  ${y}   ${String(e.n).padStart(12)}   ${f(e.fee).padStart(14)}`);
  }
  console.log(`  TOTAL ${String(nf).padStart(12)}   ${f(tf).padStart(14)}`);
}

console.log(`\n  ${counterIn.size} distinct address(es) have PAID you EVR. Top 8:`);
for (const [a, n] of [...counterIn].sort((x, y) => y[1] - x[1]).slice(0, 8)) {
  console.log(`    ${String(n).padStart(8)}  ${a.slice(0, 20)}…`);
}
console.log('');
