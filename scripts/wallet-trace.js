#!/usr/bin/env node
/**
 * wallet-trace — one wallet's EVR (or XAH) movements, in order, with a
 * running balance, from the local cache. Readonly.
 *
 * WHY. The zero-basis panel says a host "sent 339 EVR it had no lots for".
 * That sentence has four possible causes (coins arrived by a path the engine
 * does not book, arrived from an address it treats as external when it is
 * not, left by a path booked twice, or arrived after they left) and the panel
 * cannot tell them apart. The chronological list can.
 *
 *   npm run trace -- --wallet r4k1jdyTh5          (prefix is enough)
 *   npm run trace -- --wallet r4k1jdyTh5 --asset XAH
 *   npm run trace -- --wallet r4k1jdyTh5 --all     (every row, not just moves)
 *
 * Every wallet in the cache is treated as the taxpayer's own, as the app
 * does; counterparties outside that set are marked EXT.
 */
'use strict';
const { parseArgs, openCache, decodeCurrency } = require('./iou-inventory');

let prefix = null, asset = 'EVR', all = false;
const argv = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--wallet') { prefix = String(process.argv[++i] || ''); continue; }
  if (process.argv[i] === '--asset') { asset = String(process.argv[++i] || 'EVR').toUpperCase(); continue; }
  if (process.argv[i] === '--all') { all = true; continue; }
  argv.push(process.argv[i]);
}
if (!prefix) { console.error('--wallet <address or prefix> is required'); process.exit(2); }
const args = parseArgs(argv);
const db = openCache(args.db);

const own = new Set();
for (const r of db.prepare('SELECT DISTINCT wallet FROM raw_transactions').iterate()) own.add(r.wallet);
const matches = [...own].filter(w => w.startsWith(prefix));
if (matches.length !== 1) {
  console.error(matches.length ? `prefix matches ${matches.length} wallets: ${matches.join(', ')}` : 'no cached wallet starts with ' + prefix);
  process.exit(2);
}
const W = matches[0];
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const pick = (...v) => { for (const x of v) { const s = String(x ?? '').trim(); if (s && s !== '0') return s; } return ''; };
const short = (a) => a ? a.slice(0, 10) + '…' : '';

console.log(`wallet ${W}  asset ${asset}  cache ${args.db}\n`);
console.log('date (UTC)           type              dir   amount            balance        counterparty        note');
let bal = 0, n = 0, inExt = 0, inOwn = 0, outExt = 0, outOwn = 0, shortfall = 0;
const byPeer = new Map();
for (const r of db.prepare(
  "SELECT timestamp, raw_json FROM raw_transactions WHERE wallet = ? AND chain = 'Xahau' ORDER BY timestamp, tx_hash").iterate(W)) {
  let raw; try { raw = JSON.parse(r.raw_json); } catch (e) { continue; }
  if (raw.TransactionResult && raw.TransactionResult !== 'tesSUCCESS') continue;
  const t = raw.TransactionType;
  const cur = decodeCurrency(pick(raw.delivered_amount_currency, raw.Amount_currency));
  let qty = 0;
  if (asset === 'XAH') qty = num(pick(raw.delivered_amount_XRP, raw.Amount_XRP));
  else if (cur === asset) qty = num(pick(raw.delivered_amount_value, raw.Amount_value));
  // Remit legs
  if (t === 'Remit' && qty === 0) {
    let am = raw.Amounts; if (typeof am === 'string') { try { am = JSON.parse(am); } catch (e) { am = null; } }
    for (const e of (Array.isArray(am) ? am : [])) {
      if (asset === 'XAH' && num(e.XRP) > 0) qty += num(e.XRP);
      else if (decodeCurrency(e.token_currency) === asset) qty += num(e.token_value);
    }
  }
  const out = raw.Account === W, inn = raw.Destination === W;
  if (!all && !(qty > 0 && (out || inn))) continue;
  const peer = out ? raw.Destination : raw.Account;
  const peerOwn = own.has(peer);
  let dir = out && inn ? 'self' : out ? 'OUT' : inn ? 'IN' : '—';
  let note = '';
  if (qty > 0 && dir === 'OUT') { bal -= qty; if (peerOwn) outOwn += qty; else outExt += qty; if (bal < -1e-9) { note = `BALANCE NEGATIVE: ${bal.toFixed(6)}`; } }
  if (qty > 0 && dir === 'IN') { bal += qty; if (peerOwn) inOwn += qty; else inExt += qty; }
  if (t === 'URITokenBuy' && qty > 0) note = (note ? note + '; ' : '') + 'URITokenBuy: not booked by the engine';
  if (t === 'Remit' && qty > 0) note = (note ? note + '; ' : '') + 'Remit: engine books only Payments';
  if (qty > 0 && dir !== '—') {
    const p = byPeer.get(peer) || { in: 0, out: 0, n: 0, own: peerOwn };
    p.n++; if (dir === 'IN') p.in += qty; else if (dir === 'OUT') p.out += qty; byPeer.set(peer, p);
  }
  n++;
  console.log(`${String(r.timestamp).slice(0, 19)}  ${String(t).padEnd(17)} ${dir.padEnd(5)} ${qty.toFixed(6).padStart(16)} ${bal.toFixed(6).padStart(14)}  ${short(peer).padEnd(13)} ${peerOwn ? 'own' : 'EXT'}  ${note}`);
}
if (bal < -1e-9) shortfall = -bal;
console.log(`\n${n} row(s) shown.`);
console.log(`in from outside ${inExt.toFixed(6)}   in from own wallets ${inOwn.toFixed(6)}`);
console.log(`out to outside  ${outExt.toFixed(6)}   out to own wallets  ${outOwn.toFixed(6)}`);
console.log(`end balance (from the cache alone) ${bal.toFixed(6)}` + (shortfall ? `  <- ${shortfall.toFixed(6)} more left than ever arrived in the cache` : ''));
console.log('\nby counterparty:');
for (const [p, v] of [...byPeer].sort((a, b) => (b[1].in + b[1].out) - (a[1].in + a[1].out)).slice(0, 15)) {
  console.log(`  ${p}  ${v.own ? 'own' : 'EXT'}  n=${v.n}  in=${v.in.toFixed(6)}  out=${v.out.toFixed(6)}`);
}
db.close();
