// test/db.test.js — plain Node test of the SQLite cache layer (db.js), with
// no Electron involved at all. Exercises exactly the scenario this whole
// feature exists for: fetch full history once, persist it, "restart the
// app" (a fresh createDb() call against the same file, just like a real
// relaunch would), fetch again and get only new rows, and confirm nothing
// is lost, duplicated, or reordered in between.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDb } = require('../db');

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${e.stack.split('\n').slice(0, 4).join('\n    ')}`);
  }
}

function tmpDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'taxdb-test-')), 'tax-data.sqlite3');
}

function row(ts, extra = {}) {
  // Minimal fake WinDB row shape, timestamp in WinDB's own "YYYY-MM-DD HH:MM:SS" style.
  return { Timestamp: ts, TransactionType: 'Payment', Account: 'rSENDER', Destination: 'rWALLET', ...extra };
}

// A cache row as insertRows() wants it, wrapping the WinDB shape above.
function cacheRow(ts, hash) {
  return { tx_hash: hash, timestamp: ts, raw_json: JSON.stringify(row(ts)) };
}

console.log('db.js — local SQLite cache tests');

test('fresh db has no sync state and no cached rows', () => {
  const db = createDb(tmpDbPath());
  assert.strictEqual(db.getSyncState('rWALLET', 'XRPL'), null);
  assert.deepStrictEqual(db.getAllRows('rWALLET', 'XRPL'), []);
  assert.strictEqual(db.countForWallet('rWALLET', 'XRPL'), 0);
  db.close();
});

test('insertRows stores rows and getAllRows returns them sorted by timestamp ascending, regardless of insert order', () => {
  const db = createDb(tmpDbPath());
  const rows = [
    { tx_hash: 'H3', timestamp: '2024-03-01 00:00:00', raw_json: JSON.stringify(row('2024-03-01 00:00:00', { n: 3 })) },
    { tx_hash: 'H1', timestamp: '2024-01-01 00:00:00', raw_json: JSON.stringify(row('2024-01-01 00:00:00', { n: 1 })) },
    { tx_hash: 'H2', timestamp: '2024-02-01 00:00:00', raw_json: JSON.stringify(row('2024-02-01 00:00:00', { n: 2 })) },
  ];
  const inserted = db.insertRows('rWALLET', 'XRPL', rows);
  assert.strictEqual(inserted, 3);
  const all = db.getAllRows('rWALLET', 'XRPL');
  assert.deepStrictEqual(all.map(r => r.n), [1, 2, 3]);
  db.close();
});

test('REGRESSION: a re-fetch REPLACES a cached row rather than discarding it', () => {
  // This test previously asserted the opposite -- that the original copy wins
  // -- on the reasoning that "a re-fetch never corrupts what is cached". That
  // reasoning was wrong in the case that matters: when a column is added to
  // the SELECT list, the re-fetched row is RICHER than the cached one, and
  // keeping the original throws the new data away.
  //
  // Measured before the fix: a Force Full Re-sync pulled 5,593,824 Xahau rows,
  // paid the Payment-Claim for all of them, and kept the new columns on 13,820
  // -- only the rows that were new transactions anyway. 171 of 174 Remits
  // still carried no amounts. The re-sync could not do the one job it exists
  // for.
  const db = createDb(tmpDbPath());
  const r = { tx_hash: 'DUP', timestamp: '2024-01-01 00:00:00',
              raw_json: JSON.stringify(row('2024-01-01 00:00:00', { v: 'first' })) };
  db.insertRows('rWALLET', 'XRPL', [r]);

  const richer = { tx_hash: 'DUP', timestamp: '2024-01-01 00:00:00',
                   raw_json: JSON.stringify(row('2024-01-01 00:00:00', { v: 'second', Fee_Drops: '12' })) };
  const written = db.insertRows('rWALLET', 'XRPL', [richer]);
  assert.strictEqual(written, 1, 'a changed row counts as written');
  const all = db.getAllRows('rWALLET', 'XRPL');
  assert.strictEqual(all.length, 1, 'still one row — the key still dedupes');
  assert.strictEqual(all[0].v, 'second', 'the NEWER fetch wins');
  assert.strictEqual(all[0].Fee_Drops, '12', 'and the column that was missing is now there');
  db.close();
});

test('an identical re-fetch is still a no-op, so a routine sync reports nothing', () => {
  // The guard against churn: without it, every incremental sync would rewrite
  // fetched_at across millions of unchanged rows and report them all as work.
  const db = createDb(tmpDbPath());
  const r = { tx_hash: 'SAME', timestamp: '2024-01-01 00:00:00',
              raw_json: JSON.stringify(row('2024-01-01 00:00:00', { v: 'x' })) };
  assert.strictEqual(db.insertRows('rWALLET', 'XRPL', [r]), 1);
  assert.strictEqual(db.insertRows('rWALLET', 'XRPL', [r]), 0, 'byte-identical re-fetch writes nothing');
  assert.strictEqual(db.getAllRows('rWALLET', 'XRPL').length, 1);
  db.close();
});


// ── the type filter that stops the ledger reading rows it discards ────────

test('REGRESSION: the type filter is REFUSED until its index exists', () => {
  // Without the index, tx_type IN (...) runs json_extract over every row at
  // query time — slower than no filter at all. And the index cannot be built
  // at startup: doing so blocked the Electron main process across 6.3M rows
  // and the app opened to a blank window. So the filter must degrade to the
  // old behaviour rather than quietly become the slow path.
  const db = createDb(tmpDbPath());
  const mk = (h, ts, type) => ({ tx_hash: h, timestamp: ts,
    raw_json: JSON.stringify(row(ts, { TransactionType: type })) });
  db.insertRows('rW', 'Xahau', [
    mk('A', '2024-01-01 00:00:01', 'Payment'),
    mk('B', '2024-01-01 00:00:02', 'URITokenBuy'),
  ]);
  assert.strictEqual(db.hasTypeIndex(), false, 'a fresh cache is not optimised');
  assert.strictEqual(db.getChainRowsPage('Xahau', 100, null, ['Payment']).rows.length, 2,
    'the filter is ignored, so nothing is lost — it is only not faster');
  assert.strictEqual(db.countForChain('Xahau', ['Payment']), 2, 'the count agrees with it');

  db.buildTypeIndex();
  assert.strictEqual(db.hasTypeIndex(), true);
  assert.strictEqual(db.getChainRowsPage('Xahau', 100, null, ['Payment']).rows.length, 1,
    'and now it filters');
  db.close();
});

test('getChainRowsPage with a type list reads ONLY those types', () => {
  const db = createDb(tmpDbPath());
  const mk = (h, ts, type) => ({ tx_hash: h, timestamp: ts,
    raw_json: JSON.stringify(row(ts, { TransactionType: type })) });
  db.insertRows('rW', 'Xahau', [
    mk('A', '2024-01-01 00:00:01', 'Payment'),
    mk('B', '2024-01-01 00:00:02', 'URITokenBuy'),
    mk('C', '2024-01-01 00:00:03', 'Remit'),
    mk('D', '2024-01-01 00:00:04', 'URITokenBuy'),
  ]);
  assert.strictEqual(db.countForChain('Xahau'), 4, 'everything is still cached');
  db.buildTypeIndex();   // the filter is refused until this has run
  assert.strictEqual(db.countForChain('Xahau', ['Payment', 'Remit']), 2);

  const page = db.getChainRowsPage('Xahau', 100, null, ['Payment', 'Remit']);
  assert.strictEqual(page.rows.length, 2, 'the URITokenBuys never left SQLite');
  assert.deepStrictEqual(page.rows.map(r => r.row.TransactionType), ['Payment', 'Remit']);
  db.close();
});

test('no type list means the old behaviour, exactly', () => {
  // The filter must never narrow what the tax engine sees unless a caller
  // asks for it. A silent narrowing is how a whole row class goes missing.
  const db = createDb(tmpDbPath());
  const mk = (h, ts, type) => ({ tx_hash: h, timestamp: ts,
    raw_json: JSON.stringify(row(ts, { TransactionType: type })) });
  db.insertRows('rW', 'Xahau', [
    mk('A', '2024-01-01 00:00:01', 'Payment'),
    mk('B', '2024-01-01 00:00:02', 'URITokenBuy'),
  ]);
  assert.strictEqual(db.getChainRowsPage('Xahau', 100, null).rows.length, 2);
  assert.strictEqual(db.getChainRowsPage('Xahau', 100, null, []).rows.length, 2, 'empty list = no filter');
  db.close();
});

test('the filtered page keeps its global chronological order and paginates', () => {
  // Chronological order across wallets is the whole reason this query exists;
  // a filter that broke it would silently reorder a FIFO ledger.
  const db = createDb(tmpDbPath());
  const mk = (h, ts, type) => ({ tx_hash: h, timestamp: ts,
    raw_json: JSON.stringify(row(ts, { TransactionType: type, marker: h })) });
  db.insertRows('rA', 'Xahau', [mk('A', '2024-01-01 00:00:01', 'Payment'),
                                mk('C', '2024-01-01 00:00:03', 'Payment')]);
  db.insertRows('rB', 'Xahau', [mk('B', '2024-01-01 00:00:02', 'Payment'),
                                mk('X', '2024-01-01 00:00:02', 'URITokenBuy')]);
  db.buildTypeIndex();
  const seen = [];
  let cursor = null;
  for(;;) {
    const p = db.getChainRowsPage('Xahau', 1, cursor, ['Payment']);
    if (!p.rows.length) break;
    seen.push(...p.rows.map(r => r.row.marker));
    cursor = p.cursor;
    if (!cursor) break;
  }
  assert.deepStrictEqual(seen, ['A', 'B', 'C'], 'chronological, across wallets, one page at a time');
  db.close();
});

test('countByType shows what a filter would leave behind', () => {
  const db = createDb(tmpDbPath());
  const mk = (h, ts, type) => ({ tx_hash: h, timestamp: ts,
    raw_json: JSON.stringify(row(ts, { TransactionType: type })) });
  db.insertRows('rW', 'Xahau', [
    mk('A', '2024-01-01 00:00:01', 'Payment'),
    mk('B', '2024-01-01 00:00:02', 'URITokenBuy'),
    mk('C', '2024-01-01 00:00:03', 'URITokenBuy'),
  ]);
  const byType = db.countByType('Xahau');
  const m = Object.fromEntries(byType.map(r => [r.type, r.n]));
  assert.strictEqual(m.URITokenBuy, 2);
  assert.strictEqual(m.Payment, 1);
  db.close();
});

test('the same tx_hash under two different wallets is stored twice (one cache row per wallet perspective)', () => {
  const db = createDb(tmpDbPath());
  const r = (wallet) => ({ tx_hash: 'SHARED', timestamp: '2024-01-01 00:00:00', raw_json: JSON.stringify(row('2024-01-01 00:00:00', { wallet })) });
  db.insertRows('rA', 'XRPL', [r('rA')]);
  db.insertRows('rB', 'XRPL', [r('rB')]);
  assert.strictEqual(db.getAllRows('rA', 'XRPL').length, 1);
  assert.strictEqual(db.getAllRows('rB', 'XRPL').length, 1);
  db.close();
});

test('listCachedWallets returns every wallet with cached data, across both chains, deduplicated', () => {
  const db = createDb(tmpDbPath());
  assert.deepStrictEqual(db.listCachedWallets(), []);
  db.insertRows('rA', 'XRPL', [{ tx_hash: 'X1', timestamp: '2024-01-01 00:00:00', raw_json: '{}' }]);
  db.insertRows('rB', 'Xahau', [{ tx_hash: 'X2', timestamp: '2024-01-01 00:00:00', raw_json: '{}' }]);
  // rA has data on BOTH chains — must appear only once in the list.
  db.insertRows('rA', 'Xahau', [{ tx_hash: 'X3', timestamp: '2024-01-02 00:00:00', raw_json: '{}' }]);
  assert.deepStrictEqual(db.listCachedWallets(), ['rA', 'rB']); // alphabetical, per the SQL ORDER BY
  db.close();
});

test('XRPL and Xahau caches for the same wallet are independent', () => {
  const db = createDb(tmpDbPath());
  db.insertRows('rWALLET', 'XRPL', [{ tx_hash: 'X1', timestamp: '2024-01-01 00:00:00', raw_json: '{}' }]);
  assert.strictEqual(db.countForWallet('rWALLET', 'XRPL'), 1);
  assert.strictEqual(db.countForWallet('rWALLET', 'Xahau'), 0);
  db.close();
});

test('upsertSyncState only ever moves the cursor forward, never backward', () => {
  const db = createDb(tmpDbPath());
  db.upsertSyncState('rWALLET', 'XRPL', '2024-06-01 00:00:00');
  assert.strictEqual(db.getSyncState('rWALLET', 'XRPL'), '2024-06-01 00:00:00');
  // A later call with an EARLIER timestamp (e.g. a stale/out-of-order run) must not regress the cursor.
  db.upsertSyncState('rWALLET', 'XRPL', '2024-01-01 00:00:00');
  assert.strictEqual(db.getSyncState('rWALLET', 'XRPL'), '2024-06-01 00:00:00');
  // A later call with a NEWER timestamp does advance it.
  db.upsertSyncState('rWALLET', 'XRPL', '2024-09-01 00:00:00');
  assert.strictEqual(db.getSyncState('rWALLET', 'XRPL'), '2024-09-01 00:00:00');
  db.close();
});

test('upsertSyncState(null) just stamps last_synced_at without clearing an existing cursor', () => {
  const db = createDb(tmpDbPath());
  db.upsertSyncState('rWALLET', 'XRPL', '2024-06-01 00:00:00');
  db.upsertSyncState('rWALLET', 'XRPL', null);
  assert.strictEqual(db.getSyncState('rWALLET', 'XRPL'), '2024-06-01 00:00:00');
  db.close();
});

test('forceFullResync clears every cursor but keeps every cached row', () => {
  const db = createDb(tmpDbPath());
  db.insertRows('rWALLET', 'XRPL', [{ tx_hash: 'H1', timestamp: '2024-01-01 00:00:00', raw_json: '{}' }]);
  db.upsertSyncState('rWALLET', 'XRPL', '2024-01-01 00:00:00');
  db.forceFullResync();
  assert.strictEqual(db.getSyncState('rWALLET', 'XRPL'), null);
  assert.strictEqual(db.countForWallet('rWALLET', 'XRPL'), 1, 'rows must survive a forced re-sync');
  db.close();
});

test('clearAll wipes both rows and cursors', () => {
  const db = createDb(tmpDbPath());
  db.insertRows('rWALLET', 'XRPL', [{ tx_hash: 'H1', timestamp: '2024-01-01 00:00:00', raw_json: '{}' }]);
  db.upsertSyncState('rWALLET', 'XRPL', '2024-01-01 00:00:00');
  db.clearAll();
  assert.strictEqual(db.getSyncState('rWALLET', 'XRPL'), null);
  assert.strictEqual(db.countForWallet('rWALLET', 'XRPL'), 0);
  db.close();
});

test('clearWalletChain only touches the named wallet+chain pair', () => {
  const db = createDb(tmpDbPath());
  db.insertRows('rA', 'XRPL', [{ tx_hash: 'H1', timestamp: '2024-01-01 00:00:00', raw_json: '{}' }]);
  db.insertRows('rA', 'Xahau', [{ tx_hash: 'H2', timestamp: '2024-01-01 00:00:00', raw_json: '{}' }]);
  db.insertRows('rB', 'XRPL', [{ tx_hash: 'H3', timestamp: '2024-01-01 00:00:00', raw_json: '{}' }]);
  db.clearWalletChain('rA', 'XRPL');
  assert.strictEqual(db.countForWallet('rA', 'XRPL'), 0);
  assert.strictEqual(db.countForWallet('rA', 'Xahau'), 1, 'other chain for same wallet must survive');
  assert.strictEqual(db.countForWallet('rB', 'XRPL'), 1, 'other wallet must survive');
  db.close();
});

test('getStats reports totals, earliest/latest, and last-synced across the whole cache', () => {
  const db = createDb(tmpDbPath());
  db.insertRows('rA', 'XRPL', [
    { tx_hash: 'H1', timestamp: '2024-01-01 00:00:00', raw_json: '{}' },
    { tx_hash: 'H2', timestamp: '2024-06-01 00:00:00', raw_json: '{}' },
  ]);
  db.insertRows('rB', 'XRPL', [{ tx_hash: 'H3', timestamp: '2024-03-01 00:00:00', raw_json: '{}' }]);
  db.upsertSyncState('rA', 'XRPL', '2024-06-01 00:00:00');
  const stats = db.getStats();
  assert.strictEqual(stats.totalRows, 3);
  assert.strictEqual(stats.walletsWithData, 2);
  assert.strictEqual(stats.earliest, '2024-01-01 00:00:00');
  assert.strictEqual(stats.latest, '2024-06-01 00:00:00');
  assert.ok(stats.lastSyncedAt, 'lastSyncedAt should be set after an upsertSyncState call');
  db.close();
});

test('END-TO-END: simulated "first run, close app, reopen, incremental run" cycle', () => {
  const dbPath = tmpDbPath();

  // ── Run 1: first-ever fetch, full history (no cursor yet) ──
  let db = createDb(dbPath);
  assert.strictEqual(db.getSyncState('rWALLET', 'XRPL'), null, 'no cursor before first run');
  const run1Rows = [
    { tx_hash: 'A', timestamp: '2024-01-01 00:00:00', raw_json: JSON.stringify(row('2024-01-01 00:00:00', { seq: 1 })) },
    { tx_hash: 'B', timestamp: '2024-02-01 00:00:00', raw_json: JSON.stringify(row('2024-02-01 00:00:00', { seq: 2 })) },
  ];
  db.insertRows('rWALLET', 'XRPL', run1Rows);
  db.upsertSyncState('rWALLET', 'XRPL', '2024-02-01 00:00:00');
  assert.strictEqual(db.getAllRows('rWALLET', 'XRPL').length, 2);
  db.close(); // ── simulates quitting the app ──

  // ── App relaunch: brand-new createDb() call against the SAME file ──
  db = createDb(dbPath);
  const cursorAfterRestart = db.getSyncState('rWALLET', 'XRPL');
  assert.strictEqual(cursorAfterRestart, '2024-02-01 00:00:00', 'sync cursor must survive a restart');
  assert.strictEqual(db.getAllRows('rWALLET', 'XRPL').length, 2, 'cached rows must survive a restart');

  // ── Run 2: incremental — only rows newer than the cursor would actually
  // be requested from WinDB in the real app; here we just simulate that
  // WinDB returned exactly one new row plus (worst case) re-sent the
  // boundary row again, to prove overlap doesn't duplicate anything.
  const run2Rows = [
    { tx_hash: 'B', timestamp: '2024-02-01 00:00:00', raw_json: JSON.stringify(row('2024-02-01 00:00:00', { seq: 2 })) }, // re-sent boundary row
    { tx_hash: 'C', timestamp: '2024-03-01 00:00:00', raw_json: JSON.stringify(row('2024-03-01 00:00:00', { seq: 3 })) }, // genuinely new
  ];
  const insertedInRun2 = db.insertRows('rWALLET', 'XRPL', run2Rows);
  assert.strictEqual(insertedInRun2, 1, 'only the genuinely new row should count as inserted');
  db.upsertSyncState('rWALLET', 'XRPL', '2024-03-01 00:00:00');

  const finalRows = db.getAllRows('rWALLET', 'XRPL');
  assert.strictEqual(finalRows.length, 3, 'no duplicates, no losses across the two runs');
  assert.deepStrictEqual(finalRows.map(r => r.seq), [1, 2, 3], 'still in correct chronological order after merging runs');
  db.close();
});

// ── Regressions from the full code review ─────────────────────────────────

test('REGRESSION: upsertSyncState always stamps last_synced_at, even when the cursor does not move', () => {
  const db = createDb(tmpDbPath());
  db.insertRows('rW', 'XRPL', [{ tx_hash: 'A', timestamp: '2024-05-01 00:00:00', raw_json: '{}' }]);

  db.upsertSyncState('rW', 'XRPL', '2024-05-01 00:00:00');
  const first = db.getStats().lastSyncedAt;
  assert.ok(first, 'first sync should record a last_synced_at');

  // Re-sync a dormant wallet: same cursor value, so the forward-only guard
  // rejects the cursor write. last_synced_at must still be refreshed — it
  // used to be suppressed along with it, so the panel showed a stale
  // "last synced" date right after a successful sync.
  const later = new Date(Date.now() + 5000).toISOString();
  const dbAny = db;
  dbAny.upsertSyncState('rW', 'XRPL', '2024-05-01 00:00:00');
  const second = db.getStats().lastSyncedAt;
  assert.ok(second >= first, 'last_synced_at must be rewritten even when the cursor is unchanged');
  assert.strictEqual(db.getSyncState('rW', 'XRPL'), '2024-05-01 00:00:00', 'cursor itself must not move');

  // And an OLDER timestamp still must not move the cursor backward.
  db.upsertSyncState('rW', 'XRPL', '2023-01-01 00:00:00');
  assert.strictEqual(db.getSyncState('rW', 'XRPL'), '2024-05-01 00:00:00', 'cursor must never go backward');
  db.close();
});

test('REGRESSION: clearAll and clearWalletChain never leave rows deleted with the cursor still set', () => {
  const db = createDb(tmpDbPath());
  db.insertRows('rA', 'XRPL', [{ tx_hash: 'A1', timestamp: '2024-01-01 00:00:00', raw_json: '{}' }]);
  db.insertRows('rB', 'Xahau', [{ tx_hash: 'B1', timestamp: '2024-01-02 00:00:00', raw_json: '{}' }]);
  db.upsertSyncState('rA', 'XRPL', '2024-01-01 00:00:00');
  db.upsertSyncState('rB', 'Xahau', '2024-01-02 00:00:00');

  db.clearWalletChain('rA', 'XRPL');
  assert.deepStrictEqual(db.getAllRows('rA', 'XRPL'), [], 'rows gone');
  assert.strictEqual(db.getSyncState('rA', 'XRPL'), null,
    'cursor MUST be gone too — a surviving cursor makes all pre-cursor history permanently unfetchable');
  assert.strictEqual(db.getSyncState('rB', 'Xahau'), '2024-01-02 00:00:00', 'other pairs untouched');

  db.clearAll();
  assert.strictEqual(db.getSyncState('rB', 'Xahau'), null, 'clearAll drops every cursor');
  assert.strictEqual(db.getStats().totalRows, 0, 'clearAll drops every row');
  db.close();
});

test('REGRESSION: insertRows stores wallet in wallet and chain in chain (arg order not swapped)', () => {
  // Both are TEXT columns, so a swap is silent — it only shows up as rows
  // that can never be read back under the identifiers they were written with.
  const db = createDb(tmpDbPath());
  db.insertRows('rRealWallet', 'Xahau', [{ tx_hash: 'X', timestamp: '2024-03-03 00:00:00', raw_json: '{"k":1}' }]);
  assert.strictEqual(db.getAllRows('rRealWallet', 'Xahau').length, 1, 'readable under (wallet, chain)');
  assert.strictEqual(db.getAllRows('Xahau', 'rRealWallet').length, 0, 'NOT readable under the swapped pair');
  assert.deepStrictEqual(db.listCachedWallets(), ['rRealWallet'], 'wallet column holds the wallet, not the chain');
  db.close();
});

test('getChainRowsPage streams a chain in true global chronological order, with no gaps or repeats', () => {
  const db = createDb(tmpDbPath());
  // Interleave three wallets so per-wallet order and global order differ.
  db.insertRows('rA', 'Xahau', [
    { tx_hash: 'A1', timestamp: '2024-01-01 00:00:00', raw_json: JSON.stringify({ n: 'A1' }) },
    { tx_hash: 'A2', timestamp: '2024-03-01 00:00:00', raw_json: JSON.stringify({ n: 'A2' }) },
  ]);
  db.insertRows('rB', 'Xahau', [
    { tx_hash: 'B1', timestamp: '2024-02-01 00:00:00', raw_json: JSON.stringify({ n: 'B1' }) },
    { tx_hash: 'B2', timestamp: '2024-04-01 00:00:00', raw_json: JSON.stringify({ n: 'B2' }) },
  ]);
  db.insertRows('rC', 'Xahau', [
    { tx_hash: 'C1', timestamp: '2024-01-15 00:00:00', raw_json: JSON.stringify({ n: 'C1' }) },
  ]);
  // A different chain must never leak into the stream.
  db.insertRows('rA', 'XRPL', [
    { tx_hash: 'X1', timestamp: '2024-01-02 00:00:00', raw_json: JSON.stringify({ n: 'X1' }) },
  ]);

  const drain = (pageSize) => {
    const seen = [];
    let cursor = null;
    for (let guard = 0; guard < 100; guard++) {
      const page = db.getChainRowsPage('Xahau', pageSize, cursor);
      if (page.rows.length === 0) break;
      for (const r of page.rows) seen.push(r.row.n);
      cursor = page.cursor;
      if (!cursor) break;
    }
    return seen;
  };

  const expected = ['A1', 'C1', 'B1', 'A2', 'B2']; // strict chronological order
  // Page size must not change the result — including a size that lands
  // exactly on the row count, and one of 1 which exercises the cursor hardest.
  for (const size of [1, 2, 3, 5, 100]) {
    assert.deepStrictEqual(drain(size), expected, `page size ${size}`);
  }

  assert.strictEqual(db.countForChain('Xahau'), 5);
  assert.strictEqual(db.countForChain('XRPL'), 1);
  db.close();
});

test('getChainRowsPage keeps a stable total order when many rows share a timestamp', () => {
  // Second-granularity timestamps collide constantly on these ledgers. If the
  // sort key were timestamp alone, keyset pagination could repeat or skip rows
  // across a page boundary that falls inside a run of equal timestamps.
  const db = createDb(tmpDbPath());
  const SAME = '2024-06-01 12:00:00';
  const wallets = ['rA', 'rB', 'rC'];
  for (const w of wallets) {
    db.insertRows(w, 'Xahau', Array.from({ length: 7 }, (_, i) => ({
      tx_hash: `${w}_${String(i).padStart(2, '0')}`,
      timestamp: SAME,
      raw_json: JSON.stringify({ id: `${w}_${i}` }),
    })));
  }
  const total = 21;
  for (const size of [1, 2, 4, 5, 20, 21]) {
    const seen = [];
    let cursor = null;
    for (let guard = 0; guard < 200; guard++) {
      const page = db.getChainRowsPage('Xahau', size, cursor);
      if (page.rows.length === 0) break;
      for (const r of page.rows) seen.push(r.row.id);
      cursor = page.cursor;
      if (!cursor) break;
    }
    assert.strictEqual(seen.length, total, `page size ${size}: every row exactly once`);
    assert.strictEqual(new Set(seen).size, total, `page size ${size}: no duplicates`);
  }
  db.close();
});

// ── app_meta: facts about the cache rather than in it ──────────────────────
//
// These back the fetch-scope fingerprint. The bug they guard against is not
// hypothetical: every cache built before v1.3.0 was filled by a query that
// asked only for Payment and OfferCreate, while its sync cursors said
// "synced through today". Widening the query without noticing that would
// have produced a report that looked complete and silently was not.

test('getMeta returns null for a key that was never set', () => {
  const db = createDb(tmpDbPath());
  assert.strictEqual(db.getMeta('fetch_scope'), null);
  db.close();
});

test('setMeta writes, overwrites in place, and survives a restart', () => {
  const p = tmpDbPath();
  let db = createDb(p);
  db.setMeta('fetch_scope', 'Payment,OfferCreate');
  assert.strictEqual(db.getMeta('fetch_scope'), 'Payment,OfferCreate');
  db.setMeta('fetch_scope', 'Payment,OfferCreate,AMMDeposit');
  assert.strictEqual(db.getMeta('fetch_scope'), 'Payment,OfferCreate,AMMDeposit');
  db.close();

  // "Restart the app" — the whole point is that this outlives the process.
  db = createDb(p);
  assert.strictEqual(db.getMeta('fetch_scope'), 'Payment,OfferCreate,AMMDeposit');
  db.close();
});

test('a meta key does not disturb schema_version, which shares the table', () => {
  const db = createDb(tmpDbPath());
  const before = db.getMeta('schema_version');
  assert.ok(before, 'schema_version should already be set on a fresh db');
  db.setMeta('fetch_scope', 'x');
  assert.strictEqual(db.getMeta('schema_version'), before);
  db.close();
});

test('widening the scope: cursors drop, cached rows and the fingerprint stay', () => {
  // The exact upgrade path. A cache synced under the narrow scope, then the
  // app widens it: every cursor must go so the next fetch re-requests full
  // history, and not one cached row may be lost in the process.
  const db = createDb(tmpDbPath());
  db.insertRows('rWALLET', 'XRPL', [cacheRow('2024-01-01 00:00:00', 'A'), cacheRow('2024-01-02 00:00:00', 'B')]);
  db.upsertSyncState('rWALLET', 'XRPL', '2024-01-02 00:00:00');
  db.setMeta('fetch_scope', 'OfferCreate,Payment');
  assert.strictEqual(db.getSyncState('rWALLET', 'XRPL'), '2024-01-02 00:00:00');

  db.forceFullResync();

  assert.strictEqual(db.getSyncState('rWALLET', 'XRPL'), null,
    'the cursor must be gone, or the widened query is never sent');
  assert.strictEqual(db.getAllRows('rWALLET', 'XRPL').length, 2,
    'forceFullResync must not delete cached rows');
  assert.strictEqual(db.getMeta('fetch_scope'), 'OfferCreate,Payment',
    'the old fingerprint must survive the reset so the warning persists until a fetch runs');
  db.close();
});

test('re-fetching after a scope change dedups rather than doubling history', () => {
  // The cost of the re-sync has to be time, never duplicated rows — a
  // doubled history would double proceeds on Form 8949.
  const db = createDb(tmpDbPath());
  const rows = [cacheRow('2024-01-01 00:00:00', 'A'), cacheRow('2024-01-02 00:00:00', 'B')];
  db.insertRows('rWALLET', 'XRPL', rows);
  db.upsertSyncState('rWALLET', 'XRPL', '2024-01-02 00:00:00');
  db.forceFullResync();
  // Full history comes back, plus one genuinely new row.
  db.insertRows('rWALLET', 'XRPL', [...rows, cacheRow('2024-01-03 00:00:00', 'C')]);
  assert.strictEqual(db.getAllRows('rWALLET', 'XRPL').length, 3);
  db.close();
});

// ── amm_ledger: ledger-verified AMM amounts ───────────────────────────────
// The figures here come from a different source than everything else in the
// cache, and they exist because WinDB's number is the amount REQUESTED while
// the ledger delivered more on every comparable withdrawal measured.

function ammRow(type, ts, delivered, extra = {}) {
  return {
    wallet: 'rTESTwa11etXRPL1111111111111111111',
    tx_type: type, timestamp: ts,
    ledger_hash: 'DEADBEEF', submitted: 100, delivered, flags: 262144, note: '',
    ...extra,
  };
}

test('a fresh db has no imported AMM amounts', () => {
  const db = createDb(tmpDbPath());
  assert.deepStrictEqual(db.getAmmLedger(), []);
  const s = db.getAmmStats();
  assert.strictEqual(s.rows, 0);
  assert.strictEqual(s.withDelivered, 0);
  assert.strictEqual(s.importedAt, null);
  db.close();
});

test('importAmmLedger stores rows and counts only those carrying a ledger figure', () => {
  // An unpaired row is stored deliberately: it is the record that this
  // transaction was LOOKED FOR on the ledger and no figure exists, which is
  // different from never having asked.
  const db = createDb(tmpDbPath());
  const n = db.importAmmLedger([
    ammRow('AMMWithdraw', '2025-01-01 00:00:00.1', 105.5),
    ammRow('AMMDeposit', '2024-05-01 00:00:00.2', 50),
    ammRow('AMMWithdraw', '2025-02-01 00:00:00.3', null, { submitted: null, ledger_hash: '', flags: null, note: 'no ledger AMM tx of this type within a second' }),
  ]);
  assert.strictEqual(n, 3);
  const s = db.getAmmStats();
  assert.strictEqual(s.rows, 3);
  assert.strictEqual(s.withDelivered, 2);
  assert.ok(s.importedAt, 'an import stamps a time');
  db.close();
});

test('getAmmLedger returns rows oldest first', () => {
  const db = createDb(tmpDbPath());
  db.importAmmLedger([
    ammRow('AMMWithdraw', '2025-02-01 00:00:00', 3),
    ammRow('AMMWithdraw', '2024-01-01 00:00:00', 1),
    ammRow('AMMWithdraw', '2024-06-01 00:00:00', 2),
  ]);
  assert.deepStrictEqual(db.getAmmLedger().map(r => r.delivered), [1, 2, 3]);
  db.close();
});

test('re-importing a corrected CSV REPLACES the figure rather than keeping the first one', () => {
  // This is the whole reason the statement is an UPSERT and not an INSERT OR
  // IGNORE. The second run of the verifier is the one that fixed the numbers:
  // the first --amm implementation paired on transaction hash and matched 0 of
  // 73 rows, because WinDB returns NUL bytes for an AMM hash. A silent
  // "already have that key, skipping" would keep the wrong figure for ever,
  // and nothing on screen would say the import had done nothing.
  const db = createDb(tmpDbPath());
  db.importAmmLedger([ammRow('AMMWithdraw', '2025-01-01 00:00:00.1', 100)]);
  db.importAmmLedger([ammRow('AMMWithdraw', '2025-01-01 00:00:00.1', 663.23, { note: 'corrected' })]);
  const rows = db.getAmmLedger();
  assert.strictEqual(rows.length, 1, 'replaced, not appended');
  assert.strictEqual(rows[0].delivered, 663.23);
  assert.strictEqual(rows[0].note, 'corrected');
  db.close();
});

test('the same timestamp on different types, or different wallets, are distinct rows', () => {
  // A deposit and a withdrawal really can share a second, and the same second
  // occurs across wallets. Keying on timestamp alone would silently collapse
  // them and lose a transaction's figure.
  const db = createDb(tmpDbPath());
  db.importAmmLedger([
    ammRow('AMMWithdraw', '2025-01-01 00:00:00', 1),
    ammRow('AMMDeposit', '2025-01-01 00:00:00', 2),
    ammRow('AMMWithdraw', '2025-01-01 00:00:00', 3, { wallet: 'rTESTwa11etXRPL2222222222222222222' }),
  ]);
  assert.strictEqual(db.getAmmStats().rows, 3);
  db.close();
});

test('clearAll wipes the cache but KEEPS imported AMM amounts', () => {
  // Deliberate. These are not cached WinDB rows; they are an independent
  // measurement that costs roughly an hour of sweeping a full-history node to
  // reproduce, and they stay correct across a re-fetch because the same rows
  // come back under the same (wallet, type, timestamp) keys. Folding them into
  // the cache wipe would quietly destroy the only copy of figures the cache
  // itself cannot supply.
  const db = createDb(tmpDbPath());
  db.insertRows('rWALLET', 'XRPL', [cacheRow('2024-01-01 00:00:00', 'A')]);
  db.importAmmLedger([ammRow('AMMWithdraw', '2025-01-01 00:00:00', 105.5)]);
  db.clearAll();
  assert.strictEqual(db.countForWallet('rWALLET', 'XRPL'), 0, 'cache is gone');
  assert.strictEqual(db.getAmmStats().rows, 1, 'imported AMM figures survive');
  db.close();
});

test('clearAmmLedger drops them when that is actually what was meant', () => {
  const db = createDb(tmpDbPath());
  db.importAmmLedger([ammRow('AMMWithdraw', '2025-01-01 00:00:00', 105.5)]);
  db.clearAmmLedger();
  assert.strictEqual(db.getAmmStats().rows, 0);
  db.close();
});

test('ledger-affected rows are ordinary cache rows under a marked key, removable as a set', () => {
  const db = createDb(tmpDbPath());
  const mk = (h, ts) => ({ tx_hash: h, timestamp: ts, raw_json: JSON.stringify({ TransactionType: 'Payment', TransactionResult: 'tesSUCCESS', Timestamp: ts }) });
  db.insertRows('rHOST', 'Xahau', [mk('AFFECTED:' + 'A'.repeat(64) + ':EVR', '2025-01-01 00:00:00'), mk('AFFECTED:' + 'B'.repeat(64) + ':EVR', '2025-01-02 00:00:00')]);
  db.insertRows('rTENANT', 'Xahau', [mk('AFFECTED:' + 'C'.repeat(64) + ':EVR', '2025-01-03 00:00:00')]);
  db.insertRows('rHOST', 'Xahau', [mk('2025-01-04 00:00:00_rHOST', '2025-01-04 00:00:00')]);   // an ordinary WinDB row
  assert.deepStrictEqual(db.countAffected(), { rows: 3, wallets: 2 });
  // the engine's stream sees them like any other Payment
  assert.strictEqual(db.countForChain('Xahau'), 4);
  // a re-import of the same transaction replaces, never duplicates
  db.insertRows('rHOST', 'Xahau', [mk('AFFECTED:' + 'A'.repeat(64) + ':EVR', '2025-01-01 00:00:00')]);
  assert.strictEqual(db.countAffected().rows, 3);
  assert.strictEqual(db.clearAffected(), 3);
  assert.deepStrictEqual(db.countAffected(), { rows: 0, wallets: 0 });
  assert.strictEqual(db.countForChain('Xahau'), 1, 'the ordinary row must survive');
  db.close();
});

test('imported AMM amounts survive a restart', () => {
  const p = tmpDbPath();
  const first = createDb(p);
  first.importAmmLedger([ammRow('AMMWithdraw', '2025-01-01 00:00:00.1', 105.5)]);
  first.close();
  const second = createDb(p);
  assert.strictEqual(second.getAmmLedger()[0].delivered, 105.5);
  second.close();
});

test('importAmmLedger on an empty list is a no-op, not an error', () => {
  const db = createDb(tmpDbPath());
  assert.strictEqual(db.importAmmLedger([]), 0);
  assert.strictEqual(db.importAmmLedger(null), 0);
  db.close();
});

test('getSyncTimes and getTxHashes answer the on-chain check, read-only', () => {
  const db = createDb(tmpDbPath());
  db.insertRows('rTESTsyncA', 'XRPL', [
    { tx_hash: 'A'.repeat(64), timestamp: '2026-01-01 00:00:00', raw_json: '{}' },
    { tx_hash: 'AFFECTED:' + 'B'.repeat(64) + ':native', timestamp: '2026-01-02 00:00:00', raw_json: '{}' },
  ]);
  db.insertRows('rTESTsyncA', 'Xahau', [{ tx_hash: 'C'.repeat(64), timestamp: '2026-01-01 00:00:00', raw_json: '{}' }]);
  db.upsertSyncState('rTESTsyncA', 'XRPL', '2026-01-02 00:00:00');
  const st = db.getSyncTimes();
  assert.strictEqual(st.length, 1);
  assert.strictEqual(st[0].wallet, 'rTESTsyncA');
  assert.strictEqual(st[0].chain, 'XRPL');
  assert.ok(st[0].last_synced_at);
  assert.deepStrictEqual(db.getTxHashes('rTESTsyncA', 'XRPL').sort(), ['A'.repeat(64), 'AFFECTED:' + 'B'.repeat(64) + ':native']);
  assert.deepStrictEqual(db.getTxHashes('rTESTsyncA', 'Xahau'), ['C'.repeat(64)]);
  db.close();
});

console.log('');
if (failures > 0) {
  console.log(`${failures} test(s) FAILED`);
  process.exit(1);
} else {
  console.log('All db.js tests passed');
  process.exit(0);
}
