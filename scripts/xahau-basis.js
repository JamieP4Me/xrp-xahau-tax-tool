#!/usr/bin/env node
/**
 * Basis schedule for onexah tokens: what each one cost, or what it earned.
 *
 * DECISIONS THIS IMPLEMENTS (recorded with the user, 2026-11-09)
 *
 *   A token received from a pool takes as its basis what was GIVEN UP for
 *   it, valued that day -- never its unit count times the XAH price. The
 *   consideration is not always XAH: LEV and ELP were bought with EVR, XLP
 *   with XXX, LXH with XAH.
 *
 *   XXX (and any other token with no dollar market) is valued through the
 *   XAH rate observed in the user's OWN PURCHASES of it -- e.g. 1,000 XAH
 *   for 84.23 XXX on 2026-06-11, so 1 XXX = 11.87 XAH that day -- times
 *   XAH's dollar price. Every such value cites the purchase it came from.
 *
 *   PURCHASES ONLY, NOT SALES. The first version also took "reverse swaps"
 *   -- token sent, XAH back from the same address within the window -- as
 *   rates. On the real cache every one of them was wrong: XXX bought at
 *   8.14-11.87 XAH, "sold" at 30.46-38.57, a 3x gap no pool spread
 *   explains. The three "sales" summed to exactly 7,961.74 XAH, every XAH
 *   the XLP pool ever sent back: liquidity WITHDRAWN, landing beside an
 *   unrelated small XXX payment. Those rates inflated XXX reward income
 *   from about $620 to $1,108 and XLP basis from about $264 to $547. The
 *   same rule produced an EVR rate of 0.0000. Nothing in the cache tells a
 *   sale from a coincidentally timed withdrawal, so the rule is gone.
 *
 *   A token that arrived with nothing paid for it is a reward: ordinary
 *   income at fair market value on receipt, and that value is its basis.
 *
 * HOW A RECEIPT IS CLASSIFIED, from the measured shape (npm run lp:pairing)
 *
 *   PURCHASE  an outbound to the SAME counterparty within --window seconds
 *             before the receipt (default 120). Real pairs measured 0-9 s.
 *             Cross-counterparty proximity is never a pairing: the probe
 *             found 23 such "matches" and they were coincidences.
 *   REVIEW    a same-counterparty outbound exists, but 2-10 minutes before.
 *             Not guessed at; left for a human.
 *   REWARD    no outbound to that counterparty in the window at all.
 *   MULTI     a purchase whose receipt carried several tokens at once. The
 *             total cost is known; how to split it across them is not.
 *
 * WHAT IT REFUSES TO DO
 *
 *   It never prices a date the app's price tables do not cover without
 *   saying so (flag STALE), never uses a swap rate without citing it, and
 *   never assigns a basis it cannot derive. Native XAH legs are excluded:
 *   their treatment is deferred to the preparer.
 *
 * Prices are DAILY HIGH, read from the app's own tables in
 * renderer/index.html, because that is what the app uses for basis and
 * income. Two price sources on one return would be its own inconsistency.
 *
 * READONLY against the cache. Writes one CSV (gitignored) and a summary.
 *
 *   npm run xahau:basis
 *   npm run xahau:basis -- --year 2026 --out Xahau-Basis-2026.csv
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, openCache, decodeCurrency } = require('./iou-inventory');

const ROOT = path.join(__dirname, '..');
let year = 2026, out = null, windowSec = 120, reviewSec = 600, htmlPath = path.join(ROOT, 'renderer', 'index.html');
const shared = [process.argv[0], process.argv[1]];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--year') year = Number(process.argv[++i]);
  else if (a === '--out') out = process.argv[++i];
  else if (a === '--window') windowSec = Number(process.argv[++i]);
  else if (a === '--review') reviewSec = Number(process.argv[++i]);
  else if (a === '--html') htmlPath = process.argv[++i];
  else if (a === '--db') shared.push(a, process.argv[++i]);
  else { console.error('Unknown argument: ' + a); process.exit(1); }
}
if (!Number.isInteger(year)) { console.error('--year must be a year'); process.exit(1); }
out = out || `Xahau-Basis-${year}.csv`;
const args = parseArgs(shared);

// -- prices: the app's own tables, nothing else -----------------------------
function loadTable(html, name) {
  const i = html.indexOf('const ' + name + ' = {');
  if (i < 0) throw new Error(name + ' not found in ' + htmlPath);
  const start = html.indexOf('{', i);
  let depth = 0, j = start;
  for (; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') { depth--; if (depth === 0) break; }
  }
  return JSON.parse(html.slice(start, j + 1));
}
const html = fs.readFileSync(htmlPath, 'utf8');
const TABLES = { XAH: loadTable(html, 'XAH_PRICES'), EVR: loadTable(html, 'EVR_PRICES') };
const KEYS = {}, LAST = {};
for (const [k, t] of Object.entries(TABLES)) { KEYS[k] = Object.keys(t).sort(); LAST[k] = KEYS[k][KEYS[k].length - 1]; }

const DAY = 86400000;
const dkOf = (ms) => new Date(ms).toISOString().slice(0, 10);
// Exact day if present; otherwise the nearest day, with the distance and a
// STALE flag when the date lies beyond the table's last day.
function priceOf(asset, dk) {
  const t = TABLES[asset], keys = KEYS[asset];
  if (t[dk] && Number.isFinite(t[dk].high)) return { usd: t[dk].high, used: dk, days: 0, stale: false };
  let best = null, bestD = Infinity;
  for (const k of keys) {
    const d = Math.abs(Date.parse(k + 'T00:00:00Z') - Date.parse(dk + 'T00:00:00Z')) / DAY;
    if (d < bestD) { best = k; bestD = d; }
  }
  return { usd: t[best].high, used: best, days: Math.round(bestD), stale: dk > LAST[asset] };
}

const NUL = String.fromCharCode(0);
const clean = (v) => String(v == null ? '' : v).split(NUL).join('').trim();
const tsMs = (t) => Date.parse(String(t).replace(' ', 'T').slice(0, 23) + 'Z');
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const money = (n) => (Math.round(n * 100) / 100).toFixed(2);
const qtyS = (n) => String(Math.round(n * 1e6) / 1e6);
const amounts = (raw) => {
  let a = raw.Amounts;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch (e) { a = null; } }
  return Array.isArray(a) ? a : [];
};
function legsOf(raw) {
  const out = [];
  if (clean(raw.TransactionType) === 'Remit') {
    for (const e of amounts(raw)) {
      if (!e || typeof e !== 'object') continue;
      const x = num(e.XRP);
      if (x > 0) { out.push({ asset: 'XAH', qty: x }); continue; }
      const q = num(e.token_value), c = decodeCurrency(clean(e.token_currency));
      if (q > 0 && c) out.push({ asset: c, qty: q });
    }
  } else {
    const x = num(raw.delivered_amount_XRP) || num(raw.Amount_XRP);
    if (x > 0) out.push({ asset: 'XAH', qty: x });
    const c = decodeCurrency(clean(raw.delivered_amount_currency) || clean(raw.Amount_currency));
    const q = num(raw.delivered_amount_value) || num(raw.Amount_value);
    if (c && q > 0) out.push({ asset: c, qty: q });
  }
  return out;
}

// -- 1. events, and receipts classified --------------------------------------
const db = openCache(args.db);
const wallets = db.prepare(
  "SELECT DISTINCT wallet FROM raw_transactions WHERE chain = 'Xahau' AND tx_type = 'Remit'").all().map(r => r.wallet);
const lo = `${year}-01-01`, hi = `${year + 1}-01-01`;
const W = windowSec * 1000;
const classified = [];
const rateObs = {};
const obs = (asset, ms, xahPerUnit, how) => {
  if (!(xahPerUnit > 0)) return;
  (rateObs[asset] = rateObs[asset] || []).push({ ms, dk: dkOf(ms), xahPerUnit, how });
};

for (const wallet of wallets) {
  const events = [];
  for (const r of db.prepare(
    "SELECT timestamp, raw_json FROM raw_transactions WHERE wallet = ? AND chain = 'Xahau' " +
    "AND tx_type IN ('Payment','Remit','OfferCreate') AND timestamp >= ? AND timestamp < ? ORDER BY timestamp"
  ).iterate(wallet, lo, hi)) {
    let raw; try { raw = JSON.parse(r.raw_json); } catch (e) { continue; }
    const res = clean(raw.TransactionResult);
    if (res && res !== 'tesSUCCESS') continue;
    const legs = legsOf(raw);
    if (!legs.length) continue;
    const dir = raw.Account === wallet && raw.Destination !== wallet ? 'out'
              : raw.Destination === wallet && raw.Account !== wallet ? 'in' : null;
    if (!dir) continue;
    const ms = tsMs(r.timestamp);
    events.push({ ms, ts: String(r.timestamp).slice(0, 19), type: clean(raw.TransactionType), dir,
                  peer: dir === 'out' ? raw.Destination : raw.Account, legs, used: false });
  }
  const outsByPeer = new Map();
  for (const e of events) if (e.dir === 'out') {
    if (!outsByPeer.has(e.peer)) outsByPeer.set(e.peer, []);
    outsByPeer.get(e.peer).push(e);
  }
  const receipts = events.filter(e => e.dir === 'in' && e.type === 'Remit' && e.legs.some(l => l.asset !== 'XAH'));
  for (const r of receipts) {
    const cands = (outsByPeer.get(r.peer) || []).filter(o => o.ms <= r.ms && !o.used);
    const near = cands.length ? cands[cands.length - 1] : null;
    const dt = near ? (r.ms - near.ms) / 1000 : null;
    const tokens = r.legs.filter(l => l.asset !== 'XAH');
    let cls = 'REWARD', pay = null;
    if (near && dt <= windowSec) { near.used = true; pay = near; cls = tokens.length > 1 ? 'MULTI' : 'PURCHASE'; }
    else if (near && dt <= reviewSec) cls = 'REVIEW';
    classified.push({ r, cls, pay, dt, tokens });
    // Forward swap: XAH given, one token back -> an XAH rate for that token.
    if (cls === 'PURCHASE' && pay.legs.every(l => l.asset === 'XAH')) {
      const xah = pay.legs.reduce((s, l) => s + l.qty, 0);
      obs(tokens[0].asset, r.ms, xah / tokens[0].qty, `${qtyS(xah)} XAH -> ${qtyS(tokens[0].qty)} ${tokens[0].asset}`);
    }
  }
  // No "reverse swap" rates. A token sent and XAH received soon after looks
  // like a sale and, on this cache, never was one -- see the header. Rates
  // come only from purchases above, where the pairing itself is evidence.
}
db.close();

// -- 2. valuation --------------------------------------------------------------
function rateFor(asset, ms) {
  const list = rateObs[asset];
  if (!list || !list.length) return null;
  let best = null, bd = Infinity;
  for (const o of list) { const d = Math.abs(o.ms - ms); if (d < bd) { bd = d; best = o; } }
  return { ...best, days: Math.round(bd / DAY) };
}
function valueLeg(leg, ms) {
  const dk = dkOf(ms);
  if (leg.asset === 'XAH' || leg.asset === 'EVR') {
    const p = priceOf(leg.asset, dk);
    return { usd: leg.qty * p.usd, stale: p.stale, farRate: false,
             note: `${qtyS(leg.qty)} ${leg.asset} x $${p.usd} (${leg.asset} high ${p.used}${p.days ? ', ' + p.days + 'd from ' + dk : ''})` };
  }
  const r = rateFor(leg.asset, ms);
  if (!r) return { usd: null, stale: false, farRate: false, note: `no XAH rate for ${leg.asset}: you never bought it with XAH` };
  const p = priceOf('XAH', dk);
  return { usd: leg.qty * r.xahPerUnit * p.usd, stale: p.stale, farRate: r.days > 14,
           note: `${qtyS(leg.qty)} ${leg.asset} x ${r.xahPerUnit.toFixed(6)} XAH (own purchase ${r.dk}: ${r.how}` +
                 `${r.days ? ', ' + r.days + 'd away' : ''}) x $${p.usd} (XAH high ${p.used})` };
}

// -- 3. rows ---------------------------------------------------------------------
const rows = [];
for (const c of classified) {
  const base = { date: c.r.ts, cls: c.cls, from: c.r.peer, delay: c.dt == null ? '' : Math.round(c.dt) };
  if (c.cls === 'PURCHASE' || c.cls === 'MULTI') {
    const vals = c.pay.legs.map(l => valueLeg(l, c.pay.ms));
    const known = vals.every(v => v.usd != null);
    const cost = known ? vals.reduce((s, v) => s + v.usd, 0) : null;
    const flags = [];
    if (!known) flags.push('CONSIDERATION-UNVALUED');
    if (vals.some(v => v.stale)) flags.push('STALE-PRICE');
    if (vals.some(v => v.farRate)) flags.push('RATE->14d');
    if (c.cls === 'MULTI') flags.push('MULTI-TOKEN-RECEIPT');
    for (const t of c.tokens) {
      const basis = c.cls === 'PURCHASE' ? cost : null;
      rows.push({ ...base, qty: t.qty, asset: t.asset,
                  consideration: c.pay.legs.map(l => `${qtyS(l.qty)} ${l.asset}`).join(' + '),
                  paidAt: c.pay.ts, considerationUsd: cost, basis,
                  perUnit: basis != null ? basis / t.qty : null, income: null,
                  notes: vals.map(v => v.note).join(' | ') +
                         (c.cls === 'MULTI' ? ` | receipt carried ${c.tokens.length} tokens; total cost not split` : ''),
                  flags });
    }
  } else if (c.cls === 'REWARD') {
    for (const t of c.tokens) {
      const v = valueLeg(t, c.r.ms);
      const flags = [];
      if (v.usd == null) flags.push('UNVALUED');
      if (v.stale) flags.push('STALE-PRICE');
      if (v.farRate) flags.push('RATE->14d');
      rows.push({ ...base, qty: t.qty, asset: t.asset, consideration: '', paidAt: '', considerationUsd: null,
                  basis: v.usd, perUnit: v.usd != null ? v.usd / t.qty : null, income: v.usd, notes: v.note, flags });
    }
  } else {
    for (const t of c.tokens) {
      rows.push({ ...base, qty: t.qty, asset: t.asset, consideration: '', paidAt: '', considerationUsd: null,
                  basis: null, perUnit: null, income: null,
                  notes: `a same-counterparty outbound ${Math.round(c.dt)}s earlier: outside the ${windowSec}s pairing window`,
                  flags: ['REVIEW'] });
    }
  }
}

// -- 4. write the schedule and summarise it ------------------------------------
const q = (v) => '"' + String(v == null ? '' : v).split('"').join('""') + '"';
const head = ['Date (UTC)', 'Class', 'Received Qty', 'Received Asset', 'From', 'Consideration Given',
              'Consideration Sent At', 'Pair Delay (s)', 'Consideration USD', 'Basis USD', 'Basis per Unit USD',
              'Income USD', 'Valuation Notes', 'Flags'];
const lines = [head.map(q).join(',')];
for (const r of rows) {
  lines.push([r.date, r.cls, qtyS(r.qty), r.asset, r.from, r.consideration, r.paidAt, r.delay,
              r.considerationUsd != null ? money(r.considerationUsd) : '', r.basis != null ? money(r.basis) : '',
              r.perUnit != null ? r.perUnit.toFixed(8) : '', r.income != null ? money(r.income) : '',
              r.notes, r.flags.join(' ')].map(q).join(','));
}
fs.writeFileSync(out, lines.join('\n') + '\n');

const fmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 6 });
console.log(`cache: ${args.db}`);
console.log(`tax year ${year} · ${wallets.length} wallet(s) with Remit activity · pairing window ${windowSec}s, review to ${reviewSec}s`);
console.log(`prices: daily HIGH from the app's own tables · XAH table ends ${LAST.XAH}, EVR table ends ${LAST.EVR}\n`);

const byCls = {};
for (const c of classified) byCls[c.cls] = (byCls[c.cls] || 0) + 1;
console.log('--- receipts by class ---');
for (const k of ['PURCHASE', 'MULTI', 'REWARD', 'REVIEW']) console.log(`  ${k.padEnd(9)} ${String(byCls[k] || 0).padStart(5)}`);

const byAsset = {};
for (const r of rows) {
  const a = byAsset[r.asset] = byAsset[r.asset] || { qty: 0, nP: 0, basis: 0, nR: 0, income: 0, unvalued: 0 };
  a.qty += r.qty;
  if (r.cls === 'PURCHASE' && r.basis != null) { a.nP++; a.basis += r.basis; }
  else if (r.cls === 'REWARD' && r.income != null) { a.nR++; a.income += r.income; }
  else a.unvalued++;
}
console.log('\n--- by asset ---');
console.log('  asset        received      purchases     basis USD    rewards    income USD   unvalued');
let tB = 0, tI = 0;
for (const [k, a] of Object.entries(byAsset).sort((x, y) => y[1].basis + y[1].income - x[1].basis - x[1].income)) {
  tB += a.basis; tI += a.income;
  console.log(`  ${k.padEnd(6)} ${fmt(a.qty).padStart(15)} ${String(a.nP).padStart(10)} ${money(a.basis).padStart(13)} ` +
              `${String(a.nR).padStart(10)} ${money(a.income).padStart(13)} ${String(a.unvalued).padStart(10)}`);
}
console.log(`  ${'TOTAL'.padEnd(6)} ${''.padStart(15)} ${''.padStart(10)} ${money(tB).padStart(13)} ${''.padStart(10)} ${money(tI).padStart(13)}`);

console.log('\n--- XAH rates taken from your own purchases (what XXX, RVN and others are valued by) ---');
if (!Object.keys(rateObs).length) console.log('  (none observed)');
for (const [k, list] of Object.entries(rateObs).sort()) {
  const rs = list.map(o => o.xahPerUnit);
  const ds = list.map(o => o.dk).sort();
  console.log(`  ${k.padEnd(6)} ${String(list.length).padStart(3)} purchase(s)  ${ds[0]} .. ${ds[ds.length - 1]}  ` +
              `${Math.min(...rs).toFixed(4)} - ${Math.max(...rs).toFixed(4)} XAH per unit`);
  // The guard that would have caught the reverse-swap error on its first
  // run: a 3x spread between rates for one asset was sitting in plain sight
  // in the summary, and nothing said so. A real token can move 2x in a few
  // weeks; when its own observed rates disagree by more, look before using.
  const spread = Math.max(...rs) / Math.min(...rs);
  if (rs.length > 1 && spread > 2) {
    console.log(`         WARNING: ${k} rates differ ${spread.toFixed(1)}x. Check these purchases ` +
                `before relying on anything valued by them (see the CSV notes).`);
  }
}

const fl = {};
for (const r of rows) for (const f of r.flags) fl[f] = (fl[f] || 0) + 1;
console.log('\n--- flags (each row is in the CSV with its reason) ---');
if (!Object.keys(fl).length) console.log('  (none)');
for (const [k, v] of Object.entries(fl)) console.log(`  ${k.padEnd(24)} ${v}`);
console.log(`\nwritten: ${out}  (${rows.length} rows)`);
console.log('Native XAH legs are excluded on purpose: their treatment is deferred to the preparer.');
