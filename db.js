// db.js — local SQLite cache of raw WinDB rows + per-wallet/chain sync cursors.
//
// This is the piece that makes repeat runs fast: every raw transaction row
// this app has ever fetched from WinDB is kept here, keyed so it can never
// be double-stored, alongside a "how far have we synced" cursor per
// wallet+chain. On the next run, the fetch layer asks WinDB only for rows
// newer than that cursor, merges them in, and the tax-calculation engine
// rebuilds its in-memory ledger from the full local cache — no network
// call needed at all for data that's already been synced.
//
// Deliberately framework-free (plain better-sqlite3 calls) so it can be
// required both from main.js (inside Electron) and directly from a plain
// Node test script (test/db.test.js) with no Electron runtime involved.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS raw_transactions (
  wallet      TEXT NOT NULL,
  chain       TEXT NOT NULL,          -- 'XRPL' | 'Xahau'
  tx_hash     TEXT NOT NULL,
  timestamp   TEXT NOT NULL,          -- WinDB's native Timestamp string; same value used for ORDER BY there
  raw_json    TEXT NOT NULL,          -- JSON.stringify() of the exact row WinDB returned
  fetched_at  TEXT NOT NULL,          -- ISO time we pulled this row, for audit/debugging only
  PRIMARY KEY (wallet, chain, tx_hash)
);
CREATE INDEX IF NOT EXISTS idx_raw_tx_wallet_chain_ts ON raw_transactions(wallet, chain, timestamp);

-- Serves the chain-wide, globally time-ordered read that the FIFO engine
-- needs (see getChainRowsPage). Without it, producing one chronological
-- stream across every wallet meant loading every row for a chain into the
-- renderer and sorting there — about 2.2 GB for a 4.6M-row Xahau cache,
-- which is what put the renderer over its heap ceiling and killed it
-- mid-rebuild. With it, SQLite does the ordering and the renderer only ever
-- holds one page.
--
-- The column order matters: (chain) narrows, (timestamp) gives the ordering,
-- and (wallet, tx_hash) make the sort key a total order so keyset pagination
-- can resume exactly where the previous page stopped, with no duplicated or
-- skipped rows when many transactions share a timestamp.
--
-- NOTE: on an existing large cache, creating this runs once at first launch
-- after upgrading and can take tens of seconds.
CREATE INDEX IF NOT EXISTS idx_raw_tx_chain_ts ON raw_transactions(chain, timestamp, wallet, tx_hash);

CREATE TABLE IF NOT EXISTS sync_state (
  wallet          TEXT NOT NULL,
  chain           TEXT NOT NULL,
  last_timestamp  TEXT,              -- max Timestamp synced so far; NULL = never synced (full history needed)
  last_synced_at  TEXT,              -- ISO wall-clock time of the last successful sync
  PRIMARY KEY (wallet, chain)
);

CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

const SCHEMA_VERSION = 1;

function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get('schema_version');
  if (!row) {
    db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  }
  return db;
}

