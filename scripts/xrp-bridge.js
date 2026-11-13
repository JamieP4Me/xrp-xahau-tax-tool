#!/usr/bin/env node
/**
 * XRP balance bridge for ONE XRPL wallet: why the app's holdings figure
 * differs from the balance the wallet actually shows.
 *
 * The app's Holdings tab counts what its lot ledger still holds. The ledger
 * itself knows what the balance IS. This script walks the wallet's full
 * history from a full-history node, reads the XRP change the ledger applied
 * in every transaction (AccountRoot Balance before/after in the metadata —
 * the canonical number), and groups it by transaction type and by the
 * wallet's role in it:
 *
 *   sent        the wallet signed it (Account)
 *   received    the wallet is its Destination
 *   affected    neither — someone else's transaction moved this wallet's XRP
 *               (their OfferCreate/Payment crossed one of this wallet's
 *               resting offers; the WinDB fetch never sees these rows)
 *
 * The buckets sum to the live balance (checked), so each bucket says how
 * many XRP a class of transaction accounts for. Beside each bucket: how many
 * of those transactions the local cache holds, and how many XRP the ones it
 * lacks moved. That is the completeness gap in XRP, by cause.
 *
 * Readonly. Opens the cache readonly; writes nothing. Public cluster by
 * default (slow, polite); DHALI_PAYMENT_CLAIM in the environment switches to
 * the paid endpoint exactly as verify-xrpl.js does — never on argv.
 *
 *   npm run xrp:bridge -- --wallet rG9RHCRS          (prefix is enough)
 *   npm run xrp:bridge -- --wallet rG9RHCRS --out Bridge-rG9RHCRS.csv
 */
'use strict';

const fs = require('fs');
const { parseArgs, openCache } = require('./iou-inventory');
const { rpc, xrpDeltaFor, feeXrp, rippleTimeToIso, ledgerHashOf, PAID } = require('./verify-xrpl');

let prefix = '', out = null;
const argv = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--wallet') { prefix = String(process.argv[++i] || ''); continue; }
  if (process.argv[i] === '--out') { out = String(process.argv[++i] || ''); continue; }
  argv.push(process.argv[i]);
}
if (!prefix) { console.error('--wallet <address or prefix> is required'); process.exit(2); }
const args = parseArgs(argv);
const db = openCache(args.db);

const own = new Set();
for (const r of db.prepare("SELECT DISTINCT wallet FROM raw_transactions WHERE chain = 'XRPL'").iterate()) own.add(r.wallet);
const matches = [...own].filter(w => w.startsWith(prefix));
if (matches.length !== 1) {
  console.error(matches.length ? `prefix matches ${matches.length} wallets: ${matches.join(', ')}` : 'no cached XRPL wallet starts with ' + prefix);
  process.exit(2);
}
const W = matches[0];

