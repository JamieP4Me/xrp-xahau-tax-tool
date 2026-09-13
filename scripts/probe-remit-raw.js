#!/usr/bin/env node
/**
 * Is the Remit `Amounts` payload real, or a corpse?
 *
 * THE QUESTION THIS ANSWERS
 *
 * `npm run probe:xahau -- --type Remit` prints `Amounts: [object Object]` on
 * all 174 rows. That string is ambiguous and the ambiguity matters, because
 * the two readings need opposite fixes:
 *
 *   ALIVE   raw_json holds a real array, e.g. "Amounts":[{"currency":"XXX",
 *           "value":"120","issuer":"r..."}], and it is only the PROBE that
 *           flattened it -- String([{...}]) is "[object Object]". The data is
 *           in the cache and derivableAmount() just has to read it.
 *
 *   DEAD    raw_json holds the literal string "Amounts":"[object Object]" --
 *           the object was stringified upstream, before it ever reached us.
 *           Nothing in this repo can recover it and no re-sync will help.
 *
 * The probe cannot tell these apart because it parses the JSON and then
 * prints the parsed value. So this looks at the stored TEXT and never parses
 * it for the verdict, which is the only way to see which one is true.
 *
 * READONLY, always. It writes nothing and books nothing.
 *
 *   npm run probe:remit
 */
'use strict';

const { parseArgs, openCache } = require('./iou-inventory');

const args = parseArgs(process.argv);
const db = openCache(args.db);
console.log(`cache: ${args.db}\n`);

const rows = db.prepare(
  `SELECT wallet, timestamp, raw_json FROM raw_transactions
    WHERE chain = 'Xahau' AND raw_json LIKE '%"TransactionType":"Remit"%'
    ORDER BY timestamp`).all();

console.log(`=== ${rows.length} Remit row(s) ===\n`);

// -- 1. the verdict, counted over every row -------------------------------
let dead = 0, alive = 0, absent = 0, other = 0;
const samples = [];
for (const r of rows) {
  const t = r.raw_json;
  const i = t.indexOf('"Amounts"');
  if (i < 0) { absent++; continue; }
  const after = t.slice(i + 9).replace(/^\s*:\s*/, '');
  if (after.startsWith('"[object Object]"')) dead++;
  else if (after.startsWith('[') || after.startsWith('{')) {
    alive++;
    if (samples.length < 3) samples.push({ ts: r.timestamp, text: t.slice(i, i + 400) });
  } else { other++; if (samples.length < 3) samples.push({ ts: r.timestamp, text: t.slice(i, i + 400) }); }
}

console.log('  how "Amounts" is actually stored in raw_json:');
console.log(`    ${String(alive).padStart(5)}  real array/object   <- ALIVE: derivableAmount() can read it`);
console.log(`    ${String(dead).padStart(5)}  "[object Object]"   <- DEAD: stringified before we got it`);
console.log(`    ${String(other).padStart(5)}  some other scalar`);
console.log(`    ${String(absent).padStart(5)}  key not present at all`);

// -- 2. one whole row, verbatim, so the shape is seen and not inferred ----
if (rows.length) {
  const r = rows[rows.length - 1];
  console.log('\n=== newest Remit row, raw_json VERBATIM (first 1600 chars) ===\n');
  console.log(r.raw_json.slice(0, 1600));
}

if (samples.length) {
  console.log('\n=== the Amounts payload itself, verbatim ===');
  for (const s of samples) console.log(`\n  --- ${String(s.ts).slice(0, 19)} ---\n  ${s.text}`);
}

