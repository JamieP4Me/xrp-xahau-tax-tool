#!/usr/bin/env node
/**
 * What is missing from the cache, and why — measured, not guessed.
 *
 * Four questions this answers against the real cache, READONLY:
 *
 *   1. FAILED TRANSACTIONS. A transaction that fails still burns its fee.
 *      The engine returns early on anything that is not tesSUCCESS, so those
 *      fees are cached and never counted -- both as a deductible business
 *      expense and as micro-disposals of XAH.
 *
 *   2. MEMOS. Fetched since v1.9.0 and never read. A Memo is frequently the
 *      only thing that separates a gift from a sale, and Remit proved that a
 *      nested field can sit in the cache for versions without being noticed.
 *
 *   3. DATE FLOORS. If a wallet's earliest cached row is long after the
 *      wallet was in use, its opening basis is missing. Evernode host
 *      registrations (750 EVR each) predate the Xahau cache entirely.
 *
 *   4. THIRD-PARTY ROWS. Every fetch is `Account = w OR Destination = w`. A
 *      transaction where the wallet is neither -- someone else consuming your
 *      resting offer, someone else accepting your NFT offer -- is invisible.
 *      This counts how many cached rows are NOT one of those two, which
 *      should be zero, and that zero is the point: it is the shape of the
 *      query, not of your activity.
 *
 *   npm run gaps
 */
'use strict';

const { parseArgs, openCache } = require('./iou-inventory');

const args = parseArgs(process.argv);
const db = openCache(args.db);
console.log(`cache: ${args.db}\n`);

const NUL = String.fromCharCode(0);
const clean = (v) => String(v ?? '').split(NUL).join('').trim();
const n2 = (x) => Number(x).toLocaleString(undefined, { maximumFractionDigits: 6 });

// ── 1. failed transactions and the fee they still burned ─────────────────
const failed = new Map();     // chain|year -> {n, drops}
const okCount = new Map();
let memoRows = 0, memoSamples = [], thirdParty = 0, totalRows = 0;
const firstSeen = new Map();  // wallet|chain -> earliest timestamp
const typeCount = new Map();

for (const r of db.prepare(
  'SELECT wallet, chain, timestamp, raw_json FROM raw_transactions').iterate()) {
  totalRows++;
  let raw; try { raw = JSON.parse(r.raw_json); } catch { continue; }
  const yr = String(r.timestamp).slice(0, 4);
  const key = `${r.chain}|${yr}`;
  const res = clean(raw.TransactionResult);
  const drops = parseFloat(raw.Fee_Drops);

  if (res && res !== 'tesSUCCESS') {
    const e = failed.get(key) || { n: 0, drops: 0, codes: new Map() };
    e.n++;
    if (Number.isFinite(drops)) e.drops += drops;
    e.codes.set(res, (e.codes.get(res) || 0) + 1);
    failed.set(key, e);
  } else {
    okCount.set(key, (okCount.get(key) || 0) + 1);
  }

  const t = clean(raw.TransactionType) || '(none)';
  const tk = `${r.chain}|${t}`;
  typeCount.set(tk, (typeCount.get(tk) || 0) + 1);

  // Memos: a real array survives the cache, exactly as Amounts does.
  const m = raw.Memos;
  if (Array.isArray(m) ? m.length : clean(m)) {
    memoRows++;
    if (memoSamples.length < 5) memoSamples.push({ ts: r.timestamp, type: t, memos: m });
  }

  if (raw.Account !== r.wallet && raw.Destination !== r.wallet) thirdParty++;

  const fk = `${r.wallet}|${r.chain}`;
  const prev = firstSeen.get(fk);
  if (!prev || r.timestamp < prev) firstSeen.set(fk, r.timestamp);
}

console.log('=== 1. FAILED TRANSACTIONS — cached, never booked, fee still burned ===');
if (!failed.size) console.log('  (none)');
let totDrops = 0, totFailed = 0;
for (const [k, v] of [...failed].sort()) {
  const [chain, yr] = k.split('|');
  totDrops += v.drops; totFailed += v.n;
  const top = [...v.codes].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([c, n]) => `${c}:${n}`).join(' ');
  console.log(`  ${chain.padEnd(6)} ${yr}  ${String(v.n).padStart(7)} failed  ` +
              `${n2(v.drops / 1e6).padStart(14)} ${chain === 'Xahau' ? 'XAH' : 'XRP'} in fees   ${top}`);
}
console.log(`  TOTAL ${totFailed.toLocaleString()} failed transaction(s), ${n2(totDrops / 1e6)} in fees`);
console.log('  These are a deductible business cost AND disposals of the fee asset.');

console.log('\n=== 2. MEMOS — fetched since v1.9.0, never read by the engine ===');
console.log(`  ${memoRows.toLocaleString()} of ${totalRows.toLocaleString()} cached row(s) carry a Memo.`);
if (memoRows) {
  console.log('  A Memo is often the only thing separating a gift from a sale.');
  for (const s of memoSamples) {
    let txt = '';
    try { txt = JSON.stringify(s.memos).slice(0, 200); } catch (e) { txt = '(unserialisable)'; }
    console.log(`    ${String(s.ts).slice(0, 19)}  ${s.type}  ${txt}`);
  }
}

console.log('\n=== 3. THIRD-PARTY ROWS — transactions where you are neither side ===');
console.log(`  ${thirdParty.toLocaleString()} of ${totalRows.toLocaleString()} cached rows.`);
console.log('  Every fetch is "Account = wallet OR Destination = wallet", so this');
console.log('  number reflects the QUERY, not your activity. Someone else consuming');
console.log('  your resting offer, or accepting your NFT offer, is a transaction you');
console.log('  are party to and are not named in — and it never enters this cache.');

console.log('\n=== 4. EARLIEST CACHED ROW PER WALLET — where basis may start missing ===');
const byChain = {};
for (const [k, ts] of firstSeen) {
  const [wallet, chain] = k.split('|');
  (byChain[chain] = byChain[chain] || []).push({ wallet, ts });
}
for (const chain of Object.keys(byChain).sort()) {
  const list = byChain[chain].sort((a, b) => (a.ts < b.ts ? -1 : 1));
  console.log(`\n  ${chain}: ${list.length} wallet(s), earliest ${String(list[0].ts).slice(0, 10)}, ` +
              `latest first-row ${String(list[list.length - 1].ts).slice(0, 10)}`);
  const buckets = new Map();
  for (const w of list) buckets.set(String(w.ts).slice(0, 7), (buckets.get(String(w.ts).slice(0, 7)) || 0) + 1);
  for (const [mo, c] of [...buckets].sort()) console.log(`      ${mo}  ${String(c).padStart(4)} wallet(s) start here`);
}

console.log('\n=== 5. TYPES IN THE CACHE, PER CHAIN ===');
for (const [k, v] of [...typeCount].sort((a, b) => b[1] - a[1])) {
  const [chain, t] = k.split('|');
  console.log(`  ${chain.padEnd(6)} ${String(v).padStart(9)}  ${t}`);
}

db.close();
