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

db.close();