// ── Statements are prepared once per DB handle for speed ───────────────────
function makeApi(db) {
  const stmts = {
    getSyncState: db.prepare('SELECT last_timestamp FROM sync_state WHERE wallet = ? AND chain = ?'),
    // last_synced_at is ALWAYS written; only last_timestamp is guarded
    // against moving backward.
    //
    // The guard used to be a WHERE on the whole DO UPDATE, so it suppressed
    // both columns together. Re-syncing a wallet whose newest transaction is
    // old (a dormant wallet, where the computed cursor equals what's already
    // stored) wrote nothing at all — so "Last synced" in the Local Data panel
    // kept showing a date from months earlier immediately after a successful
    // sync, which reads exactly like the sync silently failing.
    upsertSyncState: db.prepare(`
      INSERT INTO sync_state (wallet, chain, last_timestamp, last_synced_at)
      VALUES (@wallet, @chain, @last_timestamp, @last_synced_at)
      ON CONFLICT(wallet, chain) DO UPDATE SET
        last_synced_at = excluded.last_synced_at,
        last_timestamp = CASE
          WHEN excluded.last_timestamp IS NOT NULL
           AND (sync_state.last_timestamp IS NULL
                OR excluded.last_timestamp > sync_state.last_timestamp)
          THEN excluded.last_timestamp
          ELSE sync_state.last_timestamp
        END
    `),
    touchSyncedAt: db.prepare(`
      INSERT INTO sync_state (wallet, chain, last_timestamp, last_synced_at)
      VALUES (@wallet, @chain, NULL, @last_synced_at)
      ON CONFLICT(wallet, chain) DO UPDATE SET last_synced_at = excluded.last_synced_at
    `),
    insertRow: db.prepare(`
      INSERT OR IGNORE INTO raw_transactions (wallet, chain, tx_hash, timestamp, raw_json, fetched_at)
      VALUES (@wallet, @chain, @tx_hash, @timestamp, @raw_json, @fetched_at)
    `),
    getAllRows: db.prepare(`
      SELECT raw_json FROM raw_transactions
      WHERE wallet = ? AND chain = ?
      ORDER BY timestamp ASC
    `),
    countForWallet: db.prepare(`
      SELECT COUNT(*) AS n FROM raw_transactions WHERE wallet = ? AND chain = ?
    `),
    clearWalletChain: db.prepare('DELETE FROM raw_transactions WHERE wallet = ? AND chain = ?'),
    clearWalletSync: db.prepare('DELETE FROM sync_state WHERE wallet = ? AND chain = ?'),
    resetAllSyncState: db.prepare('DELETE FROM sync_state'),
    clearEverything_tx: db.prepare('DELETE FROM raw_transactions'),
    clearEverything_sync: db.prepare('DELETE FROM sync_state'),
    statsOverall: db.prepare(`
      SELECT
        COUNT(*) AS total_rows,
        COUNT(DISTINCT wallet) AS wallets_with_data,
        MIN(timestamp) AS earliest,
        MAX(timestamp) AS latest
      FROM raw_transactions
    `),
    statsSync: db.prepare(`
      SELECT MAX(last_synced_at) AS last_synced_at, COUNT(*) AS synced_pairs
      FROM sync_state WHERE last_timestamp IS NOT NULL
    `),
    listCachedWallets: db.prepare(`
      SELECT DISTINCT wallet FROM raw_transactions ORDER BY wallet
    `),
    // One page of a chain's rows, in true global chronological order across
    // every wallet, resuming after a caller-supplied cursor.
    //
    // Keyset pagination, not LIMIT/OFFSET: OFFSET makes SQLite walk and
    // discard every earlier row on each page, so paging through millions of
    // rows degrades quadratically. Comparing against the last row seen keeps
    // every page an index seek regardless of how deep it is.
    chainRowsFirstPage: db.prepare(`
      SELECT wallet, timestamp, tx_hash, raw_json
      FROM raw_transactions
      WHERE chain = ?
      ORDER BY timestamp, wallet, tx_hash
      LIMIT ?
    `),
    chainRowsNextPage: db.prepare(`
      SELECT wallet, timestamp, tx_hash, raw_json
      FROM raw_transactions
      WHERE chain = @chain
        AND ( timestamp > @ts
           OR (timestamp = @ts AND wallet > @wallet)
           OR (timestamp = @ts AND wallet = @wallet AND tx_hash > @tx_hash) )
      ORDER BY timestamp, wallet, tx_hash
      LIMIT @limit
    `),
    countForChain: db.prepare(`
      SELECT COUNT(*) AS n FROM raw_transactions WHERE chain = ?
    `),
  };

  // Parameter order matches the public insertRows(wallet, chain, ...) exactly.
  // It used to be declared (chain, wallet, ...) while the caller passed
  // (chain, wallet, ...) to match — correct, but a trap: both columns are
  // TEXT holding short strings, so "tidying" the mismatch at either end alone
  // would write every row with wallet='XRPL' and chain='rXXXX…'. No error, no
  // constraint violation, and the existing tests would still pass, because
  // they read back through the same swapped convention.
  const insertRowsTxn = db.transaction((wallet, chain, rows, nowIso) => {
    let inserted = 0;
    for (const r of rows) {
      const info = stmts.insertRow.run({
        wallet,
        chain,
        tx_hash: r.tx_hash,
        timestamp: r.timestamp,
        raw_json: r.raw_json,
        fetched_at: nowIso,
      });
      if (info.changes > 0) inserted++;
    }
    return inserted;
  });

  // Both clears run as ONE transaction, and delete the cursor BEFORE the
  // rows.
  //
  // These used to be two bare statements in the opposite order, which meant a
  // crash, a force-quit, or a SQLITE_BUSY between them could leave the single
  // state this whole design must never reach: rows gone, cursor still
  // claiming "synced through T". Every later fetch would then ask WinDB only
  // for `Timestamp >= T`, so all history before T stayed permanently
  // invisible — no error, nothing in the UI, just a Form 8949 quietly missing
  // years of acquisitions, and FIFO falling back to $0 basis for disposals it
  // could no longer match. That is a realistic sequence, not a theoretical
  // one: `DELETE FROM raw_transactions` across millions of rows takes long
  // enough to look like a hang, which invites exactly the force-quit that
  // splits the pair.
  //
  // Ordering cursor-first makes even a torn write safe: the worst outcome
  // becomes a redundant re-fetch, never silent data loss.
  const clearWalletChainTxn = db.transaction((wallet, chain) => {
    stmts.clearWalletSync.run(wallet, chain);
    stmts.clearWalletChain.run(wallet, chain);
  });

  const clearAllTxn = db.transaction(() => {
    stmts.clearEverything_sync.run();
    stmts.clearEverything_tx.run();
  });

  return {
    /** @returns {string|null} the max Timestamp already synced for this wallet+chain, or null if never synced */
    getSyncState(wallet, chain) {
      const row = stmts.getSyncState.get(wallet, chain);
      return row ? row.last_timestamp : null;
    },

    /**
     * Insert a batch of raw rows for one wallet+chain in a single transaction.
     * rows: [{ tx_hash, timestamp, raw_json }]. Duplicate (wallet, chain, tx_hash)
     * rows are silently ignored (INSERT OR IGNORE), so re-fetching an
     * overlapping time window (e.g. the incremental cursor's own boundary
     * row) is always safe.
     * @returns {number} rows actually inserted (excludes duplicates)
     */
    insertRows(wallet, chain, rows) {
      if (!rows || rows.length === 0) return 0;
      return insertRowsTxn(wallet, chain, rows, new Date().toISOString());
    },

    /**
     * Advance the sync cursor for wallet+chain to newTimestamp, but only if
     * it's actually newer than what's stored (defends against an out-of-order
     * call ever moving the cursor backward). Always stamps last_synced_at.
     */
    upsertSyncState(wallet, chain, newTimestamp) {
      const now = new Date().toISOString();
      if (newTimestamp) {
        stmts.upsertSyncState.run({ wallet, chain, last_timestamp: newTimestamp, last_synced_at: now });
      } else {
        // Nothing new was fetched this run, but we did check — still worth
        // recording that we tried, for the "last synced" display.
        stmts.touchSyncedAt.run({ wallet, chain, last_synced_at: now });
      }
    },

    /** @returns {object[]} every cached row for wallet+chain, oldest first, as the original WinDB row shape */
    getAllRows(wallet, chain) {
      return stmts.getAllRows.all(wallet, chain).map(r => JSON.parse(r.raw_json));
    },

    countForWallet(wallet, chain) {
      return stmts.countForWallet.get(wallet, chain).n;
    },

    /** @returns {number} total cached rows for one chain, across every wallet */
    countForChain(chain) {
      return stmts.countForChain.get(chain).n;
    },

    /**
     * One page of a chain's cached rows, ordered by (timestamp, wallet,
     * tx_hash) across ALL wallets — i.e. the true chronological stream the
     * FIFO engine requires, produced by SQLite instead of by sorting
     * millions of rows in the renderer.
     *
     * Pass `cursor` as null for the first page, then hand back the `cursor`
     * from the previous result. Returns `{rows, cursor}` where rows is
     * `[{wallet, row}]` and `cursor` is null once the stream is exhausted.
     *
     * @param {'XRPL'|'Xahau'} chain
     * @param {number} limit rows per page
     * @param {{ts:string, wallet:string, tx_hash:string}|null} cursor
     */
    getChainRowsPage(chain, limit, cursor) {
      const raw = cursor
        ? stmts.chainRowsNextPage.all({ chain, limit, ts: cursor.ts, wallet: cursor.wallet, tx_hash: cursor.tx_hash })
        : stmts.chainRowsFirstPage.all(chain, limit);
      if (raw.length === 0) return { rows: [], cursor: null };
      const last = raw[raw.length - 1];
      return {
        rows: raw.map(r => ({ wallet: r.wallet, row: JSON.parse(r.raw_json) })),
        // Only continue if the page was full; a short page means we're done.
        cursor: raw.length < limit
          ? null
          : { ts: last.timestamp, wallet: last.wallet, tx_hash: last.tx_hash },
      };
    },

    /** Drop all cached rows AND the sync cursor for one wallet+chain — next fetch re-pulls complete history for just that pair. */
    clearWalletChain(wallet, chain) {
      clearWalletChainTxn(wallet, chain);
    },

    /** Keep cached rows, but drop every sync cursor — next fetch re-requests complete history from WinDB for every wallet (still dedups against what's cached, so it's a re-verify, not a data-loss operation). */
    forceFullResync() {
      stmts.resetAllSyncState.run();
    },

    /** Hard reset — wipes all cached rows and all sync cursors. */
    clearAll() {
      clearAllTxn();
    },

    /** Aggregate stats for the "Local Data" panel. */
    getStats() {
      const overall = stmts.statsOverall.get();
      const sync = stmts.statsSync.get();
      return {
        totalRows: overall.total_rows || 0,
        walletsWithData: overall.wallets_with_data || 0,
        earliest: overall.earliest || null,
        latest: overall.latest || null,
        lastSyncedAt: sync.last_synced_at || null,
        syncedPairs: sync.synced_pairs || 0,
      };
    },

    /**
     * Every wallet address that has at least one cached row, across both
     * chains combined. This is what lets the app rebuild a full report
     * straight from the local cache — with no Payment-Claim, no network
     * access, and independent of whatever's currently ticked in the Setup
     * tab's wallet checklist — since the checklist is just UI state while
     * this is the actual durable record of what's been synced.
     * @returns {string[]}
     */
    listCachedWallets() {
      return stmts.listCachedWallets.all().map(r => r.wallet);
    },

    close() {
      db.close();
    },

    _raw: db, // escape hatch for tests
  };
}

/**
 * Open (creating if needed) the SQLite cache at dbPath and return the API
 * object above. Kept as a separate factory (rather than opening at require()
 * time) so tests can point at a throwaway temp file per test run.
 */
function createDb(dbPath) {
  const db = openDb(dbPath);
  return makeApi(db);
}

module.exports = { createDb };
