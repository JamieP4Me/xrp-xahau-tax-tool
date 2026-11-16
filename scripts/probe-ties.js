#!/usr/bin/env node
/**
 * scripts/probe-ties.js — can two different transactions share a timestamp?
 *
 * WHY IT MATTERS
 *
 * WinDB returns a blank transaction hash on its rows, so the cache stores a
 * downloaded row under a made-up id: its timestamp plus the wallet. Two
 * different transactions of one wallet at one timestamp would get the same
 * id, and the second would be dropped on arrival. Whether that can happen
 * depends on one thing: is a timestamp unique to a transaction?
 *
 * WHAT CANNOT ANSWER IT
 *
 * Counting rows of one wallet that share a timestamp. Under that id there
 * can never be two, because the second was never stored. The count is zero
 * by construction. The first version of this script printed that zero and
 * called it proof; it was not. The count is still shown, labelled for what
 * it is.
 *
 * WHAT CAN
 *
 * The same instant under DIFFERENT wallets. Those rows have different ids,
 * so both are kept. Each row also carries WinDB's own transaction id (CTID:
 * ledger number + position in the ledger). So, across the whole cache:
 *
 *   - rows of different wallets at one timestamp with the SAME CTID are one
 *     transaction seen from two sides (a transfer between your wallets);
 *   - rows at one timestamp with DIFFERENT CTIDs are two transactions
 *     sharing a timestamp. One such case means timestamps are not unique,
 *     and a wallet with two transactions at one instant would keep only one.
 *
 * It also counts how many seconds hold several distinct timestamps. A ledger
 * closes on a whole second, so the nine decimal places are something WinDB
 * adds; if they separate the transactions of one ledger, many seconds will
 * hold several timestamps.
 *
 * And it reports the form of the timestamps, because the download writes one
 * into a query only when it is in a form it knows (see keysetRows in
 * renderer/index.html).
 *
 * Readonly. Opens the cache readonly; writes nothing; prints counts and
 * timestamp forms only, never an address, a hash or a transaction id.
 *
 *   npm run probe:ties
 *   npm run probe:ties -- --db /path/to/tax-data.sqlite3
 */
'use strict';

const os = require('os');
const path = require('path');

// The same test the download applies before a timestamp goes into a query.
const SQL_TS_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z?$/;

function defaultDbPath() {
  const name = 'XRP & Xahau Tax Tool';
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', name, 'tax-data.sqlite3');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), name, 'tax-data.sqlite3');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name, 'tax-data.sqlite3');
}

// Digits become 9 so that every timestamp of one form reads the same.
const shapeOf = (ts) => String(ts).replace(/\d/g, '9');

// A real transaction hash is 64 hex characters. Rows the app writes itself
// (ledger reads, imports) carry their own prefixed keys and are left out.
const REAL_HASH_RE = /^[0-9A-F]{64}$/;
const isOwnKey = (h) => h.startsWith('LEDGER') || h.startsWith('AFFECTED:');

// Ordered exactly as the cache's index on (chain, timestamp, wallet, tx_hash)
// is, so SQLite walks that index and never the table: a few hundred megabytes
// read once, in order, instead of several gigabytes read at random.
const SCAN_SQL = 'SELECT chain, timestamp, wallet, tx_hash FROM raw_transactions ORDER BY chain, timestamp, wallet, tx_hash';
const ROW_SQL = 'SELECT raw_json FROM raw_transactions WHERE wallet = ? AND chain = ? AND tx_hash = ?';
// Instants seen under several wallets are looked up one by one. More than
// this many and the rest are counted but not looked at; the report says so.
const MAX_SHARED_CHECKED = 200000;

const NUL = String.fromCharCode(0);
/** WinDB's transaction id from a stored row, or '' when the row has none. */
function ctidOf(raw) {
  const c = String((raw && raw.CTID) || '').split(NUL).join('').trim().toUpperCase();
  return /^[0-9A-F]{16}$/.test(c) ? c : '';
}
// For rows stored before the CTID column was downloaded: what the transaction was.
const contentOf = (raw) => ['Account', 'Destination', 'TransactionType', 'Amount_XRP', 'Amount_value', 'Amount_currency', 'Sequence', 'Fee_Drops']
  .map((k) => String((raw && raw[k]) ?? '')).join('|');

