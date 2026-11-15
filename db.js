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

-- Ledger-verified AMM amounts, imported from scripts/verify-xrpl.js --amm.
--
-- This table exists because WinDB's Amount_XRP on an AMM transaction is the
-- amount the transaction REQUESTED, and the ledger routinely delivered more.
-- Measured across one wallet's real history: of 47 rows where both figures
-- exist, 24 disagreed, and every single comparable AMMWithdraw (18 of 18) was
-- understated — by 1,582 XRP in total, one of them by 563 XRP. Booking the
-- requested figure would understate acquisitions by that much.
--
-- The correct figure is |balance delta + fee| read from the transaction's own
-- ledger metadata, which WinDB does not expose. The verifier sweeps account_tx
-- on a full-history node to get it; this is where the answer lands so the
-- renderer can use it without any network access of its own.
--
-- The key is (wallet, tx_type, timestamp) rather than the transaction hash for
-- a reason that cost a whole rewrite of the verifier: WinDB returns
-- TransactionHash as 64 NUL bytes on every AMM row, so there is no hash on the
-- cache side to join against. The timestamp here is the CACHE's own timestamp
-- string, copied verbatim from the CSV, so the lookup is an exact string match
-- against raw_transactions.timestamp — no parsing, no rounding, no timezone.
--
-- ledger_hash is the real hash the cache does not have. Keeping it turns these
-- rows into the audit trail for the AMM entries on a return.
CREATE TABLE IF NOT EXISTS amm_ledger (
  wallet      TEXT NOT NULL,
  tx_type     TEXT NOT NULL,          -- 'AMMDeposit' | 'AMMWithdraw'
  timestamp   TEXT NOT NULL,          -- the cache's Timestamp string, verbatim
  ledger_hash TEXT,                   -- real tx hash from the ledger; '' if unpaired
  submitted   REAL,                   -- what WinDB had (the requested amount); NULL if none
  delivered   REAL,                   -- |balance delta + fee| from ledger metadata; NULL if unpaired
  flags       INTEGER,                -- the ledger's Flags, for withdrawal-mode reporting
  note        TEXT,                   -- verifier's caveats: near-miss pairing, ambiguity, failures
  imported_at TEXT NOT NULL,
  PRIMARY KEY (wallet, tx_type, timestamp)
);

-- A finished report, saved so it does not have to be rebuilt. Building the
-- report means reading every cached row (millions) through the FIFO engine;
-- the result is the same until the data or a setting that decides it changes.
-- One row per AMM treatment, so switching between them is a load, not a
-- rebuild. \`stamp\` fingerprints everything the build depends on (data
-- version, app version, prices, wallet classifications, basis inputs); a
-- saved report is only ever loaded when its stamp matches exactly.
-- \`data\` is the engine's state, v8-serialized and gzipped by main.js.
-- XRPL trades read from the ledger (1.10.14). WinDB holds what a transaction
-- ASKED for; what an offer or a swap actually moved is only in the ledger's
-- own metadata, and a trade filled by someone else's transaction is not in
-- WinDB under this wallet at all. The app reads each wallet's transactions
-- from a full-history node and stores the ones that moved a token as cache
-- rows keyed 'LEDGER:<hash>' (AMM transactions: 'LEDGERAMM:<hash>').
--
-- This table records how far each wallet has been read. It matters for the
-- figures, not only for resuming: an OfferCreate inside the range that has no
-- ledger row is an offer that did not trade, and is no longer booked as a
-- sale of the amount offered. So it must never claim more than is stored:
-- every operation that removes cached XRPL rows removes the matching entry
-- here in the same transaction.
CREATE TABLE IF NOT EXISTS ledger_sweep (
  wallet          TEXT NOT NULL,
  chain           TEXT NOT NULL,
  through_ledger  INTEGER NOT NULL,   -- every transaction up to and including this ledger was read
  through_ts      TEXT NOT NULL,      -- that ledger's close time, in the cache's Timestamp format
  swept_at        TEXT NOT NULL,
  txs             INTEGER NOT NULL,   -- transactions read so far, all sweeps
  stored          INTEGER NOT NULL,   -- of those, how many moved a token and were stored
  PRIMARY KEY (wallet, chain)
);

CREATE TABLE IF NOT EXISTS report_cache (
  key       TEXT PRIMARY KEY,
  stamp     TEXT NOT NULL,
  saved_at  TEXT NOT NULL,
  bytes     INTEGER NOT NULL,
  data      BLOB NOT NULL
);
`;

