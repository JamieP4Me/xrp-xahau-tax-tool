#!/usr/bin/env node
/**
 * Why does the Xahau side of the IOU inventory have only 75 rows?
 *
 * THE QUESTION THIS ANSWERS
 *
 * The inventory finds 42 outbound XXX payments and ZERO inbound ones. You
 * cannot send a token you never received, so one of two things is true:
 *
 *   PARSER GAP   the rows are in the cache, but Xahau stores an IOU amount
 *                under different keys than the XRPL rows this tool was
 *                measured against, so nonNativeLegs() reads past them.
 *
 *   FETCH GAP    the rows are not in the cache at all, and the Xahau history
 *                is incomplete.
 *
 * Those need opposite fixes, and guessing wrong wastes a rebuild. So this
 * looks at the raw JSON directly, without going through the leg parser, and
 * reports which one it is.
 *
 * READONLY, always. It writes nothing and books nothing.
 *
 *   npm run probe:xahau
 *   npm run probe:xahau -- --asset XXX
 *   npm run probe:xahau -- --db /path/to/tax-data.sqlite3
 */
'use strict';

const { parseArgs, openCache, decodeCurrency, BOOKED } = require('./iou-inventory');

// parseArgs() rejects anything it does not know, so --asset is pulled out
// before it ever sees the list.
let asset = null;
let wantType = null;
const argv = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--asset') { asset = String(process.argv[++i] || '').toUpperCase(); continue; }
  if (process.argv[i] === '--type') { wantType = String(process.argv[++i] || ''); continue; }
  argv.push(process.argv[i]);
}
const args = parseArgs(argv);
const CHAIN = args.chain || 'Xahau';

const db = openCache(args.db);
console.log('cache: ' + args.db + '\n');

// -- 1. how much is even here, per chain ----------------------------------
console.log('=== rows per chain ===');
for (const r of db.prepare(
  'SELECT chain, COUNT(*) n, MIN(timestamp) lo, MAX(timestamp) hi FROM raw_transactions GROUP BY chain').iterate()) {
  console.log('  ' + r.chain.padEnd(8) + String(r.n).padStart(9) + '  ' +
    String(r.lo).slice(0, 10) + ' .. ' + String(r.hi).slice(0, 10));
}

// -- 2. what transaction types exist on Xahau -----------------------------
// If the engine never cached an AMM or Hook-emitted type, a DeFi position
// leaves no trace no matter how good the leg parser is.
console.log('\n=== Xahau transaction types ===');
const types = new Map();
const dirCount = new Map();
const wallets = new Set();
let xahRows = 0;
for (const r of db.prepare(
  'SELECT wallet, raw_json FROM raw_transactions WHERE chain = ?').iterate(CHAIN)) {
  xahRows++;
  let raw; try { raw = JSON.parse(r.raw_json); } catch (e) { continue; }
  const t = raw.TransactionType || '(none)';
  types.set(t, (types.get(t) || 0) + 1);
  wallets.add(r.wallet);
  const d = raw.Destination === r.wallet ? 'in' : raw.Account === r.wallet ? 'out' : 'neither';
  dirCount.set(d, (dirCount.get(d) || 0) + 1);
}
for (const e of [...types].sort(function (a, b) { return b[1] - a[1]; })) {
  console.log('  ' + String(e[1]).padStart(9) + '  ' + e[0]);
}
console.log('  ' + xahRows + ' ' + CHAIN + ' rows across ' + wallets.size + ' wallet(s)');
console.log('  direction: ' + [...dirCount].map(function (e) { return e[0] + '=' + e[1]; }).join('  '));

// -- 3. EVERY key that ever carries a currency or a value on Xahau --------
// This is the parser-gap test. The XRPL rows use Amount_currency /
// Amount_value / delivered_amount_*. If Xahau uses anything else, it shows
// up here and nowhere in nonNativeLegs().
console.log('\n=== ' + CHAIN + ': keys resembling an amount, and how often they are non-empty ===');
const keyHits = new Map();
const currencyValues = new Map();
for (const r of db.prepare('SELECT raw_json FROM raw_transactions WHERE chain = ?').iterate(CHAIN)) {
  let raw; try { raw = JSON.parse(r.raw_json); } catch (e) { continue; }
  for (const k of Object.keys(raw)) {
    if (!/amount|currency|issuer|value|taker|balance|delivered/i.test(k)) continue;
    const s = String(raw[k] == null ? '' : raw[k]).trim();
    if (!s) continue;
    keyHits.set(k, (keyHits.get(k) || 0) + 1);
    if (/currency/i.test(k)) {
      const d = decodeCurrency(s);
      if (d && !BOOKED.has(d.toUpperCase())) currencyValues.set(d, (currencyValues.get(d) || 0) + 1);
    }
  }
}
for (const e of [...keyHits].sort(function (a, b) { return b[1] - a[1]; })) {
  console.log('  ' + String(e[1]).padStart(9) + '  ' + e[0]);
}
console.log('\n=== ' + CHAIN + ': every non-native currency seen in ANY currency-ish key ===');
if (currencyValues.size === 0) console.log('  (none)');
for (const e of [...currencyValues].sort(function (a, b) { return b[1] - a[1]; })) {
  console.log('  ' + String(e[1]).padStart(9) + '  ' + e[0]);
}