// -- 3. every distinct key on a Remit row, so nothing is assumed ----------
const keys = new Map();
for (const r of rows) {
  let raw; try { raw = JSON.parse(r.raw_json); } catch { continue; }
  for (const k of Object.keys(raw)) keys.set(k, (keys.get(k) || 0) + 1);
}
console.log('\n=== every key present on a Remit row ===');
for (const [k, n] of [...keys].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${k}`);
}


// -- 4. what is actually IN those Amounts arrays --------------------------
//
// This is the part that decides the tax treatment, and the part that would
// otherwise get guessed at. An entry looks like:
//
//   {"XRP":0,"token_value":999.997655,"token_issuer":"r...","token_currency":"LXH"}
//
// so an entry is either a NATIVE leg (XRP populated) or a TOKEN leg
// (token_value + token_currency + token_issuer). Those book differently: a
// native leg is priceable in the engine today; a token leg is an IOU
// acquisition and must NOT be priced as though it were XAH.
const { decodeCurrency } = require('./iou-inventory');

const byCur = new Map();
const byYear = new Map();
const bySender = new Map();
let entries = 0, nativeLegs = 0, tokenLegs = 0, emptyLegs = 0;
let nativeTotal = 0, multi = 0, withURIToken = 0, outbound = 0;

const NUL = String.fromCharCode(0);
const clean = (v) => String(v ?? '').split(NUL).join('').trim();
const bump = (map, key, ts, amt, issuer) => {
  const c = map.get(key) || { n: 0, total: 0, issuers: new Set(), lo: 'Z', hi: '' };
  c.n++; c.total += amt;
  if (issuer) c.issuers.add(issuer);
  c.lo = ts < c.lo ? ts : c.lo;
  c.hi = ts > c.hi ? ts : c.hi;
  map.set(key, c);
};

for (const r of rows) {
  let raw; try { raw = JSON.parse(r.raw_json); } catch { continue; }
  const ts = String(r.timestamp);
  const year = ts.slice(0, 4);
  const arr = Array.isArray(raw.Amounts) ? raw.Amounts : [];
  if (arr.length > 1) multi++;
  if (clean(raw.URITokenIDs) || clean(raw.MintURIToken_URI) || clean(raw.URITokenID)) withURIToken++;
  if (raw.Account === r.wallet) outbound++;

  const y = byYear.get(year) || { n: 0, native: 0, token: 0 };
  y.n++;
  bySender.set(raw.Account, (bySender.get(raw.Account) || 0) + 1);

  for (const e of arr) {
    entries++;
    const xrp = parseFloat(e.XRP);
    const tv = parseFloat(e.token_value);
    const cur = decodeCurrency(String(e.token_currency ?? ''));
    if (Number.isFinite(xrp) && xrp > 0) {
      nativeLegs++; nativeTotal += xrp; y.native++;
      bump(byCur, '(native XAH)', ts, xrp, null);
    } else if (Number.isFinite(tv) && tv > 0 && cur) {
      tokenLegs++; y.token++;
      bump(byCur, cur, ts, tv, String(e.token_issuer ?? ''));
    } else {
      emptyLegs++;
    }
  }
  byYear.set(year, y);
}

console.log('\n=== what the Remits actually carry ===');
console.log(`  ${entries} Amounts entr(ies) across ${rows.length} row(s)`);
console.log(`    ${nativeLegs} native XAH leg(s), ${nativeTotal.toFixed(6)} XAH total`);
console.log(`    ${tokenLegs} token leg(s)`);
console.log(`    ${emptyLegs} leg(s) carrying neither`);
console.log(`  ${multi} row(s) carry MORE THAN ONE entry`);
console.log(`  ${withURIToken} row(s) also carry a URIToken (an NFT leg this does not value)`);
console.log(`  ${outbound} row(s) OUTBOUND (you are the Account); ${rows.length - outbound} inbound`);

console.log('\n=== by asset ===');
for (const [c, v] of [...byCur].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${c.padEnd(14)} ${String(v.n).padStart(4)} leg(s)  ${v.total.toFixed(6).padStart(18)}  ` +
              `${String(v.issuers.size).padStart(2)} issuer(s)  ${v.lo.slice(0, 10)} .. ${v.hi.slice(0, 10)}`);
}

console.log('\n=== by year ===');
for (const [y, v] of [...byYear].sort()) {
  console.log(`  ${y}  ${String(v.n).padStart(4)} row(s)   native legs ${String(v.native).padStart(4)}   token legs ${String(v.token).padStart(4)}`);
}

console.log('\n=== by sender (who remitted to you) ===');
for (const [a, n] of [...bySender].sort((x, z) => z[1] - x[1])) {
  console.log(`  ${String(n).padStart(4)}  ${a}`);
}

db.close();