/** Are these stored rows (one instant, different wallets) one transaction or several? */
function classify(raws) {
  const ids = raws.map(ctidOf);
  if (ids.every(Boolean)) return new Set(ids).size === 1 ? 'same' : 'different';
  return new Set(raws.map(contentOf)).size === 1 ? 'sameByContent' : 'unknown';
}

/**
 * Everything the report prints, as data. `db` is an open better-sqlite3
 * handle. One pass over the index, then a lookup for each instant that was
 * seen under more than one wallet.
 */
function measure(db, onProgress, opts = {}) {
  const maxChecked = opts.maxShared == null ? MAX_SHARED_CHECKED : opts.maxShared;
  const by = new Map();
  const chainOf = (c) => {
    let r = by.get(c);
    if (!r) {
      by.set(c, r = { chain: c, rows: 0, forms: new Map(), madeUp: 0,
        sameWallet: { groups: 0, rows: 0, largest: 0 },                      // zero by construction for made-up ids
        seconds: { several: 0, mostInOne: 0 },                               // seconds holding several distinct timestamps
        shared: { instants: 0, checked: 0, same: 0, sameByContent: 0, different: 0, unknown: 0 } });
    }
    return r;
  };
  const toCheck = [];
  let inst = null;      // rows at one chain + timestamp
  let sec = null;       // distinct timestamps in one chain + second
  const closeInstant = () => {
    if (!inst) return;
    // Same wallet twice at one instant (rows are in wallet order here).
    let run = 1;
    for (let i = 1; i <= inst.rows.length; i++) {
      if (i < inst.rows.length && inst.rows[i].wallet === inst.rows[i - 1].wallet) { run++; continue; }
      if (run > 1) { const t = inst.r.sameWallet; t.groups++; t.rows += run; if (run > t.largest) t.largest = run; }
      run = 1;
    }
    if (new Set(inst.rows.map((x) => x.wallet)).size > 1) {
      inst.r.shared.instants++;
      if (toCheck.length < maxChecked) toCheck.push(inst);
    }
  };
  const closeSecond = () => {
    if (!sec || sec.n < 2) return;
    sec.r.seconds.several++;
    if (sec.n > sec.r.seconds.mostInOne) sec.r.seconds.mostInOne = sec.n;
  };
  let seen = 0;
  for (const row of db.prepare(SCAN_SQL).iterate()) {
    if (++seen % 250000 === 0 && onProgress) onProgress('reading', seen);
    const h = String(row.tx_hash);
    if (isOwnKey(h)) continue;
    const r = chainOf(row.chain);
    r.rows++;
    const ts = String(row.timestamp);
    const shape = shapeOf(ts);
    let f = r.forms.get(shape);
    if (!f) r.forms.set(shape, f = { shape, rows: 0, usable: SQL_TS_RE.test(ts) });
    f.rows++;
    if (!REAL_HASH_RE.test(h)) r.madeUp++;
    if (inst && inst.r === r && inst.ts === ts) {
      if (inst.rows.length < 50) inst.rows.push({ wallet: row.wallet, key: h });
    } else {
      closeInstant();
      inst = { r, ts, rows: [{ wallet: row.wallet, key: h }] };
      const s = ts.slice(0, 19);
      if (sec && sec.r === r && sec.s === s) sec.n++;
      else { closeSecond(); sec = { r, s, n: 1 }; }
    }
  }
  closeInstant(); closeSecond();
  if (onProgress) onProgress('read', seen, true);

  // Each instant seen under several wallets: one transaction, or several?
  const one = db.prepare(ROW_SQL);
  let done = 0;
  for (const g of toCheck) {
    const raws = [];
    for (const x of g.rows) {
      const got = one.get(x.wallet, g.r.chain, x.key);
      if (!got) continue;
      try { raws.push(JSON.parse(got.raw_json)); } catch (e) { raws.push({}); }
    }
    g.r.shared.checked++;
    g.r.shared[classify(raws)]++;
    if (++done % 5000 === 0 && onProgress) onProgress('comparing', done, false, toCheck.length);
  }
  if (onProgress && toCheck.length) onProgress('compared', done, true, toCheck.length);

  return [...by.values()].sort((a, b) => (a.chain < b.chain ? -1 : 1))
    .map((r) => ({ ...r, forms: [...r.forms.values()].sort((a, b) => b.rows - a.rows) }));
}