// -- 4. the specific asset, in full ---------------------------------------
// Dump whole rows so the field shape is visible rather than inferred.
if (asset) {
  console.log('\n=== every ' + CHAIN + ' row mentioning ' + asset + ' (raw JSON) ===');
  let shown = 0, matched = 0;
  for (const r of db.prepare(
    'SELECT wallet, timestamp, raw_json FROM raw_transactions WHERE chain = ? ORDER BY timestamp').iterate(CHAIN)) {
    let raw; try { raw = JSON.parse(r.raw_json); } catch (e) { continue; }
    let hit = false;
    for (const k of Object.keys(raw)) {
      if (!/currency/i.test(k)) continue;
      if (decodeCurrency(String(raw[k] == null ? '' : raw[k])) === asset) { hit = true; break; }
    }
    if (!hit) continue;
    matched++;
    if (shown++ >= 12) continue;
    const dir = raw.Destination === r.wallet ? 'IN ' : raw.Account === r.wallet ? 'OUT' : '?? ';
    console.log('\n  --- ' + String(r.timestamp).slice(0, 19) + '  ' + dir + '  ' + raw.TransactionType + ' ---');
    for (const k of Object.keys(raw)) {
      const s = String(raw[k] == null ? '' : raw[k]);
      if (!s.trim()) continue;
      console.log('      ' + k + ': ' + (s.length > 90 ? s.slice(0, 90) + '...' : s));
    }
  }
  console.log('\n  ' + matched + ' row(s) mention ' + asset + '; showed ' + Math.min(shown, 12) + '.');
  if (matched === 0) console.log('  => FETCH GAP: the cache has no row for this asset at all.');
}

// -- 5. one transaction type, in full ------------------------------------
// A type the ingestion flattener has no columns for keeps its payload
// nowhere: the row exists, the amounts do not. That looks identical to
// "you never received it" from anywhere downstream.
if (wantType) {
  console.log('\n=== Xahau ' + wantType + ' rows ===');
  const keys = new Map();
  let n = 0, shown = 0, withAmount = 0;
  const dests = new Map();
  for (const r of db.prepare(
    'SELECT wallet, timestamp, raw_json FROM raw_transactions WHERE chain = ? ORDER BY timestamp').iterate(CHAIN)) {
    let raw; try { raw = JSON.parse(r.raw_json); } catch (e) { continue; }
    if ((raw.TransactionType || '') !== wantType) continue;
    n++;
    let any = false;
    for (const k of Object.keys(raw)) {
      const s2 = String(raw[k] == null ? '' : raw[k]).trim();
      if (!s2) continue;
      keys.set(k, (keys.get(k) || 0) + 1);
      if (/currency|value/i.test(k) && s2 !== '0') any = true;
    }
    if (any) withAmount++;
    const inbound = raw.Destination === r.wallet;
    if (inbound) dests.set(raw.Account, (dests.get(raw.Account) || 0) + 1);
    if (shown < 4) {
      shown++;
      console.log('\n  --- ' + String(r.timestamp).slice(0, 19) +
        (inbound ? '  IN ' : '  OUT') + ' ---');
      for (const k of Object.keys(raw)) {
        const s2 = String(raw[k] == null ? '' : raw[k]);
        if (!s2.trim()) continue;
        console.log('      ' + k + ': ' + (s2.length > 120 ? s2.slice(0, 120) + '...' : s2));
      }
    }
  }
  console.log('\n  ' + n + ' ' + wantType + ' row(s); ' + withAmount + ' carry any currency/value at all.');
  console.log('  keys ever populated:');
  for (const e of [...keys].sort(function (a, b) { return b[1] - a[1]; })) {
    console.log('    ' + String(e[1]).padStart(6) + '  ' + e[0]);
  }
  console.log('  inbound senders:');
  for (const e of [...dests].sort(function (a, b) { return b[1] - a[1]; }).slice(0, 10)) {
    console.log('    ' + String(e[1]).padStart(6) + '  ' + e[0]);
  }
}

db.close();
