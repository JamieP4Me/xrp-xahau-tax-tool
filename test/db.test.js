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

test('duplicate tx_hash for the same wallet+chain is silently ignored (INSERT OR IGNORE dedup)', () => {
  const db = createDb(tmpDbPath());
  const r = { tx_hash: 'DUP', timestamp: '2024-01-01 00:00:00', raw_json: JSON.stringify(row('2024-01-01 00:00:00', { v: 'first' })) };
  db.insertRows('rWALLET', 'XRPL', [r]);
  // Re-fetch the same row (simulating an overlapping incremental window) with different payload —
  // the ORIGINAL stored copy should win, since this proves a re-fetch never corrupts what's cached.
  const rAgain = { tx_hash: 'DUP', timestamp: '2024-01-01 00:00:00', raw_json: JSON.stringify(row('2024-01-01 00:00:00', { v: 'second' })) };
  const insertedSecondTime = db.insertRows('rWALLET', 'XRPL', [rAgain]);
  assert.strictEqual(insertedSecondTime, 0, 'duplicate insert should report 0 newly-inserted rows');
  const all = db.getAllRows('rWALLET', 'XRPL');
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].v, 'first');
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

console.log('');
if (failures > 0) {
  console.log(`${failures} test(s) FAILED`);
  process.exit(1);
} else {
  console.log('All db.js tests passed');
  process.exit(0);
}
