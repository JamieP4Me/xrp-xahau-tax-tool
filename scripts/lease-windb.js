#!/usr/bin/env node
/**
 * lease-windb — the hosts' inbound lease purchases from WinDB, in the same
 * CSV shape as scripts/affected-sweep.js, in minutes instead of hours.
 *
 * HOW. A tenant's URITokenBuy names the lease token it bought. The host named
 * that same token earlier, when it created the sell offer for it. So the
 * tenant transactions for a host are: every URITokenBuy whose URITokenID the
 * host once put up for sale. That is one query per host, server side, if
 * WinDB carries the URITokenID column. This script checks first and stops
 * with a clear message if it does not; then the ledger sweep is the only way.
 *
 * WHAT IS DIFFERENT FROM THE SWEEP. The amount is WinDB's recorded Amount on
 * the buy, not the host's exact balance change read from ledger metadata.
 * For a lease that is the offer price, a few hundredths of an EVR, and the
 * two agree in every case anyone has checked; the sweep remains the exact
 * source. GenesisMint (XAH balance rewards) and anything else that is not a
 * lease are NOT found by this route.
 *
 *   export DHALI_PAYMENT_CLAIM='<claim>'      read from the environment only
 *   npm run lease:windb -- --all-xahau
 *   npm run lease:windb -- --wallet r4k1jdyTh5 --out Affected-Xahau.csv
 *
 * Output is gitignored (Affected-*.csv). Import it in Setup -> Ledger-affected
 * transactions, exactly like the sweep's file. Readonly against the cache.
 */
'use strict';
const fs = require('fs');
const { parseArgs, openCache, decodeCurrency } = require('./iou-inventory');

