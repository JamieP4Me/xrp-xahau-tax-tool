#!/usr/bin/env node
/**
 * Build the transaction-type index, OUTSIDE the app.
 *
 * WHY THIS IS A SEPARATE STEP
 *
 * The ledger build reads every cached row for a chain, JSON.parses it, and
 * marshals it across the Electron IPC boundary — 6,348,182 objects — then
 * throws away the ones whose type it does not book (749,529 URITokenBuys among
 * them). Filtering in SQL removes that work, but only with an index: without
 * one, `tx_type IN (...)` runs json_extract over every row at query time and is
 * slower than no filter at all.
 *
 * The first attempt built that index at startup. better-sqlite3 is synchronous,
 * so it blocked the Electron main process while SQLite computed json_extract
 * across 6.3M rows, and the app opened to a blank window. "Tens of seconds" was
 * a guess presented as a measurement, in the one place where being wrong stops
 * the application from starting.
 *
 * So it lives here. It takes as long as it takes, it prints what it is doing,
 * and if you kill it the app still works — there is simply no index and the
 * ledger reads every row as it always did.
 *
 * QUIT THE APP FIRST. This takes a write lock for the duration.
 *
 *   npm run cache:optimise
 */
'use strict';

const { parseArgs, openCache } = require('./iou-inventory');
const Database = require('better-sqlite3');

const args = parseArgs(process.argv);
console.log(`\ncache: ${args.db}\n`);

let db;
try {
  db = new Database(args.db, { fileMustExist: true });   // writable, deliberately
} catch (e) {
  if (e && e.code === 'ERR_DLOPEN_FAILED') {
    console.error('better-sqlite3 is built for Electron. Run via npm so it rebuilds:\n');
    console.error('    npm run cache:optimise\n');
    process.exit(1);
  }
  throw e;
}

const has = () => !!db.prepare(
  `SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_raw_tx_chain_type_ts'`).get();

if (has()) {
  console.log('Already optimised — the type index exists. Nothing to do.\n');
  db.close();
  process.exit(0);
}

const total = db.prepare('SELECT COUNT(*) n FROM raw_transactions').get().n;
console.log(`${total.toLocaleString()} cached row(s).`);
console.log('Building the transaction-type index. SQLite computes json_extract');
console.log('once per row, so this is minutes on a cache this size, and the');
console.log('process will look frozen while it runs. That is expected.\n');
console.log('Safe to interrupt: without the index the app reads every row, as before.\n');

const t0 = Date.now();
db.pragma('temp_store = MEMORY');
db.pragma('cache_size = -262144');
db.exec(`CREATE INDEX IF NOT EXISTS idx_raw_tx_chain_type_ts
         ON raw_transactions(chain, tx_type, timestamp, wallet, tx_hash)`);
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`Index built in ${secs}s.\n`);

console.log('What the ledger can now skip, per chain:');
for (const c of db.prepare('SELECT DISTINCT chain FROM raw_transactions').all()) {
  const rows = db.prepare(
    `SELECT COALESCE(tx_type,'(none)') t, COUNT(*) n FROM raw_transactions
     WHERE chain = ? GROUP BY t ORDER BY n DESC`).all(c.chain);
  const sum = rows.reduce((s, r) => s + r.n, 0);
  console.log(`\n  ${c.chain} — ${sum.toLocaleString()} row(s)`);
  for (const r of rows) console.log(`    ${String(r.n).padStart(10)}  ${r.t}`);
}
console.log('\nRestart the app. The ledger build will say how many rows it skipped.\n');
db.close();
