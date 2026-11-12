#!/usr/bin/env node
/**
 * affected-sweep — the transactions that moved a wallet's balance while the
 * wallet was neither sender nor destination, read from a ledger node, with
 * the wallet's own balance change computed from each transaction's metadata.
 *
 * WHY. WinDB is asked for rows where Account = wallet OR Destination = wallet.
 * A host's lease income is neither: the TENANT signs a URITokenBuy and the
 * EVR lands on the host inside the tenant's transaction. Measured on one
 * host (Nov 2026): the ledger held 162,782 transactions touching it, the
 * cache 90,864; among the missing, 17,868 URITokenBuys. That host had sent
 * out 300 EVR more than the cache ever saw arrive. Across ~70 hosts that is
 * the 11,546 EVR of "zero basis" the app reported -- unbooked lease income,
 * not a basis problem. The same mechanism hides a resting DEX offer being
 * crossed by someone else's OfferCreate (the XRPL proceeds gap).
 *
 * WHAT IT WRITES. One CSV row per (transaction, asset) where the wallet's
 * holding changed: wallet, time, ledger hash, type, who signed it, currency,
 * issuer, delta (+ = arrived), and the native delta. Positive EVR rows are
 * what the app imports as lease income (Setup -> Ledger-affected
 * transactions). Negative rows and native moves are listed for review.
 *
 *   npm run sweep -- --wallet r4k1jdyTh5                  one host (prefix ok)
 *   npm run sweep -- --all-xahau --out Affected-Xahau.csv  every cached Xahau wallet
 *   npm run sweep -- --all-xahau --resume                  skip wallets already in the file
 *   node scripts/affected-sweep.js --endpoint https://xahau.network/ --page 400 --pause 500
 *
 * Paced for public infrastructure: a busy host is ~160k transactions, ~400
 * pages of 400. The file is appended wallet by wallet, so a stopped run
 * keeps what it had; --resume continues it. Readonly against the cache.
 * Output is gitignored (Affected-*.csv): it carries wallet addresses.
 */
'use strict';
const fs = require('fs');
const { parseArgs, openCache, decodeCurrency } = require('./iou-inventory');
const { xrpDeltaFor, rippleTimeToIso } = require('./verify-xrpl');

// The wallet's IOU holdings change through RippleState entries. Balance is
// stored from the LOW account's point of view: positive means the low account
// holds tokens issued by the high account. So the wallet's own change is the
// balance change when it is the low side, and its negative when it is high.
function iouDeltasFor(meta, account) {
  const outRows = [];
  if (!meta || !Array.isArray(meta.AffectedNodes)) return outRows;
  for (const w of meta.AffectedNodes) {
    const node = w.ModifiedNode || w.CreatedNode || w.DeletedNode;
    if (!node || node.LedgerEntryType !== 'RippleState') continue;
    const fin = node.FinalFields || node.NewFields || {};
    const prev = node.PreviousFields || {};
    const high = fin.HighLimit && fin.HighLimit.issuer, low = fin.LowLimit && fin.LowLimit.issuer;
    if (account !== high && account !== low) continue;
    const bal = fin.Balance || {};
    let after = Number(bal.value || 0), before;
    if (w.CreatedNode) before = 0;
    else if (w.DeletedNode) { before = prev.Balance ? Number(prev.Balance.value) : after; after = 0; }
    else { if (!prev.Balance) continue; before = Number(prev.Balance.value); }
    let d = after - before;
    if (account === high) d = -d;
    if (!Number.isFinite(d) || d === 0) continue;
    outRows.push({ currency: decodeCurrency(bal.currency), issuer: account === high ? low : high, delta: d });
  }
  return outRows;
}


module.exports = { iouDeltasFor };

if (require.main === module) {
let wallets = [], allXahau = false, chain = 'Xahau', endpoint = null, out = null, page = 400, pause = 500, resume = false, since = null;
const argv = [];
for (let i = 0; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--wallet') { wallets.push(String(process.argv[++i] || '')); continue; }
  if (a === '--all-xahau') { allXahau = true; continue; }
  if (a === '--chain') { chain = String(process.argv[++i] || 'Xahau'); continue; }
  if (a === '--endpoint') { endpoint = String(process.argv[++i] || ''); continue; }
  if (a === '--out') { out = String(process.argv[++i] || ''); continue; }
  if (a === '--page') { page = Number(process.argv[++i]); continue; }
  if (a === '--pause') { pause = Number(process.argv[++i]); continue; }
  if (a === '--since') { since = String(process.argv[++i] || ''); continue; }
  if (a === '--resume') { resume = true; continue; }
  argv.push(a);
}
if (chain !== 'Xahau' && chain !== 'XRPL') { console.error('--chain must be Xahau or XRPL'); process.exit(2); }
endpoint = endpoint || process.env.XRPL_RPC || (chain === 'Xahau' ? 'https://xahau.network/' : 'https://xrplcluster.com/');
out = out || `Affected-${chain}.csv`;
if (!wallets.length && !allXahau) { console.error('give --wallet <address or prefix> (repeatable) or --all-xahau'); process.exit(2); }
if (!(page >= 10 && page <= 1000)) { console.error('--page must be 10..1000'); process.exit(2); }

const args = parseArgs(argv);
const db = openCache(args.db);
const cached = new Set();
for (const r of db.prepare('SELECT DISTINCT wallet FROM raw_transactions WHERE chain = ?').iterate(chain)) cached.add(r.wallet);
db.close();

let targets = allXahau ? [...cached].sort() : [];
for (const w of wallets) {
  const m = [...cached].filter(x => x.startsWith(w));
  if (m.length === 1) targets.push(m[0]);
  else if (/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(w)) targets.push(w);   // not cached, but a full address
  else { console.error(`--wallet ${w}: ${m.length ? 'matches ' + m.length + ' cached wallets' : 'no cached wallet starts with it'}`); process.exit(2); }
}
targets = [...new Set(targets)];

const HEAD = 'Wallet,Chain,Timestamp,LedgerHash,Type,Account,Destination,Currency,Issuer,Delta,NativeDelta,Fee';
const done = new Set();
if (fs.existsSync(out)) {
  if (resume) {
    for (const line of fs.readFileSync(out, 'utf8').split('\n').slice(1)) { const w = line.split(',')[0]; if (w) done.add(w); }
  } else {
    console.error(`${out} exists. Use --resume to continue it, or --out for a new file.`); process.exit(2);
  }
} else {
  fs.writeFileSync(out, HEAD + '\n');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function rpc(method, params) {
  let last;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params: [params] }) });
      if (res.status === 429 || res.status === 503 || res.status >= 500) { last = new Error('HTTP ' + res.status); await sleep(3000 * (attempt + 1)); continue; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body = await res.json();
      const r = body.result || {};
      if (r.error === 'actNotFound') return { notFound: true };
      if (['tooBusy', 'slowDown', 'noNetwork', 'noCurrent'].includes(r.error)) { last = new Error(r.error); await sleep(3000 * (attempt + 1)); continue; }
      if (r.error) throw new Error(r.error_message || r.error);
      return r;
    } catch (e) { last = e; await sleep(2000 * (attempt + 1)); }
  }
  throw last || new Error('rpc failed');
}