const claim = process.env.DHALI_PAYMENT_CLAIM;
if (!claim) {
  console.error("\nDHALI_PAYMENT_CLAIM is not set.\n    export DHALI_PAYMENT_CLAIM='<your claim>'\n    npm run lease:windb -- --all-xahau\n");
  console.error('It is read from the environment only, never passed as an argument.\n');
  process.exit(1);
}
const EP = 'https://run.api.dhali.io/8d0eb161-551f-4471-bae7-ff9ef205d62b/';
async function q(sql) {
  const res = await fetch(EP + '?Payment-Claim=' + encodeURIComponent(claim), {
    method: 'POST', headers: { 'Content-Type': 'text/plain', 'Payment-Claim': claim }, body: sql.trim() + '\nFORMAT JSONEachRow',
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.replace(/[^\x20-\x7E\n]/g, '?').slice(0, 300)}`);
  return text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

let wallets = [], allXahau = false, out = 'Affected-Xahau.csv', resume = false;
const argv = [];
for (let i = 0; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--wallet') { wallets.push(String(process.argv[++i] || '')); continue; }
  if (a === '--all-xahau') { allXahau = true; continue; }
  if (a === '--out') { out = String(process.argv[++i] || out); continue; }
  if (a === '--resume') { resume = true; continue; }
  argv.push(a);
}
if (!wallets.length && !allXahau) { console.error('give --wallet <address or prefix> (repeatable) or --all-xahau'); process.exit(2); }
const args = parseArgs(argv);
const db = openCache(args.db);
const cached = new Set();
for (const r of db.prepare("SELECT DISTINCT wallet FROM raw_transactions WHERE chain = 'Xahau'").iterate()) cached.add(r.wallet);
db.close();
let targets = allXahau ? [...cached].sort() : [];
for (const w of wallets) {
  const m = [...cached].filter(x => x.startsWith(w));
  if (m.length === 1) targets.push(m[0]);
  else if (/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(w)) targets.push(w);
  else { console.error(`--wallet ${w}: ${m.length ? 'matches ' + m.length + ' cached wallets' : 'no cached wallet starts with it'}`); process.exit(2); }
}
targets = [...new Set(targets)];

const HEAD = 'Wallet,Chain,Timestamp,LedgerHash,Type,Account,Destination,Currency,Issuer,Delta,NativeDelta,Fee';
const done = new Set();
if (fs.existsSync(out)) {
  if (!resume) { console.error(`${out} exists. Use --resume to add to it (wallets already in it are skipped), or --out for a new file.`); process.exit(2); }
  for (const line of fs.readFileSync(out, 'utf8').split('\n').slice(1)) { const w = line.split(',')[0]; if (w) done.add(w); }
} else fs.writeFileSync(out, HEAD + '\n');

const csv = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const NUL = String.fromCharCode(0);
const clean = (v) => String(v == null ? '' : v).split(NUL).join('').trim();
const idOf = (r) => {
  const h = clean(r.TransactionHash).toUpperCase();
  if (/^[0-9A-F]{64}$/.test(h)) return h;
  const c = clean(r.CTID).toUpperCase();
  return /^[0-9A-F]{16}$/.test(c) ? c : '';
};

(async () => {
  const cols = (await q('DESCRIBE TABLE xahau.transactions')).map(r => r.name);
  const tokenCol = cols.find(c => /^uritokenid$/i.test(c));
  if (!tokenCol) {
    console.log('WinDB xahau.transactions has no URITokenID column. Columns mentioning URI/Token:');
    console.log('  ' + (cols.filter(c => /uri|token/i.test(c)).join(', ') || '(none)'));
    console.log('\nThis route is not available; use the ledger sweep: npm run sweep -- --all-xahau --resume --parallel 3');
    process.exit(1);
  }
  const hasCtid = cols.includes('CTID');
  console.log(`WinDB has ${tokenCol}${hasCtid ? ' and CTID' : ''}. ${targets.length} wallet(s)${done.size ? `, ${done.size} already in ${out}` : ''}.\n`);
  const t0 = Date.now();
  let total = 0, totalEvr = 0;
  for (const [i, w] of targets.entries()) {
    if (done.has(w)) continue;
    const esc = w.replace(/'/g, '');
    let rows;
    try {
      rows = await q(`
        SELECT ${hasCtid ? 'CTID, ' : ''}TransactionHash, Timestamp, Account, Amount_XRP, Amount_value, Amount_currency, Amount_issuer, ${tokenCol}
        FROM xahau.transactions
        WHERE TransactionType = 'URITokenBuy' AND TransactionResult = 'tesSUCCESS' AND Account != '${esc}'
          AND ${tokenCol} IN (
            SELECT DISTINCT ${tokenCol} FROM xahau.transactions
            WHERE Account = '${esc}' AND TransactionType = 'URITokenCreateSellOffer' AND TransactionResult = 'tesSUCCESS')
        ORDER BY Timestamp`);
    } catch (e) {
      console.log(`[${i + 1}/${targets.length}] ${w}: query failed: ${e.message}`);
      continue;
    }
    const lines = [];
    let evr = 0, noId = 0;
    for (const r of rows) {
      const id = idOf(r);
      if (!id) { noId++; continue; }
      const ts = clean(r.Timestamp).replace('T', ' ').slice(0, 19);
      const cur = decodeCurrency(clean(r.Amount_currency));
      const val = parseFloat(clean(r.Amount_value));
      const nat = parseFloat(clean(r.Amount_XRP));
      if (cur && val > 0) {
        if (cur === 'EVR') evr += val;
        lines.push([w, 'Xahau', ts, id, 'URITokenBuy', clean(r.Account), '', cur, clean(r.Amount_issuer), val.toFixed(8), '', ''].map(csv).join(','));
      } else if (nat > 0) {
        lines.push([w, 'Xahau', ts, id, 'URITokenBuy', clean(r.Account), '', '', '', '', nat.toFixed(6), ''].map(csv).join(','));
      }
    }
    fs.appendFileSync(out, lines.length ? lines.join('\n') + '\n' : '');
    total += lines.length; totalEvr += evr;
    console.log(`[${i + 1}/${targets.length}] ${w}: ${rows.length.toLocaleString()} tenant buy(s), ${lines.length.toLocaleString()} written, EVR +${evr.toFixed(6)}${noId ? `, ${noId} with no usable id skipped` : ''}`);
  }
  console.log(`\n${total.toLocaleString()} row(s), EVR +${totalEvr.toFixed(6)} in ${Math.round((Date.now() - t0) / 1000)}s -> ${out}`);
  console.log('Import it in the app: Setup -> Ledger-affected transactions. Amounts are WinDB\'s recorded Amount, not ledger metadata.');
})().catch(e => { console.error('\n' + e.message + '\n'); process.exit(1); });
