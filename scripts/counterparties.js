#!/usr/bin/env node
/**
 * Every address you sent value to that is not one of your own.
 *
 * WHY THIS EXISTS
 *
 * The engine's only test for "was that a sale?" is whether the destination is
 * in the owned set. Everything else is booked as a taxable disposal at market
 * value. That is how a portfolio worth $15,678 came to report $540,609 of
 * proceeds across eight addresses: most of those sends were not sales.
 *
 * Three things a send to a stranger's address can actually be:
 *
 *   A GIFT            realises NOTHING for the donor -- no gain, no loss, no
 *                     Form 8949 line. The recipient takes carryover basis
 *                     under IRC 1015(a). Over the annual exclusion it needs a
 *                     Form 709, and 20,000 XRP is far over it.
 *   YOUR OWN ACCOUNT  an exchange deposit address is still you. Not a
 *                     disposal -- but whatever was sold ON that exchange IS
 *                     taxable and no ledger can see it.
 *   A REAL SALE       the only one that belongs on Form 8949.
 *
 * Only the taxpayer can tell these apart, and they cannot do that from a
 * number -- they need the list. This is the list: who, how much, how often,
 * when, and whether they ever sent anything back.
 *
 * A destination that has PAID YOU is flagged ROUND TRIP. You do not receive
 * funds back from someone you sold to, so those are nearly always your own
 * account somewhere.
 *
 * READONLY.
 *
 *   npm run counterparties
 *   npm run counterparties -- --min 100
 *   npm run counterparties -- --out Counterparties-2026.csv
 */
'use strict';

const fs = require('fs');
const { parseArgs, openCache, decodeCurrency } = require('./iou-inventory');

let min = 0;
// addr -> recipient NAME. The annual exclusion is measured per PERSON per
// year, not per address, and one person can hold several: two daughters here
// have an XRPL address each AND a Xaman Tangem card each. Grouping by address
// would show four recipients under the limit where there are two over it.
const giftOf = new Map();
const argv = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--min') { min = parseFloat(process.argv[++i]) || 0; continue; }
  if (process.argv[i] === '--gift') {
    for (const pair of String(process.argv[++i] || '').split(',')) {
      const [a, who] = pair.split('=').map(x => (x || '').trim());
      if (a) giftOf.set(a, who || a.slice(0, 10) + '…');
    }
    continue;
  }
  argv.push(process.argv[i]);
}
const args = parseArgs(argv);
const db = openCache(args.db);
const chains = args.chain ? [args.chain] : ['XRPL', 'Xahau'];