const csv = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const ts = (tx, entry) => {
  const iso = Number.isFinite(Number(tx.date)) ? rippleTimeToIso(Number(tx.date)) : (entry.close_time_iso || '');
  return String(iso).replace('T', ' ').slice(0, 19);
};

async function sweep(wallet) {
  let marker, pages = 0, txs = 0, kept = 0, oldest = '';
  const byType = new Map(), byCur = new Map();
  const lines = [];
  for (;;) {
    const params = { account: wallet, ledger_index_min: -1, ledger_index_max: -1, binary: false, forward: false, limit: page };
    if (marker) params.marker = marker;
    const r = await rpc('account_tx', params);
    if (r.notFound) { console.log(`  ${wallet}: not on this ledger`); return; }
    pages++;
    let stop = false;
    for (const entry of r.transactions || []) {
      const tx = entry.tx || entry.tx_json || {};
      const meta = entry.meta;
      if (!meta || meta.TransactionResult !== 'tesSUCCESS') continue;
      txs++;
      const when = ts(tx, entry);
      oldest = when;
      if (since && when.slice(0, 10) < since) { stop = true; break; }
      if (tx.Account === wallet || tx.Destination === wallet) continue;   // the app already has these
      const hash = String(entry.hash || tx.hash || '').toUpperCase();
      const ious = iouDeltasFor(meta, wallet);
      const native = xrpDeltaFor(meta, wallet);
      if (!ious.length && !(native && Math.abs(native) >= 0.000001)) continue;
      kept++;
      const t = tx.TransactionType || '?';
      byType.set(t, (byType.get(t) || 0) + 1);
      const fee = Number(tx.Fee || 0) / 1e6;
      if (ious.length) {
        for (const d of ious) {
          byCur.set(d.currency, (byCur.get(d.currency) || 0) + d.delta);
          lines.push([wallet, chain, when, hash, t, tx.Account || '', tx.Destination || '', d.currency, d.issuer, d.delta.toFixed(8), native == null ? '' : native.toFixed(6), fee.toFixed(6)].map(csv).join(','));
        }
      } else {
        byCur.set(chain === 'Xahau' ? 'XAH' : 'XRP', (byCur.get(chain === 'Xahau' ? 'XAH' : 'XRP') || 0) + native);
        lines.push([wallet, chain, when, hash, t, tx.Account || '', tx.Destination || '', '', '', '', native.toFixed(6), fee.toFixed(6)].map(csv).join(','));
      }
    }
    if (pages % 20 === 0) process.stdout.write(`  ${wallet.slice(0, 10)}… page ${pages}: ${txs.toLocaleString()} tx, ${kept.toLocaleString()} affected-only, back to ${oldest.slice(0, 10)}\n`);
    marker = r.marker;
    if (stop || !marker) break;
    await sleep(pause);
  }
  fs.appendFileSync(out, lines.length ? lines.join('\n') + '\n' : '');
  const cur = [...byCur].map(([c, v]) => `${c} ${v >= 0 ? '+' : ''}${v.toFixed(6)}`).join(', ');
  const typ = [...byType].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, n]) => `${t} ${n}`).join(', ');
  console.log(`  ${wallet}: ${txs.toLocaleString()} tx in ${pages} page(s); ${kept.toLocaleString()} affected-only rows written. ${cur}${typ ? '  [' + typ + ']' : ''}`);
}

(async () => {
  console.log(`endpoint ${endpoint}  chain ${chain}  page ${page}  pause ${pause}ms  out ${out}`);
  console.log(`${targets.length} wallet(s)${done.size ? `, ${done.size} already in the file` : ''}\n`);
  const t0 = Date.now();
  let i = 0;
  for (const w of targets) {
    i++;
    if (done.has(w)) continue;
    process.stdout.write(`[${i}/${targets.length}] ${w}\n`);
    try { await sweep(w); } catch (e) { console.log(`  ${w}: FAILED ${e.message} -- rerun with --resume to retry it`); }
  }
  console.log(`\ndone in ${Math.round((Date.now() - t0) / 60000)} min. Import ${out} in the app: Setup -> Ledger-affected transactions.`);
})().catch(e => { console.error(e.message); process.exit(1); });
}