function report(results, print = console.log) {
  const n = (x) => Number(x).toLocaleString('en-US');
  if (!results.length) { print('The cache holds no downloaded rows.'); return; }
  for (const r of results) {
    const s = r.shared;
    print(`\n${r.chain}: ${n(r.rows)} downloaded rows`);
    print('  Timestamp forms:');
    for (const f of r.forms) print(`    ${f.shape.padEnd(32)} ${n(f.rows).padStart(12)} rows   ${f.usable ? 'known form' : 'NOT a known form: that pass is paged the old way'}`);
    print(`  Stored under a made-up id (timestamp + wallet, no transaction hash): ${n(r.madeUp)} of ${n(r.rows)}`);
    print(`  Seconds holding several different timestamps: ${n(r.seconds.several)} (most in one second: ${n(r.seconds.mostInOne)})`);
    print(`  Instants seen under more than one wallet: ${n(s.instants)}${s.checked < s.instants ? ` (first ${n(s.checked)} compared)` : ''}`);
    if (s.checked) {
      print(`    one transaction seen from two sides:        ${n(s.same + s.sameByContent)}${s.sameByContent ? ` (${n(s.sameByContent)} judged by content, no CTID stored)` : ''}`);
      print(`    DIFFERENT transactions sharing a timestamp: ${n(s.different)}`);
      if (s.unknown) print(`    could not tell (no CTID stored, content differs): ${n(s.unknown)}`);
    }
    print(`  One wallet twice at one timestamp: ${n(r.sameWallet.rows)} rows` +
      (r.madeUp === r.rows ? ' (always zero here: with made-up ids the second row is never stored)' : ''));
  }
  const sum = (f) => results.reduce((t, r) => t + f(r), 0);
  const different = sum((r) => r.shared.different), compared = sum((r) => r.shared.checked), unknown = sum((r) => r.shared.unknown);
  const several = sum((r) => r.seconds.several);
  const allMadeUp = results.every((r) => r.madeUp === r.rows);
  const unknownForm = results.some((r) => r.forms.some((f) => !f.usable));
  print('\nWhat this means:');
  if (different > 0) {
    print(`  Different transactions DO share a timestamp: ${n(different)} case(s) found. A wallet with two transactions at one`);
    print('  timestamp keeps only the first under the present ids. Report this: the row ids need to change.');
  } else if (compared > 0 && several > 0) {
    print(`  No two different transactions share a timestamp: ${n(compared)} instant(s) seen under two wallets were each one`);
    print(`  transaction, and ${n(several)} second(s) hold several transactions, every one with its own timestamp. The decimal`);
    print('  places tell transactions apart, so an id made of timestamp + wallet does not collide.');
    if (unknown) print(`  (${n(unknown)} instant(s) could not be compared: stored before the CTID column was downloaded.)`);
  } else {
    print('  Not enough to tell. Nothing in this cache puts two transactions at one instant to compare' +
      (allMadeUp ? ', and rows of one wallet cannot show it (see above).' : '.'));
  }
  if (unknownForm) print('  Some timestamps are in a form the download does not know. Report the form shown above.');
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--db');
  const dbPath = i >= 0 ? args[i + 1] : defaultDbPath();
  const Database = require('better-sqlite3');
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });   // readonly, always
  } catch (e) {
    if (e && e.code === 'ERR_DLOPEN_FAILED') { console.error('\nbetter-sqlite3 is built for Electron right now. Run:  npm run probe:ties\n'); process.exit(1); }
    console.error(`Could not open the cache at ${dbPath}: ${e.message}`); process.exit(1);
  }
  // Progress goes to the terminal as it works, so a long read never looks stuck.
  const started = Date.now();
  const tty = process.stderr.isTTY;
  const progress = (what, count, done, of) => {
    const line = `  ${what} ${Number(count).toLocaleString('en-US')}${of ? ' of ' + Number(of).toLocaleString('en-US') : ''} (${((Date.now() - started) / 1000).toFixed(0)}s)`;
    process.stderr.write(tty ? `\r${line}      ${done ? '\n' : ''}` : `${line}\n`);
  };
  console.error(`Reading the cache (readonly): ${path.basename(dbPath)}`);
  try { report(measure(db, progress)); } finally { db.close(); }
}

module.exports = { measure, report, classify, ctidOf, shapeOf, SQL_TS_RE, SCAN_SQL, defaultDbPath };
if (require.main === module) main();
