#!/usr/bin/env node
/**
 * scripts/probe-ties.js — do rows in the cache share a timestamp?
 *
 * Two questions hang on the answer, and the cache can settle both:
 *
 *  1. Can two different transactions get the same key and overwrite each
 *     other? A row with no transaction hash is stored under a made-up id:
 *     its timestamp plus the wallet. Two such rows for one wallet at one
 *     timestamp would collide, and the second would replace the first. If
 *     rows that DO have hashes never share a timestamp, hashless ones do not
 *     either, and the keys are safe as they are.
 *
 *  2. How many rows can sit on one timestamp at a page boundary? The
 *     download reads that timestamp again on the next page (see keysetRows
 *     in renderer/index.html), so the largest group is the most it re-reads.
 *
 * It also reports the form the timestamps are stored in, because the
 * download only writes a timestamp into a query when it is in a form it
 * knows; anything else is paged the old way and said so in the log.
 *
 * Readonly. Opens the cache readonly; writes nothing; prints counts and
 * timestamps only, never an address or a hash.
 *
 *   npm run probe:ties
 *   npm run probe:ties -- --db /path/to/tax-data.sqlite3
 */
'use strict';

const os = require('os');
const path = require('path');

// The same test the download applies before a timestamp goes into a query.
const SQL_TS_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z?$/;
// Rows the app writes itself (ledger reads, imports) carry their own keys.
const OWN_KEYS = "tx_hash NOT LIKE 'LEDGER%' AND tx_hash NOT LIKE 'AFFECTED:%'";

function defaultDbPath() {
  const name = 'XRP & Xahau Tax Tool';
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', name, 'tax-data.sqlite3');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), name, 'tax-data.sqlite3');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name, 'tax-data.sqlite3');
}

// Digits become 9 so that every timestamp of one form reads the same.
const shapeOf = (ts) => String(ts).replace(/\d/g, '9');

/** Everything the report prints, as data. `db` is an open better-sqlite3 handle. */
function measure(db) {
  const chains = db.prepare(`SELECT chain, COUNT(*) AS n FROM raw_transactions WHERE ${OWN_KEYS} GROUP BY chain ORDER BY chain`).all();
  const out = [];
  for (const { chain, n } of chains) {
    // One example per length is enough to see the form; the test is applied to each.
    const forms = db.prepare(`SELECT length(timestamp) AS len, COUNT(*) AS n, MIN(timestamp) AS sample
      FROM raw_transactions WHERE chain = ? AND ${OWN_KEYS} GROUP BY len ORDER BY n DESC`).all(chain)
      .map((f) => ({ shape: shapeOf(f.sample), rows: f.n, usable: SQL_TS_RE.test(String(f.sample)) }));
    const ties = db.prepare(`SELECT COUNT(*) AS groups, COALESCE(SUM(n), 0) AS rows, COALESCE(MAX(n), 0) AS largest FROM (
      SELECT COUNT(*) AS n FROM raw_transactions WHERE chain = ? AND ${OWN_KEYS}
      GROUP BY wallet, timestamp HAVING COUNT(*) > 1)`).get(chain);
    // A real hash is 64 hex characters. Anything else here is a made-up id.
    const madeUp = db.prepare(`SELECT COUNT(*) AS n FROM raw_transactions
      WHERE chain = ? AND ${OWN_KEYS} AND (length(tx_hash) != 64 OR tx_hash GLOB '*[^0-9A-F]*')`).get(chain).n;
    const madeUpTied = db.prepare(`SELECT COUNT(*) AS n FROM raw_transactions a
      WHERE a.chain = ? AND ${OWN_KEYS.replace(/tx_hash/g, 'a.tx_hash')} AND (length(a.tx_hash) != 64 OR a.tx_hash GLOB '*[^0-9A-F]*')
        AND EXISTS (SELECT 1 FROM raw_transactions b WHERE b.wallet = a.wallet AND b.chain = a.chain AND b.timestamp = a.timestamp AND b.tx_hash != a.tx_hash)`).get(chain).n;
    out.push({ chain, rows: n, forms, ties, madeUp, madeUpTied });
  }
  return out;
}

function report(results, print = console.log) {
  const n = (x) => Number(x).toLocaleString('en-US');
  if (!results.length) { print('The cache holds no downloaded rows.'); return; }
  for (const r of results) {
    print(`\n${r.chain}: ${n(r.rows)} downloaded rows`);
    print('  Timestamp forms:');
    for (const f of r.forms) print(`    ${f.shape.padEnd(32)} ${n(f.rows).padStart(12)} rows   ${f.usable ? 'known form' : 'NOT a known form: that pass is paged the old way'}`);
    print(`  Rows sharing a wallet and timestamp: ${n(r.ties.rows)} in ${n(r.ties.groups)} group(s); largest group ${n(r.ties.largest)}`);
    print(`  Rows stored under a made-up id (no transaction hash): ${n(r.madeUp)}; of those, sharing a timestamp with another row: ${n(r.madeUpTied)}`);
  }
  const tied = results.reduce((s, r) => s + r.ties.groups, 0);
  const largest = results.reduce((m, r) => Math.max(m, r.ties.largest), 0);
  const risky = results.reduce((s, r) => s + r.madeUpTied, 0);
  const unknown = results.some((r) => r.forms.some((f) => !f.usable));
  print('\nWhat this means:');
  print(tied === 0
    ? '  No two rows of one wallet share a timestamp. A made-up id (timestamp + wallet) cannot collide, so no row has overwritten another.'
    : `  Some rows share a timestamp (largest group ${n(largest)}). The download re-reads that many rows at a page boundary at most; a page is 1,000.`);
  if (tied !== 0) print(risky === 0
    ? '  None of the rows stored under a made-up id shares its timestamp with another row, so none of them has overwritten another that is still here.'
    : `  ${n(risky)} row(s) under a made-up id share a timestamp with another row. Two hashless rows at one timestamp would overwrite each other: report this.`);
  if (unknown) print('  Some timestamps are in a form the download does not know. Report the form shown above.');
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
  try { report(measure(db)); } finally { db.close(); }
}

module.exports = { measure, report, shapeOf, SQL_TS_RE, defaultDbPath };
if (require.main === module) main();