// Every ledger hash the cache holds for this wallet.
const cached = new Set();
let synthetic = 0;
for (const r of db.prepare("SELECT tx_hash FROM raw_transactions WHERE chain = 'XRPL' AND wallet = ?").iterate(W)) {
  const h = ledgerHashOf(r.tx_hash);
  if (h) cached.add(h); else synthetic++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAUSE_MS = PAID ? 120 : 1200;

(async () => {
  console.log(`wallet ${W}  endpoint ${PAID ? 'Dhali (paid)' : 'xrplcluster.com (public, slow)'}  cache ${args.db}`);
  console.log(`cache holds ${cached.size} ledger hashes for this wallet` + (synthetic ? ` (+${synthetic} synthetic ids, unmatchable)` : '') + '\n');

  const info = await rpc('account_info', { account: W, ledger_index: 'validated' });
  const live = info.notFound ? null : Number(info.account_data.Balance) / 1e6;
  const reserve = info.notFound ? null : info.account_data.OwnerCount;

  const buckets = new Map();   // key -> { n, xrp, missN, missXrp, fee }
  const rows = [];
  let marker, pages = 0, total = 0, sum = 0, unknown = 0;
  for (;;) {
    const params = { account: W, ledger_index_min: -1, ledger_index_max: -1, binary: false, forward: true, limit: 100 };
    if (marker) params.marker = marker;
    const res = await rpc('account_tx', params);
    if (res.notFound) { console.log('account not found on the ledger'); return; }
    for (const e of res.transactions || []) {
      const tx = e.tx || e.tx_json || {};
      const meta = e.meta || {};
      if (meta.TransactionResult && meta.TransactionResult !== 'tesSUCCESS') continue;
      const hash = String(tx.hash || e.hash || '').toUpperCase();
      const delta = xrpDeltaFor(meta, W);
      if (delta == null) { unknown++; continue; }
      const role = tx.Account === W ? 'sent' : tx.Destination === W ? 'received' : 'affected';
      const type = tx.TransactionType || '?';
      const key = `${type}|${role}`;
      const b = buckets.get(key) || { type, role, n: 0, xrp: 0, missN: 0, missXrp: 0, fee: 0 };
      b.n++; b.xrp += delta;
      if (role === 'sent') b.fee += feeXrp(tx);
      const inCache = cached.has(hash);
      if (!inCache) { b.missN++; b.missXrp += delta; }
      buckets.set(key, b);
      total++; sum += delta;
      if (out) rows.push([rippleTimeToIso(tx.date), type, role, delta.toFixed(6), inCache ? 'cached' : 'MISSING', hash]);
    }
    pages++;
    if (pages % 20 === 0) process.stdout.write(`  …${total} transactions read\r`);
    if (!res.marker) break;
    marker = res.marker;
    await sleep(PAUSE_MS);
  }

  const list = [...buckets.values()].sort((a, b) => Math.abs(b.xrp) - Math.abs(a.xrp));
  console.log(`${total} successful transactions touched this wallet's XRP` + (unknown ? ` (${unknown} with no readable balance change skipped)` : '') + '\n');
  console.log('type              role       tx count      XRP moved (ledger)   not in cache   XRP in those');
  console.log('─'.repeat(96));
  let missTotal = 0;
  for (const b of list) {
    missTotal += b.missXrp;
    console.log(`${b.type.padEnd(17)} ${b.role.padEnd(9)} ${String(b.n).padStart(9)} ${b.xrp.toFixed(6).padStart(22)} ${String(b.missN).padStart(13)} ${b.missXrp.toFixed(6).padStart(15)}`);
  }
  console.log('─'.repeat(96));
  console.log(`${'sum of ledger changes'.padEnd(37)} ${sum.toFixed(6).padStart(22)} ${' '.repeat(13)} ${missTotal.toFixed(6).padStart(15)}`);
  if (live != null) {
    console.log(`${'live balance (account_info)'.padEnd(37)} ${live.toFixed(6).padStart(22)}   owner count ${reserve}`);
    const gap = live - sum;
    console.log(Math.abs(gap) < 0.001 ? 'bridge closes: the buckets explain the live balance exactly.'
      : `bridge does NOT close by ${gap.toFixed(6)} XRP — the node may lack part of the history, or ${unknown} changes were unreadable.`);
  }
  const fees = list.reduce((s, b) => s + b.fee, 0);
  console.log(`\nfees paid by this wallet, included in the "sent" buckets: ${fees.toFixed(6)} XRP`);
  console.log(`XRP moved by transactions the cache never saw: ${missTotal.toFixed(6)} (negative = left the wallet unseen)`);
  console.log('\nHow to read it against the Holdings tab: the app can only book what is cached. XRP that');
  console.log('left in "affected" rows (others crossing your offers) or in types the engine does not book');
  console.log('(AMMDeposit under the standard setting, fees, OfferCreate legs) stays in its holdings figure.');
  if (out) {
    fs.writeFileSync(out, 'date,type,role,xrp_delta,cache,hash\n' + rows.map(r => r.join(',')).join('\n') + '\n');
    console.log(`\nper-transaction detail written to ${out}`);
  }
})().catch((e) => { console.error(e && e.message || e); process.exit(1); });