const SCHEMA_VERSION = 1;

function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Read-side tuning. The ledger build streams millions of rows in timestamp
  // order, so the wins here are cache residency and avoiding an fsync per
  // transaction during a multi-million-row sync.
  //
  //   synchronous=NORMAL  WAL already makes this crash-safe; FULL costs an
  //                       fsync per commit and buys durability against OS
  //                       crash only, which a re-syncable cache does not need.
  //   cache_size          negative = KiB, so this is 256 MB of page cache.
  //   mmap_size           256 MB mapped, so hot pages skip the read() syscall.
  //   temp_store=MEMORY   index builds and sorts stay off disk.
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -262144');
  db.pragma('mmap_size = 268435456');
  db.pragma('temp_store = MEMORY');
  db.exec(SCHEMA);
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get('schema_version');
  if (!row) {
    db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  }
  return db;
}

// ── Statements are prepared once per DB handle for speed ───────────────────
function makeApi(db) {
  // ── tx_type: the filter that stops the ledger reading rows it discards ──
  //
  // ADD COLUMN is O(1) on a virtual generated column: SQLite records the
  // expression in the schema and computes it on read. It is safe to run at
  // startup on a cache of any size.
  //
  // CREATING THE INDEX IS NOT, AND MUST NOT HAPPEN HERE.
  //
  // The first version of this built the index at startup. better-sqlite3 is
  // synchronous, so that blocked the Electron main process while SQLite ran
  // json_extract over 6,348,182 rows — and the app opened to a blank window
  // because main never got far enough to load the renderer. "Tens of seconds"
  // was a guess, stated as if measured, in a startup path where being wrong
  // means the application does not start.
  //
  // So the index is built by an explicit offline step (npm run cache:optimise)
  // and this only ever looks to see whether it is there. No index, no filter:
  // getChainRowsPage falls back to reading everything, exactly as before.
  try {
    const cols = db.prepare('PRAGMA table_info(raw_transactions)').all().map(c => c.name);
    if (!cols.includes('tx_type')) {
      db.exec(`ALTER TABLE raw_transactions ADD COLUMN tx_type TEXT
               GENERATED ALWAYS AS (json_extract(raw_json, '$.TransactionType')) VIRTUAL`);
    }
  } catch (e) {
    if (!/generated|syntax|duplicate column/i.test(String(e && e.message))) throw e;
  }

  // Present only after the offline optimise step has run.
  let hasTypeIndex = false;
  try {
    hasTypeIndex = !!db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_raw_tx_chain_type_ts'`
    ).get();
  } catch (e) { hasTypeIndex = false; }

  const stmts = {
    getMeta: db.prepare('SELECT value FROM app_meta WHERE key = ?'),
    setMeta: db.prepare(`
      INSERT INTO app_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `),
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
    // UPSERT, not INSERT OR IGNORE.
    //
    // OR IGNORE silently discarded any row already cached, which made a
    // "Force Full Re-sync" incapable of the one job it exists for: backfilling
    // columns added to the SELECT list after the cache was built. Measured on
    // the real cache: a full re-sync fetched 5,593,824 Xahau rows, paid the
    // Payment-Claim for every one of them, and kept the new columns on only
    // 13,820 — the rows that happened to be new transactions. 171 of 174
    // Remits still carried no amounts, and fees existed for 2026 alone.
    //
    // The WHERE clause keeps it a no-op when the content is byte-identical, so
    // an ordinary incremental sync still reports only genuinely changed rows
    // and does not churn fetched_at across millions of rows.
    //
    // Safe on the primary key because makeTxHash() is deterministic: a real
    // TransactionHash where one exists, and a stable (timestamp + wallet)
    // otherwise. The same transaction always lands on the same key.
    insertRow: db.prepare(`
      INSERT INTO raw_transactions (wallet, chain, tx_hash, timestamp, raw_json, fetched_at)
      VALUES (@wallet, @chain, @tx_hash, @timestamp, @raw_json, @fetched_at)
      ON CONFLICT(wallet, chain, tx_hash) DO UPDATE SET
        timestamp  = excluded.timestamp,
        raw_json   = excluded.raw_json,
        fetched_at = excluded.fetched_at
      WHERE raw_transactions.raw_json <> excluded.raw_json
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
    // What is actually in the cache, by type. The honest way to show what a
    // filter excludes rather than asserting it excludes nothing important.
    countByType: db.prepare(`
      SELECT COALESCE(tx_type, '(none)') AS t, COUNT(*) AS n
      FROM raw_transactions WHERE chain = ?
      GROUP BY t ORDER BY n DESC
    `),
    // Re-importing a corrected CSV must REPLACE, not accumulate. An UPSERT
    // rather than INSERT OR IGNORE because the second run of the verifier is
    // the one that fixed the figures, and a silent "already there, skipping"
    // would keep the wrong ones.
    insertAmmRow: db.prepare(`
      INSERT INTO amm_ledger (wallet, tx_type, timestamp, ledger_hash, submitted, delivered, flags, note, imported_at)
      VALUES (@wallet, @tx_type, @timestamp, @ledger_hash, @submitted, @delivered, @flags, @note, @imported_at)
      ON CONFLICT(wallet, tx_type, timestamp) DO UPDATE SET
        ledger_hash = excluded.ledger_hash,
        submitted   = excluded.submitted,
        delivered   = excluded.delivered,
        flags       = excluded.flags,
        note        = excluded.note,
        imported_at = excluded.imported_at
    `),
    getAmmLedger: db.prepare(`
      SELECT wallet, tx_type, timestamp, ledger_hash, submitted, delivered, flags, note
      FROM amm_ledger ORDER BY timestamp ASC
    `),
    clearAmmLedger: db.prepare('DELETE FROM amm_ledger'),
    statsAmm: db.prepare(`
      SELECT COUNT(*) AS n,
             SUM(CASE WHEN delivered IS NOT NULL THEN 1 ELSE 0 END) AS with_delivered,
             MAX(imported_at) AS imported_at
      FROM amm_ledger
    `),
  };

  // Parameter order matches the public insertRows(wallet, chain, ...) exactly.
  // It used to be declared (chain, wallet, ...) while the caller passed
  // (chain, wallet, ...) to match — correct, but a trap: both columns are
  // TEXT holding short strings, so "tidying" the mismatch at either end alone
  // would write every row with wallet='XRPL' and chain='rXXXX…'. No error, no
  // constraint violation, and the existing tests would still pass, because
  // they read back through the same swapped convention.
  // Returns rows WRITTEN — inserted plus updated — not rows newly created.
  // A re-sync that refreshes a cached row with richer columns has done real
  // work and must not report zero.
  // Every change to what a build would read bumps this number. A saved report
  // records the number it was built from; a different number means rebuild.
  // Counting changes is exact where a row count is not: an upsert that
  // replaces a row's JSON changes the data without changing the count.
  const bumpDataVersion = () => {
    const cur = Number((stmts.getMeta.get('dataVersion') || {}).value || 0);
    stmts.setMeta.run('dataVersion', String(cur + 1));
  };

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
    if (inserted > 0) bumpDataVersion();
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
    // The ledger rows for this wallet go with the rest, so the record of how
    // far it was read must go too (see ledger_sweep).
    db.prepare('DELETE FROM ledger_sweep WHERE wallet = ? AND chain = ?').run(wallet, chain);
    if (stmts.clearWalletChain.run(wallet, chain).changes > 0) bumpDataVersion();
  });

  const clearAllTxn = db.transaction(() => {
    stmts.clearEverything_sync.run();
    stmts.clearEverything_tx.run();
    db.prepare('DELETE FROM ledger_sweep').run();
    db.prepare('DELETE FROM report_cache').run();
    bumpDataVersion();
    // amm_ledger is deliberately NOT cleared here. It is not cached WinDB
    // data; it is an independent measurement that costs an hour of sweeping a
    // full-history node to reproduce, and it stays correct across a re-fetch
    // because its key is (wallet, type, timestamp) — the same rows come back
    // under the same keys. Wiping it with the cache would quietly discard the
    // only copy of figures the cache cannot supply. clearAmmLedger() exists
    // for when dropping it is actually what was meant.
  });

  const importAmmLedgerTxn = db.transaction((rows, nowIso) => {
    let n = 0;
    for (const r of rows) {
      stmts.insertAmmRow.run({
        wallet: r.wallet,
        tx_type: r.tx_type,
        timestamp: r.timestamp,
        ledger_hash: r.ledger_hash || '',
        submitted: Number.isFinite(r.submitted) ? r.submitted : null,
        delivered: Number.isFinite(r.delivered) ? r.delivered : null,
        flags: Number.isFinite(r.flags) ? r.flags : null,
        note: r.note || '',
        imported_at: nowIso,
      });
      n++;
    }
    if (n > 0) bumpDataVersion();
    return n;
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
    countForChain(chain, types) {
      if (!hasTypeIndex || !Array.isArray(types) || types.length === 0) {
        return stmts.countForChain.get(chain).n;
      }
      const holes = types.map(() => '?').join(',');
      return db.prepare(
        `SELECT COUNT(*) AS n FROM raw_transactions WHERE chain = ? AND tx_type IN (${holes})`
      ).get(chain, ...types).n;
    },

    /** Whether the offline optimise step has run on this cache. */
    hasTypeIndex() { return hasTypeIndex; },

    /** Build the type index. Minutes on a large cache — never call at startup. */
    buildTypeIndex() {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_raw_tx_chain_type_ts
               ON raw_transactions(chain, tx_type, timestamp, wallet, tx_hash)`);
      hasTypeIndex = true;
      return true;
    },

    /** Rows by transaction type, so a filter can show its own working. */
    countByType(chain) {
      return stmts.countByType.all(chain).map(r => ({ type: r.t, n: r.n }));
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
    /**
     * Rows for a chain, in one global chronological order, one page at a time.
     *
     * `types` is optional. When given, only those transaction types are
     * returned and the rest never leave SQLite -- they are not read, not
     * JSON.parsed, and not marshalled across the IPC boundary. That is the
     * whole speed-up: the cost was never the query, it was parsing 6.3M
     * objects and cloning them into the renderer to discard most of them.
     *
     * Omit it and the behaviour is exactly as before, so nothing silently
     * changes the set of rows the tax engine sees unless a caller asks.
     */
    getChainRowsPage(chain, limit, cursor, types) {
      // Without the index, `tx_type IN (...)` means json_extract on every row
      // at query time — slower than reading everything. Refuse rather than
      // make it worse.
      const useFilter = hasTypeIndex && Array.isArray(types) && types.length > 0;
      let raw;
      if (useFilter) {
        const holes = types.map(() => '?').join(',');
        const sql = cursor
          ? `SELECT wallet, timestamp, tx_hash, raw_json FROM raw_transactions
             WHERE chain = ? AND tx_type IN (${holes})
               AND ( timestamp > ?
                  OR (timestamp = ? AND wallet > ?)
                  OR (timestamp = ? AND wallet = ? AND tx_hash > ?) )
             ORDER BY timestamp, wallet, tx_hash LIMIT ?`
          : `SELECT wallet, timestamp, tx_hash, raw_json FROM raw_transactions
             WHERE chain = ? AND tx_type IN (${holes})
             ORDER BY timestamp, wallet, tx_hash LIMIT ?`;
        const args = cursor
          ? [chain, ...types, cursor.ts, cursor.ts, cursor.wallet,
             cursor.ts, cursor.wallet, cursor.tx_hash, limit]
          : [chain, ...types, limit];
        raw = db.prepare(sql).all(...args);
      } else {
        raw = cursor
          ? stmts.chainRowsNextPage.all({ chain, limit, ts: cursor.ts, wallet: cursor.wallet, tx_hash: cursor.tx_hash })
          : stmts.chainRowsFirstPage.all(chain, limit);
      }
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

    /**
     * Small key/value store for facts ABOUT the cache rather than in it.
     *
     * It exists for one problem in particular. The sync cursor answers "how
     * far forward have we fetched?", and nothing answers "what did we ask
     * for?" — so when the app widened its WinDB type filter in v1.3.0, every
     * existing cache said "synced through today" while holding none of the
     * newly-requested types. The user would have been shown an empty
     * "nothing is missing" box that was only true of a question never asked.
     * The renderer stores its fetch scope here and re-syncs when it changes.
     */
    getMeta(key) {
      const row = stmts.getMeta.get(key);
      return row ? row.value : null;
    },

    setMeta(key, value) {
      stmts.setMeta.run(key, value == null ? null : String(value));
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

    /**
     * Replace-or-insert ledger-verified AMM amounts, one transaction.
     * rows: [{ wallet, tx_type, timestamp, ledger_hash, submitted, delivered, flags, note }]
     * @returns {number} rows written
     */
    importAmmLedger(rows) {
      if (!rows || rows.length === 0) return 0;
      return importAmmLedgerTxn(rows, new Date().toISOString());
    },

    /**
     * Every imported AMM row, oldest first. The renderer loads these once per
     * rebuild and keys them by wallet|type|timestamp — small enough (tens to
     * low hundreds of rows) that paging would be pointless ceremony.
     */
    getAmmLedger() {
      return stmts.getAmmLedger.all();
    },

    /** Counts for the disclosure panel: how many rows, how many actually carry a ledger figure. */
    getAmmStats() {
      const r = stmts.statsAmm.get() || {};
      return {
        rows: r.n || 0,
        withDelivered: r.with_delivered || 0,
        importedAt: r.imported_at || null,
      };
    },

    /** Drop the imported AMM figures. Separate from clearAll() on purpose — see the note there. */
    /**
     * Rows imported from a ledger sweep (scripts/affected-sweep.js): the
     * transactions that moved a wallet's balance while it was neither sender
     * nor destination, stored as ordinary cache rows under a marked key so the
     * engine books them like any other Payment and they can be removed as a
     * set. The key prefix is the only thing that distinguishes them.
     */
    countAffected() {
      const r = db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT wallet) AS w FROM raw_transactions WHERE tx_hash LIKE 'AFFECTED:%'").get();
      return { rows: r.n || 0, wallets: r.w || 0 };
    },
    clearAffected() {
      const n = db.prepare("DELETE FROM raw_transactions WHERE tx_hash LIKE 'AFFECTED:%'").run().changes;
      if (n > 0) bumpDataVersion();
      return n;
    },

    clearAmmLedger() {
      stmts.clearAmmLedger.run();
      bumpDataVersion();
    },

    /**
     * XRPL trades read from the ledger (see ledger_sweep above).
     * Keys: which transactions each wallet has a ledger row for. AMM rows
     * ('LEDGERAMM:') are stored but not returned here: they do not replace
     * the AMM booking, which stays with the AMM treatment setting.
     * @returns {{wallet:string, tx_hash:string}[]}
     */
    getLedgerTradeKeys(chain) {
      return db.prepare("SELECT wallet, tx_hash FROM raw_transactions WHERE chain = ? AND tx_hash LIKE 'LEDGER:%'").all(String(chain));
    },
    /** @returns {{wallet, chain, through_ledger, through_ts, swept_at, txs, stored}[]} */
    getLedgerSweeps() {
      return db.prepare('SELECT wallet, chain, through_ledger, through_ts, swept_at, txs, stored FROM ledger_sweep ORDER BY wallet, chain').all();
    },
    /**
     * Record how far one wallet has been read.
     *
     * The range decides one thing in a build: whether an OfferCreate with no
     * ledger row is booked. So the data version is bumped only when the range
     * newly covers such a row (or is new). A routine read that finds nothing
     * and only moves the end date forward leaves saved reports valid; bumping
     * every time would force a full rebuild after every download.
     */
    setLedgerSweep(s) {
      if (!s || typeof s.wallet !== 'string' || (s.chain !== 'XRPL' && s.chain !== 'Xahau')) throw new Error('ledger sweep: bad wallet or chain');
      const through = Number(s.through_ledger);
      if (!Number.isInteger(through) || through <= 0) throw new Error('ledger sweep: bad ledger index');
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(s.through_ts))) throw new Error('ledger sweep: bad timestamp');
      const prev = db.prepare('SELECT through_ledger, through_ts FROM ledger_sweep WHERE wallet = ? AND chain = ?').get(s.wallet, s.chain);
      // Never move the range backwards: it would un-cover rows already booked from the ledger.
      if (prev && through < prev.through_ledger) throw new Error('ledger sweep: range cannot move backwards');
      db.prepare(`INSERT INTO ledger_sweep (wallet, chain, through_ledger, through_ts, swept_at, txs, stored)
                  VALUES (?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(wallet, chain) DO UPDATE SET through_ledger = excluded.through_ledger,
                    through_ts = excluded.through_ts, swept_at = excluded.swept_at, txs = excluded.txs, stored = excluded.stored`)
        .run(s.wallet, s.chain, through, String(s.through_ts), new Date().toISOString(), Number(s.txs) || 0, Number(s.stored) || 0);
      let matters = !prev;
      if (prev) {
        try {
          matters = !!db.prepare(`SELECT 1 FROM raw_transactions WHERE wallet = ? AND chain = ? AND timestamp > ? AND timestamp <= ?
                                  AND tx_type = 'OfferCreate' LIMIT 1`).get(s.wallet, s.chain, prev.through_ts, String(s.through_ts));
        } catch (e) { matters = true; }   // cannot tell: say it changed
      }
      if (matters) bumpDataVersion();
      return matters;
    },
    /** Remove every ledger-read row and the record of what was read. @returns {number} rows removed */
    clearLedgerTrades() {
      const run = db.transaction(() => {
        const swept = db.prepare('DELETE FROM ledger_sweep').run().changes;
        const n = db.prepare("DELETE FROM raw_transactions WHERE tx_hash LIKE 'LEDGER:%' OR tx_hash LIKE 'LEDGERAMM:%'").run().changes;
        if (n > 0 || swept > 0) bumpDataVersion();
        return n;
      });
      return run();
    },

    /** The number every data change bumps (see bumpDataVersion). '0' on a cache that predates it. */
    getDataVersion() {
      return String((stmts.getMeta.get('dataVersion') || {}).value || '0');
    },

    /**
     * Saved reports. `data` is a Buffer (main.js serializes and compresses);
     * this layer only stores and returns bytes.
     */
    saveReport(key, stamp, data) {
      db.prepare(`INSERT INTO report_cache (key, stamp, saved_at, bytes, data) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET stamp = excluded.stamp, saved_at = excluded.saved_at,
                  bytes = excluded.bytes, data = excluded.data`)
        .run(key, stamp, new Date().toISOString(), data.length, data);
    },
    /** The saved bytes for key, only if saved under exactly this stamp. */
    loadReport(key, stamp) {
      const r = db.prepare('SELECT stamp, saved_at, data FROM report_cache WHERE key = ?').get(key);
      if (!r || r.stamp !== stamp) return null;
      return { savedAt: r.saved_at, data: r.data };
    },
    reportInfo() {
      return db.prepare('SELECT key, stamp, saved_at, bytes FROM report_cache ORDER BY key').all();
    },
    clearReports() {
      return db.prepare('DELETE FROM report_cache').run().changes;
    },

    /**
     * When each wallet+chain was last synced. The on-chain balance check uses
     * it to choose the ledger it compares at: a point every wallet's download
     * had already reached.
     * @returns {{wallet:string, chain:string, last_timestamp:string|null, last_synced_at:string|null}[]}
     */
    getSyncTimes() {
      return db.prepare('SELECT wallet, chain, last_timestamp, last_synced_at FROM sync_state ORDER BY wallet, chain').all();
    },

    /**
     * Every cached tx_hash for one wallet+chain, as stored (64-hex, doubled
     * 128-hex, AFFECTED:<id>:<asset>, or a synthetic id). The explain view
     * uses it to tell "never downloaded" from "downloaded but not booked".
     * @returns {string[]}
     */
    /**
     * One wallet's cached rows between two Timestamp strings (from inclusive,
     * to exclusive), oldest first, at most `limit`. The explain view lists the
     * downloaded transactions of each day where the books and the ledger part.
     * @returns {{tx_hash:string, timestamp:string, raw_json:string}[]}
     */
    getRowsBetween(wallet, chain, from, to, limit) {
      return db.prepare(`SELECT tx_hash, timestamp, raw_json FROM raw_transactions
                         WHERE wallet = ? AND chain = ? AND timestamp >= ? AND timestamp < ?
                         ORDER BY timestamp LIMIT ?`).all(wallet, chain, String(from), String(to), Math.max(1, Math.min(Number(limit) || 100, 1000)));
    },

    getTxHashes(wallet, chain) {
      return db.prepare('SELECT tx_hash FROM raw_transactions WHERE wallet = ? AND chain = ?').pluck().all(wallet, chain);
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