const own = new Set();
for (const chain of chains) {
  for (const r of db.prepare(
    'SELECT DISTINCT wallet FROM raw_transactions WHERE chain = ?').iterate(chain)) own.add(r.wallet);
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const pick = (...v) => { for (const x of v) { const s = String(x ?? '').trim(); if (s && s !== '0') return s; } return ''; };

// dest -> { assets: Map(asset -> {qty,n}), first, last, paidUsBack, chains:Set }
const out = new Map();
const giftYear = new Map();   // "recipient|year" -> what they were given
let scanned = 0;

for (const chain of chains) {
  const native = chain === 'XRPL' ? 'XRP' : 'XAH';
  for (const r of db.prepare(
    'SELECT wallet, timestamp, raw_json FROM raw_transactions WHERE chain = ? ORDER BY timestamp').iterate(chain)) {
    let raw; try { raw = JSON.parse(r.raw_json); } catch (e) { continue; }
    if (raw.TransactionResult && raw.TransactionResult !== 'tesSUCCESS') continue;
    scanned++;

    // Inbound from a non-own address: remember it, so a round trip is visible.
    if (raw.Destination === r.wallet && raw.Account && !own.has(raw.Account)) {
      const e = out.get(raw.Account);
      if (e) e.paidUsBack++;
      else out.set(raw.Account, { assets: new Map(), first: '', last: '', paidUsBack: 1,
                                  chains: new Set([chain]), tags: new Map() });
    }
    if (raw.Account !== r.wallet) continue;
    const dest = raw.Destination || '';
    if (!dest || own.has(dest)) continue;

    const cur = decodeCurrency(pick(raw.delivered_amount_currency, raw.Amount_currency));
    const qty = cur ? num(pick(raw.delivered_amount_value, raw.Amount_value))
                    : num(pick(raw.delivered_amount_XRP, raw.Amount_XRP));
    const asset = cur || native;
    if (!qty) continue;

    // A gift realises nothing for the donor, so it never belongs in the
    // disposal list -- but it DOES need tracking by recipient and year for
    // the annual exclusion.
    if (giftOf.has(dest)) {
      const who = giftOf.get(dest);
      const yr = String(r.timestamp).slice(0, 4);
      const k = who + '|' + yr;
      const g = giftYear.get(k) || { who, yr, assets: new Map(), n: 0, addrs: new Set() };
      g.n++; g.addrs.add(dest);
      const ga = g.assets.get(cur || native) || { qty: 0, n: 0 };
      ga.qty += qty; ga.n++;
      g.assets.set(cur || native, ga);
      giftYear.set(k, g);
      continue;
    }

    let e = out.get(dest);
    if (!e) { e = { assets: new Map(), first: '', last: '', paidUsBack: 0, chains: new Set(),
                    tags: new Map() }; out.set(dest, e); }
    // A shared exchange address serves many accounts; the destination tag is
    // what says WHOSE. Two sends to one Coinbase address can be one deposit to
    // yourself and one gift to a relative, and only the tag separates them.
    const tag = String(raw.DestinationTag ?? '').trim();
    if (!e.tags) e.tags = new Map();
    if (tag && tag !== '0') e.tags.set(tag, (e.tags.get(tag) || 0) + 1);
    e.chains.add(chain);
    const a = e.assets.get(asset) || { qty: 0, n: 0 };
    a.qty += qty; a.n++;
    e.assets.set(asset, a);
    const ts = String(r.timestamp);
    if (!e.first || ts < e.first) e.first = ts;
    if (ts > e.last) e.last = ts;
  }
}
db.close();

if (giftYear.size) {
  console.log('\n' + '='.repeat(74));
  console.log('GIFTS BY RECIPIENT AND YEAR — the unit the annual exclusion measures');
  console.log('='.repeat(74));
  const EXCLUSION = { 2021: 15000, 2022: 16000, 2023: 17000, 2024: 18000, 2025: 19000, 2026: 19000 };
  for (const g of [...giftYear.values()].sort((a, b) => a.who.localeCompare(b.who) || a.yr.localeCompare(b.yr))) {
    console.log(`\n  ${g.who} — ${g.yr}   (${g.n} payment(s) across ${g.addrs.size} address(es))`);
    for (const [a, v] of [...g.assets].sort((x, y) => y[1].qty - x[1].qty)) {
      console.log(`      ${v.qty.toLocaleString(undefined, { maximumFractionDigits: 6 }).padStart(20)}  ${a}`);
    }
    const lim = EXCLUSION[g.yr];
    if (lim) console.log(`      annual exclusion for ${g.yr}: $${lim.toLocaleString()} per recipient`);
  }
  console.log('\n  This tool does NOT price any of it — a made-up price is worse than');
  console.log('  none. Value each line at FMV on its own date and compare the RECIPIENT');
  console.log('  YEAR TOTAL, not any single transfer, against the exclusion above.');
  console.log('  Over it, a Form 709 is required: a filing, not a tax bill, drawing');
  console.log('  against the lifetime exemption. Gift-splitting with a spouse doubles');
  console.log('  the exclusion and is not modelled here.');
  console.log('\n  None of these are disposals. You realise no gain giving property away;');
  console.log('  the recipient takes your basis under IRC 1015(a) and your holding');
  console.log('  period tacks onto theirs.');
}

const rows = [...out].filter(([, e]) => e.assets.size);
// Rank by the largest single-asset quantity, so a 20,000 XRP send cannot hide
// beneath a million units of a worthless token.
const rank = (e) => Math.max(...[...e.assets].map(([a, v]) =>
  a === 'XRP' || a === 'XAH' || a === 'EVR' ? v.qty * 1000 : v.qty * 0.000001));
rows.sort((a, b) => rank(b[1]) - rank(a[1]));

const f = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 6 });
console.log(`\nScanned ${scanned.toLocaleString()} successful row(s) across ${own.size} of your wallets.`);
console.log(`${rows.length} address(es) received value from you and are NOT yours.\n`);
console.log('Each one is a GIFT, YOUR OWN account elsewhere, or a REAL SALE. Only you');
console.log('can say which, and only the last belongs on Form 8949.\n');

let shown = 0;
for (const [d, e] of rows) {
  const big = [...e.assets].sort((x, y) => y[1].qty - x[1].qty);
  if (min && !big.some(([, v]) => v.qty >= min)) continue;
  shown++;
  console.log(`${d}${e.paidUsBack ? '   *** ROUND TRIP — paid you back ' + e.paidUsBack + 'x (probably your own account) ***' : ''}`);
  console.log(`    ${e.first.slice(0, 10)} .. ${e.last.slice(0, 10)}   [${[...e.chains].join('+')}]`);
  for (const [a, v] of big.slice(0, 6)) {
    console.log(`    ${f(v.qty).padStart(22)}  ${a.padEnd(18)} in ${v.n} payment(s)`);
  }
  if (big.length > 6) console.log(`    ...and ${big.length - 6} more asset(s)`);
  if (e.tags && e.tags.size) {
    const tg = [...e.tags].sort((x, y) => y[1] - x[1]);
    console.log(`    destination tag(s): ` +
      tg.slice(0, 6).map(([t, n]) => `${t} (x${n})`).join('  ') +
      (tg.length > 6 ? `  ...and ${tg.length - 6} more` : ''));
    if (tg.length > 1) console.log(`      >1 tag = MORE THAN ONE ACCOUNT behind this address. Split it before classifying.`);
  }
  console.log('');
}
console.log(`${shown} shown${min ? ` (min ${min})` : ''}.`);

if (args.csv) {
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = ['Destination,Chains,Asset,Quantity,Payments,First,Last,Round Trip Payments Back,Destination Tags'];
  for (const [d, e] of rows) {
    for (const [a, v] of e.assets) {
      lines.push([d, [...e.chains].join('+'), a, v.qty, v.n,
                  e.first.slice(0, 19), e.last.slice(0, 19), e.paidUsBack,
                  e.tags ? [...e.tags.keys()].join(' ') : ''].map(esc).join(','));
    }
  }
  fs.writeFileSync(args.csv, lines.join('\n') + '\n');
  console.log(`\nWrote ${lines.length - 1} row(s) to ${args.csv}`);
  console.log('NOTE: contains addresses. Gitignored; keep it local.');
}
