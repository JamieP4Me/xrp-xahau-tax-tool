#!/usr/bin/env node
/**
 * Independent verification of the XRPL side of the local cache, against a
 * full-history XRPL node cluster.
 *
 * WHY THIS EXISTS
 *
 * Everything this tool reports comes from one source: WinDB, via Dhali. If
 * WinDB omits a transaction, or if a flattened amount field is wrong, nothing
 * anywhere in the app can tell — Form 8949 is built from the cache, the
 * consistency check compares the cache to itself, and the totals look exactly
 * as healthy as they would if they were right. That is a bad property for
 * numbers going on a tax return.
 *
 * xrplcluster.com is a free, geo-distributed cluster of XRPL FULL HISTORY
 * servers run by InFTF (listed on xrpl.org alongside Dhali's paid API in the
 * full-history group). It speaks plain JSON-RPC, needs no key and no
 * Payment-Claim, and it is a genuinely independent path to the same ledger.
 *
 * Two questions get answered, and the first matters more:
 *
 *   1. COMPLETENESS — does the cache hold every XRPL transaction the ledger
 *      has for these accounts? A missing disposal is silently missing income.
 *      This is the failure the app cannot self-detect at all.
 *
 *   2. AMOUNTS — for transactions present in both, does the amount the app
 *      booked match the balance change the ledger actually applied? The
 *      ledger's own metadata (meta.AffectedNodes) records the before/after
 *      Balance of each account touched. That is the canonical number.
 *      WinDB's delivered_amount_XRP is derived, and derived amount fields
 *      have already produced two real bugs in this project: a units error
 *      that turned 12,000 XRP into 0.012, and Amount-vs-delivered_amount on
 *      partial payments.
 *
 * CHAINS. Defaults to XRPL against xrplcluster. `--chain Xahau` points the
 * same reconciliation at https://xahau.network/ — unproven for full history,
 * which is exactly what running it establishes. It does
 * not check tax treatment; FIFO, holding periods and the gift/lost/exchange
 * classification are all downstream of this and unaffected by it. It reads
 * the cache and writes a report. It never writes to the database.
 *
 * USAGE
 *
 *   node scripts/verify-xrpl.js                    # all XRPL wallets
 *   node scripts/verify-xrpl.js --wallet rXXXX     # just one
 *   node scripts/verify-xrpl.js --limit 25         # first N wallets
 *   node scripts/verify-xrpl.js --out report.csv   # also write a CSV
 *   node scripts/verify-xrpl.js --db /path/to.sqlite3
 *   node scripts/verify-xrpl.js --chain Xahau --limit 3   # test Xahau
 *
 * Run it with the SAME Node the db tests use (plain Node ABI):
 *
 *   npm rebuild better-sqlite3 && node scripts/verify-xrpl.js
 *   npm run rebuild            # switch back for the app/Playwright
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Where the cache lives ─────────────────────────────────────────────────
// Same path main.js derives from Electron's app.getPath('userData'), spelled
// out per-platform because this script runs under plain Node with no Electron
// around to ask.
function defaultDbPath() {
  const name = 'XRP & Xahau Tax Tool';
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', name, 'tax-data.sqlite3');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), name, 'tax-data.sqlite3');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name, 'tax-data.sqlite3');
}

// ── The node cluster ──────────────────────────────────────────────────────
// Overridable so the same reconciliation can be pointed at a Xahau node.
// Xahau is ~94% of this cache and the fetch has the identical type-filter bug,
// but nothing has verified it against a real ledger yet — xrplcluster is XRPL
// only. Whether an equivalent Xahau endpoint exists, with full history AND
// transaction metadata, decides the whole fix: metadata is the ONLY place the
// amounts for AMMWithdraw, ClaimReward, NFTokenAcceptOffer and EscrowFinish
// exist. WinDB has no column for any of them.
let RPC_URL = process.env.XRPL_RPC || 'https://xrplcluster.com/';
let CHAIN = 'XRPL';          // which cached chain to reconcile
let UNIT = 'XRP';            // what the native amounts are called

// Public infrastructure, run for free by other people. xrpl.org is explicit
// that public servers are "not for sustained or business use", and the cluster
// enforces that with a units quota — 2,000 per 10s and 10,000 per 60s — where
// a page of account_tx costs units in proportion to how much it returns.
//
// The first version of this script asked for 200 rows every 250ms and was
// refused on three of five addresses. Note what that failure looked like: the
// two BUSIEST accounts failed and the small ones succeeded, so the run
// reported "284 missing" while having barely looked at the wallets holding
// 26,000 of the 27,000 cached rows. A rate-limited audit does not fail
// loudly; it produces a confident, partial, misleading answer.
const PAGE_LIMIT = 100;        // smaller pages cost fewer units each
let PAUSE_MS = 1200;           // between requests; lowered on a paid endpoint

// ── Paying to go faster ───────────────────────────────────────────────────
//
// xrplcluster.com is XRPL Labs' free public cluster, and its limits are the
// reason a full reconciliation takes hours: 1.2s between requests, backing
// off further every time it answers "tooBusy". XRPL Labs' own paid path for
// exactly this is Dhali — the same provider already used for WinDB — reached
// at https://run.api.dhali.io/<key>/ with a Payment-Claim.
//
// The claim comes from the ENVIRONMENT, never from a command-line argument:
// argv lands in shell history, in `ps` output, and in any log that echoes the
// command. It is read once, sent as a header, and never printed — not in the
// endpoint banner, not in an error message, not in the CSV. Nothing in this
// project ever persists a Payment-Claim, and this is no exception.
const PAYMENT_CLAIM = process.env.DHALI_PAYMENT_CLAIM || '';
const PAID = !!PAYMENT_CLAIM;
if (PAID) PAUSE_MS = 120;      // an order of magnitude faster, still polite
const MAX_RETRIES = 6;
const RATE_LIMIT_ERRORS = new Set(['tooBusy', 'slowDown', 'noNetwork', 'noCurrent', 'tooManyRequests']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The cluster tells you exactly how long to wait — "retry in ~5293ms". Not
// reading that and guessing an exponential backoff instead is how you get
// refused repeatedly and then give up while the endpoint was willing all
// along.
function retryHintMs(message) {
  const m = /retry in ~?(\d+)\s*ms/i.exec(String(message || ''));
  if (!m) return null;
  const ms = parseInt(m[1], 10);
  return Number.isFinite(ms) ? ms : null;
}

async function rpc(method, params) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (PAID) headers['Payment-Claim'] = PAYMENT_CLAIM;
      const res = await fetch(RPC_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ method, params: [params] }),
      });

      if (res.status === 429 || res.status === 503) {
        const hint = retryHintMs(res.headers.get('retry-after'));
        lastErr = new Error('HTTP ' + res.status);
        await sleep((hint || 5000) + 500);
        continue;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);

      const body = await res.json();
      const err = body.result && body.result.error;
      if (err) {
        // actNotFound is a real answer, not a failure — the account has never
        // been funded, so the ledger genuinely holds nothing for it.
        if (err === 'actNotFound') return { notFound: true };
        const msg = err + (body.result.error_message ? ': ' + body.result.error_message : '');
        if (RATE_LIMIT_ERRORS.has(err)) {
          // Wait what it asked for, plus a margin, and try again. These are
          // JSON-RPC-level errors with HTTP 200, which is why the first
          // version's status-code check never saw them.
          const wait = (retryHintMs(msg) || 10000) + 1000;
          lastErr = new Error(msg);
          await sleep(wait);
          continue;
        }
        throw new Error(msg);
      }
      return body.result;
    } catch (e) {
      lastErr = e;
      // A network-level failure gets a plain backoff; there is no hint to read.
      if (attempt < MAX_RETRIES) await sleep(2000 * (attempt + 1));
    }
  }
  throw lastErr || new Error('request failed');
}

// ── The canonical amount ──────────────────────────────────────────────────
//
// Every transaction's metadata lists the ledger entries it modified. For an
// AccountRoot, PreviousFields.Balance and FinalFields.Balance are the account's
// XRP balance in DROPS before and after. Their difference is what the ledger
// actually did to that account — the one number no intermediary can get wrong.
//
// Three cases have to be handled or the delta is silently wrong:
//   - ModifiedNode with no PreviousFields.Balance: the entry changed for some
//     other reason (a sequence bump), balance did not move. Contributes 0.
//   - CreatedNode: the account did not exist before, so its previous balance
//     is 0 and NewFields carries the starting balance.
//   - DeletedNode: an account being deleted; FinalFields holds the last
//     balance, and the delta is negative.
const DROPS = 1e6;

// Mirrors DUST_MIN_UNITS in renderer/index.html. Anything below this is
// skipped by the ledger engine as spam or fee-level noise, so a missing one
// is incapable of changing a tax figure.
const DUST_MIN_UNITS = 1.0;

function xrpDeltaFor(meta, account) {
  if (!meta || !Array.isArray(meta.AffectedNodes)) return null;
  let drops = 0;
  let seen = false;

  for (const wrapper of meta.AffectedNodes) {
    const node = wrapper.ModifiedNode || wrapper.CreatedNode || wrapper.DeletedNode;
    if (!node || node.LedgerEntryType !== 'AccountRoot') continue;

    const final = node.FinalFields || node.NewFields || {};
    const prev = node.PreviousFields || {};
    if (final.Account !== account) continue;

    seen = true;
    if (wrapper.CreatedNode) {
      drops += Number(final.Balance || 0);
    } else if (wrapper.DeletedNode) {
      // Balance goes to zero; what it held is what left.
      const before = prev.Balance != null ? Number(prev.Balance) : Number(final.Balance || 0);
      drops -= before;
    } else {
      // A ModifiedNode without PreviousFields.Balance did not move XRP.
      if (prev.Balance == null) continue;
      drops += Number(final.Balance || 0) - Number(prev.Balance);
    }
  }

  if (!seen) return null;
  return drops / DROPS;
}

// The fee is paid by the sending account and is included in the balance delta
// above. Comparing a delta against a payment amount therefore has to add it
// back, or every outbound payment looks short by the fee (~0.00001-0.0001 XRP
// — small, but it would flag every single outbound row as a mismatch).
function feeXrp(tx) {
  const f = Number(tx && tx.Fee);
  return Number.isFinite(f) ? f / DROPS : 0;
}

// ── Reading the cache ─────────────────────────────────────────────────────
function loadCache(dbPath) {
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (e) {
    console.error(
      '\nCould not load better-sqlite3 for plain Node.\n' +
      'It is currently built for Electron. Run:\n\n' +
      '    npm rebuild better-sqlite3 && node scripts/verify-xrpl.js\n\n' +
      'and afterwards `npm run rebuild` to switch it back for the app.\n'
    );
    process.exit(1);
  }
  if (!fs.existsSync(dbPath)) {
    console.error(`\nNo cache found at:\n    ${dbPath}\n\nPass --db /path/to/tax-data.sqlite3 if it lives elsewhere.\n`);
    process.exit(1);
  }
  // readonly: this script must never be able to modify the tax data it audits.
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const wallets = db.prepare(
    `SELECT wallet, COUNT(*) AS n FROM raw_transactions WHERE chain = '${CHAIN}' GROUP BY wallet ORDER BY n DESC`
  ).all();
  const rowsFor = db.prepare(
    `SELECT tx_hash, timestamp, raw_json FROM raw_transactions WHERE chain = '${CHAIN}' AND wallet = ?`
  );
  return { db, wallets, rowsFor };
}

// The cache stores whatever makeTxHash() produced. Where WinDB supplied a real
// TransactionHash it is the ledger hash, hex-encoded from WinDB's byte string
// — 64 hex characters. Where WinDB supplied nothing it is a synthetic
// "<timestamp>_<wallet>" id, which cannot be matched against the ledger at
// all. Counting those separately matters: a cache full of synthetic ids would
// make this report look clean while verifying nothing.
const REAL_HASH = /^[0-9A-F]{64}$/;
const DOUBLED_HASH = /^[0-9A-F]{128}$/;

// Returns the ledger hash a cached id represents, or null if it carries none.
//
// makeTxHash() hex-encodes WinDB's TransactionHash character by character.
// That is right when WinDB returns 32 raw bytes and wrong when it returns the
// hash as text that is already hexadecimal — in which case the stored id is
// 128 characters, the correct 64 buried inside a second layer of encoding.
//
// Treating those as unmatchable is what made a healthy wallet report every
// single one of its 146 ledger transactions as "missing from your cache",
// which is precisely the kind of false alarm that gets an audit tool ignored.
function ledgerHashOf(cachedId) {
  const s = (cachedId || '').toUpperCase();
  if (REAL_HASH.test(s)) return s;
  if (DOUBLED_HASH.test(s)) {
    const decoded = decodeDoubled(s);
    if (REAL_HASH.test(decoded)) return decoded;
  }
  return null;
}

function cachedAmountXrp(raw) {
  // Mirrors what processOneXRPLRow() actually books, so a mismatch here is a
  // mismatch in the number that reached Form 8949 — not in some other field.
  const v = raw.delivered_amount_XRP != null ? raw.delivered_amount_XRP : raw.Amount_XRP;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// ── Per-wallet reconciliation ─────────────────────────────────────────────
async function verifyWallet(wallet, cacheRows, report) {
  const ledger = new Map();   // hash -> { tx, meta, date }
  let marker;
  let pages = 0;

  for (;;) {
    const params = {
      account: wallet,
      ledger_index_min: -1,     // -1/-1 asks the FULL HISTORY range
      ledger_index_max: -1,
      binary: false,
      forward: false,
      limit: PAGE_LIMIT,
    };
    if (marker) params.marker = marker;

    const res = await rpc('account_tx', params);
    if (res.notFound) {
      report.notFound.push(wallet);
      return;
    }
    for (const entry of res.transactions || []) {
      const tx = entry.tx || entry.tx_json || {};
      const hash = (entry.hash || tx.hash || '').toUpperCase();
      if (!hash) continue;
      // Only successful transactions move money. The app applies the same
      // filter (tesSUCCESS), so including failures here would manufacture
      // "missing from cache" rows that are correctly absent.
      const code = entry.meta && entry.meta.TransactionResult;
      if (code && code !== 'tesSUCCESS') continue;
      ledger.set(hash, { tx, meta: entry.meta, validated: entry.validated });
    }
    pages++;
    // Progress WITHIN a wallet, not just between them. The busiest account
    // here is ~237 pages at ~1.2s each — five minutes of a blank terminal,
    // which reads as a hang. A long job that says nothing is indistinguishable
    // from a broken one.
    if (pages % 5 === 0) {
      // Pad to clear the previous, longer line. Writing a shorter string over
      // a longer one leaves its tail behind — which is what ate the "[1/5]
      // rG9RH… " prefix and left a bare "ok" floating in the output.
      process.stdout.write(`\r      … ${ledger.size.toLocaleString()} ledger tx so far (${pages} pages)`.padEnd(78));
    }
    marker = res.marker;
    if (!marker) break;
    await sleep(PAUSE_MS);
  }

  if (pages >= 5) process.stdout.write('\r' + ' '.repeat(78) + '\r');
  report.pages += pages;

  const cachedByHash = new Map();
  let synthetic = 0;
  let doubled = 0;
  for (const r of cacheRows) {
    const h = ledgerHashOf(r.tx_hash);
    if (h) {
      cachedByHash.set(h, r);
      if (DOUBLED_HASH.test((r.tx_hash || '').toUpperCase())) doubled++;
    } else {
      synthetic++;
    }
  }
  report.synthetic += synthetic;
  report.doubled += doubled;

  // ── Date-range comparison ───────────────────────────────────────────
  // The single most diagnostic line in the whole report. If the cache's
  // earliest row is years after the ledger's, nothing is "missing" in the
  // sense of a WinDB bug — that wallet was simply never synced from the
  // start, and the fix is a re-sync, not an investigation.
  const cachedTimes = cacheRows.map((r) => r.timestamp).filter(Boolean).sort();
  const ledgerTimes = [...ledger.values()].map((l) => rippleTimeToIso(l.tx.date)).filter(Boolean).sort();
  report.ranges.push({
    wallet,
    cachedRows: cacheRows.length,
    ledgerRows: ledger.size,
    cachedFrom: cachedTimes[0] || '', cachedTo: cachedTimes[cachedTimes.length - 1] || '',
    ledgerFrom: ledgerTimes[0] || '', ledgerTo: ledgerTimes[ledgerTimes.length - 1] || '',
  });

  // ── 1. Completeness ─────────────────────────────────────────────────
  //
  // Hash matching is exact and preferred. But WinDB does not always return
  // TransactionHash, and makeTxHash() then falls back to a synthetic
  // "<timestamp>_<wallet>" id — which on a real wallet meant ZERO of 140 rows
  // could be matched, so all 146 ledger transactions were reported missing.
  // A verifier that reports 435,663 XRP of phantom missing data is not
  // cautious, it is broken.
  //
  // The synthetic id still carries the timestamp, to nanoseconds. Truncated to
  // the second it matches the ledger's own transaction time, so completeness
  // is still answerable — just with a weaker key. Multiplicities are compared
  // rather than doing a 1:1 mapping, because two transactions CAN share a
  // second, and the honest answer there is "this second holds 3 on the ledger
  // and 2 in your cache", not an arbitrary pairing.
  if (cachedByHash.size === 0 && cacheRows.length > 0) {
    report.timestampMatched.push(wallet);
    const cachedPerSecond = new Map();
    let cachedFailed = 0;
    for (const r of cacheRows) {
      // Count only SUCCESSFUL cached rows, because the ledger side already
      // excludes failures. Counting all of them compared unlike with unlike:
      // a second holding one failed cached row and one successful ledger
      // transaction looked matched when the successful one was absent. That
      // asymmetry can only ever HIDE a missing transaction, never invent one,
      // so it made the finding count a floor rather than a total.
      let ok = true;
      try {
        const raw = JSON.parse(r.raw_json);
        const res = raw.TransactionResult;
        if (res != null && res !== '' && res !== 'tesSUCCESS') ok = false;
      } catch { /* unparseable — count it, and let the mismatch surface */ }
      if (!ok) { cachedFailed++; continue; }
      const k = toSecond(r.timestamp);
      if (k) cachedPerSecond.set(k, (cachedPerSecond.get(k) || 0) + 1);
    }
    report.cachedFailed += cachedFailed;
    const lastRange = report.ranges[report.ranges.length - 1];
    if (lastRange && lastRange.wallet === wallet) {
      lastRange.cachedFailed = cachedFailed;
      lastRange.cachedSuccess = cacheRows.length - cachedFailed;
    }
    const ledgerBySecond = new Map();
    for (const [hash, l] of ledger) {
      const k = rippleTimeToIso(l.tx.date);
      if (!ledgerBySecond.has(k)) ledgerBySecond.set(k, []);
      ledgerBySecond.get(k).push([hash, l]);
    }
    for (const [k, entries] of ledgerBySecond) {
      const have = cachedPerSecond.get(k) || 0;
      // Only the surplus is missing. If the ledger has 3 in this second and
      // the cache has 2, one is missing — not three.
      const surplus = entries.length - have;
      if (surplus <= 0) continue;
      // Report the largest first within the second, so if only some are
      // missing the material ones surface rather than the spam.
      const ranked = entries
        .map(([hash, l]) => ({ hash, l, delta: xrpDeltaFor(l.meta, wallet) }))
        .sort((a, b) => Math.abs(b.delta || 0) - Math.abs(a.delta || 0));
      for (const { hash, l, delta } of ranked.slice(0, surplus)) {
        report.missing.push({
          wallet, hash, matchedBy: 'timestamp',
          type: l.tx.TransactionType || '?',
          date: rippleTimeToIso(l.tx.date),
          xrpDelta: delta,
          dust: delta != null && Math.abs(delta) < DUST_MIN_UNITS,
          // A null delta means the account did not appear as a modified
          // AccountRoot, so the amount could not be computed at all. That is
          // NOT the same as "material", and lumping the two together reported
          // "26 material discrepancies" when 25 of them had no known value —
          // an unknown is a question, not a finding.
          unknown: delta == null,
        });
      }
    }
    return;   // amount comparison needs a hash-level pairing; not available here
  }

  for (const [hash, l] of ledger) {
    if (cachedByHash.has(hash)) continue;
    const delta = xrpDeltaFor(l.meta, wallet);
    report.missing.push({
      wallet, hash, matchedBy: 'hash',
      type: l.tx.TransactionType || '?',
      date: rippleTimeToIso(l.tx.date),
      xrpDelta: delta,
      // The app ignores anything under DUST_MIN_UNITS (1.0 XRP) as spam, so a
      // missing one-drop payment changes no tax figure. Separating these is
      // not cosmetic: the first run buried a real 9.7 XRP outbound payment
      // under 280 rows of one-drop spam, where it was found by luck. A report
      // that trains you to skim is worse than no report.
      dust: delta != null && Math.abs(delta) < DUST_MIN_UNITS,
    });
  }
  for (const hash of cachedByHash.keys()) {
    if (!ledger.has(hash)) report.extra.push({ wallet, hash });
  }

  // ── 2. Amounts ──────────────────────────────────────────────────────
  for (const [hash, l] of ledger) {
    const cached = cachedByHash.get(hash);
    if (!cached) continue;
    if ((l.tx.TransactionType || '') !== 'Payment') continue;

    let raw;
    try { raw = JSON.parse(cached.raw_json); } catch { continue; }

    // Only XRP-denominated payments are comparable to an XRP balance delta.
    // An issued-currency payment moves no XRP beyond the fee.
    const amt = l.tx.Amount;
    if (amt != null && typeof amt === 'object') continue;

    const bookedXrp = cachedAmountXrp(raw);
    if (bookedXrp == null) continue;

    const delta = xrpDeltaFor(l.meta, wallet);
    if (delta == null) continue;

    const isSender = l.tx.Account === wallet;
    // Outbound: the account lost amount + fee. Add the fee back to compare
    // like for like against the payment amount the app booked.
    const ledgerAmount = isSender ? -(delta + feeXrp(l.tx)) : delta;

    report.compared++;
    const diff = Math.abs(ledgerAmount - bookedXrp);
    // A drop is 1e-6 XRP; anything at or below that is representation noise.
    if (diff > 1e-6) {
      report.mismatch.push({
        wallet, hash,
        date: rippleTimeToIso(l.tx.date),
        direction: isSender ? 'out' : 'in',
        booked: bookedXrp,
        ledger: ledgerAmount,
        diff,
      });
    }
  }
}

// WinDB timestamps carry sub-second precision ("2020-08-30 19:35:20.367000023").
// The ledger records whole seconds, so matching has to happen at that
// resolution — and both are UTC, which is the only reason this is safe.
function toSecond(ts) {
  if (!ts) return '';
  const s = String(ts).replace('T', ' ').trim();
  return s.length >= 19 ? s.slice(0, 19) : '';
}

// Ripple epoch is 2000-01-01T00:00:00Z, 946684800 seconds after the Unix one.
function rippleTimeToIso(rippleSeconds) {
  if (!Number.isFinite(rippleSeconds)) return '';
  return new Date((rippleSeconds + 946684800) * 1000).toISOString().replace('T', ' ').slice(0, 19);
}


// ── --probe ───────────────────────────────────────────────────────────────
//
// Offline. Dumps everything the cache holds within a given minute for one
// wallet, so a specific "missing" finding can be checked by eye instead of
// argued about from counts.
//
// Counts alone could not settle the rG9RH case: that wallet has MORE cached
// rows than the ledger has successful transactions, yet the tool reported
// transactions missing. Both can be true at once, and the only way to know
// which is which is to look at one.
function probeCache(dbPath, wallet, second) {
  const { db, rowsFor } = loadCache(dbPath);
  if (!wallet) { console.error('--probe needs --wallet too.'); process.exit(1); }

  const minute = second.slice(0, 16);          // YYYY-MM-DD HH:MM
  const rows = rowsFor.all(wallet).filter((r) => toSecond(r.timestamp).slice(0, 16) === minute);
  db.close();

  console.log(`\nCache rows for ${wallet} in the minute ${minute}: ${rows.length}\n`);
  if (rows.length === 0) {
    console.log('  NOTHING. If the ledger has a transaction here, the cache genuinely lacks it.\n');
    return;
  }
  for (const r of rows.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))) {
    let raw = {};
    try { raw = JSON.parse(r.raw_json); } catch { /* shown as unparseable below */ }
    const amt = raw.delivered_amount_XRP != null ? raw.delivered_amount_XRP : raw.Amount_XRP;
    console.log(`  ${String(r.timestamp).slice(0, 26).padEnd(28)} ${String(raw.TransactionType || '?').padEnd(14)}` +
                ` ${String(raw.TransactionResult || '?').padEnd(14)} ${String(amt == null ? '—' : amt).padStart(18)} XRP`);
    console.log(`    from ${raw.Account || '?'}`);
    console.log(`    to   ${raw.Destination || '(none)'}`);
  }
  console.log('');
}

// ── --amm : is the submitted Amount the amount that actually moved? ───────
//
// The app now shows an amount for every cached AMMDeposit and AMMWithdraw,
// read from WinDB's Amount_XRP. Those figures are NOT booked on Form 8949,
// and the stated reason is a hedge: "amount as submitted, which can differ
// from what was delivered." On an AMMWithdraw the submitted Amount can be a
// bound rather than an exact figure — tfLPToken and tfTwoAsset withdrawals
// ask for an LP-token quantity and take whatever it redeems for. This settles
// that from the ledger instead of guessing.
//
// MATCHING BY TIME, NOT BY HASH.
//
// The first cut of this looked each cached row up by its transaction hash and
// found nothing to check: 0 of 73. WinDB returns TransactionHash as 64 NUL
// bytes for these types, so the cache stores a synthetic "<timestamp>_<wallet>"
// id instead — a fact already recorded elsewhere in this very file, and built
// over anyway.
//
// So this sweeps the account's own history with account_tx, exactly as
// verifyWallet() does, and pairs ledger transactions with cached rows on
// (type, second). That needs no hash, no CTID, and — importantly — no
// re-fetch: it works against the cache as it already exists. It is also
// cheaper, one paginated sweep instead of N single lookups.
//
// Where two AMM transactions of the same type land in the same second, they
// are paired in ledger order and the pairing is marked, because "which of
// these two is which" is not answerable from the cache and should not be
// silently assumed.
// AMMWithdraw/AMMDeposit mode flags. Bit values verified against the XRPL
// protocol reference (xrpl.org AMMWithdraw), not recalled.
//
// Which mode a withdrawal used is the whole explanation for the differences,
// because Amount means something different in each:
//
//   tfSingleAsset          exact — withdraw precisely this much
//   tfOneAssetWithdrawAll  a MINIMUM — succeed if it yields at least this
//   tfLPToken              ignored — LPTokenIn decides
//   tfWithdrawAll          ignored — all LP tokens returned
//   tfTwoAsset             a maximum per asset, pool proportions decide
//   tfOneAssetLPToken      a bound
//   tfLimitLPToken         a maximum, with an EPrice ceiling
//
// That matches the measurement for tfOneAssetWithdrawAll exactly: a minimum,
// and the ledger delivered more on 10 of 14.
//
// It does NOT cleanly explain tfOneAssetLPToken, where the reference describes
// Amount as an UPPER bound and yet all 8 measured rows came in ABOVE it, by a
// consistent +2.56%. Unresolved. Recorded here rather than smoothed over,
// because the honest position is that the ledger delta is ground truth for tax
// and the documented mechanism is a partial explanation — the measurement does
// not depend on the explanation being complete.
const AMM_FLAGS = [
  [0x00010000, 'tfLPToken'],
  [0x00020000, 'tfWithdrawAll'],
  [0x00040000, 'tfOneAssetWithdrawAll'],
  [0x00080000, 'tfSingleAsset'],
  [0x00100000, 'tfTwoAsset'],
  [0x00200000, 'tfOneAssetLPToken'],
  [0x00400000, 'tfLimitLPToken'],
];
const TF_FULLY_CANONICAL = 0x80000000;   // universal; says nothing about mode

function ammMode(flags) {
  const f = (Number(flags) || 0) & ~TF_FULLY_CANONICAL;
  const hit = AMM_FLAGS.filter(([bit]) => f & bit).map(([, name]) => name);
  return hit.length ? hit.join('+') : (f === 0 ? '(no mode flag)' : '0x' + f.toString(16));
}

async function reconcileAmm(dbPath, walletFilter, limit, csvPath) {
  const { db, wallets, rowsFor } = loadCache(dbPath);
  const AMM_TYPES = new Set(['AMMDeposit', 'AMMWithdraw']);

  let targets = wallets;
  if (walletFilter) targets = targets.filter((w) => w.wallet === walletFilter);
  else if (limit) targets = targets.slice(0, limit);

  console.log(`\nAMM reconciliation — ${CHAIN} · ${RPC_URL}${PAID ? ' (paid)' : ''}`);

  // ── Plan the run before starting it ──
  //
  // A wallet with no cached AMM rows needs no ledger sweep at all, and most
  // wallets here have none. Saying so up front turns "is this hung or just
  // slow?" into a number, and lets the run be abandoned before it starts
  // rather than after twenty minutes.
  const plan = [];
  for (const { wallet } of targets) {
    let n = 0;
    for (const r of rowsFor.all(wallet)) {
      // Cheap substring test before the JSON parse: most rows are Payments,
      // and parsing 27,000 of them per wallet to count a handful is wasteful.
      if (r.raw_json.indexOf('"AMM') === -1) continue;
      try {
        const t = JSON.parse(r.raw_json).TransactionType;
        if (AMM_TYPES.has(t)) n++;
      } catch (e) { /* unparseable row, counted nowhere */ }
    }
    if (n) plan.push({ wallet, n, rows: rowsFor.all(wallet).length });
  }
  const skipped = targets.length - plan.length;
  if (!plan.length) {
    console.log(`None of the ${targets.length} cached ${CHAIN} wallet(s) hold an AMM transaction. Nothing to do.`);
    db.close();
    return;
  }
  console.log(`${plan.length} of ${targets.length} wallet(s) hold AMM transactions` +
              `${skipped ? `; ${skipped} skipped (none cached)` : ''}:`);
  let estPages = 0;
  for (const pl of plan) {
    const pages = Math.max(1, Math.ceil(pl.rows / PAGE_LIMIT));
    estPages += pages;
    console.log(`    ${pl.wallet.slice(0, 14)}…  ${String(pl.n).padStart(4)} AMM tx` +
                `  · ~${pages} page(s) to sweep`);
  }
  const mins = (estPages * (PAUSE_MS + 250)) / 60000;
  console.log(`Roughly ${mins < 1 ? '<1' : Math.ceil(mins)} minute(s) at the current pacing.` +
              `${PAID ? '' : ' Set DHALI_PAYMENT_CLAIM to go ~10x faster.'}\n`);

  const rows = [];
  // THREE outcomes, not two. A row with no submitted amount has nothing to
  // compare, and folding it into either bucket is a lie in one direction:
  //   - counted as differing (the original bug) it reported 45 disagreements
  //     where there were 24, overstating the problem by nearly 2x
  //   - counted as matching it would claim agreement that was never tested
  let cachedTotal = 0, checked = 0, exact = 0, differing = 0, noBasis = 0,
      unmatched = 0, ledgerOnly = 0, failedOnChain = 0;
  const DUST = 1e-6;   // one drop; below this the two agree

  for (const { wallet } of plan) {
    // ── what the cache holds ──
    const cached = [];
    for (const r of rowsFor.all(wallet)) {
      let raw;
      try { raw = JSON.parse(r.raw_json); } catch (e) { continue; }
      if (!AMM_TYPES.has(raw.TransactionType)) continue;
      // A transaction that FAILED on-chain has nothing to reconcile: it moved
      // nothing but the fee, and the tax engine drops it before booking
      // anything (see the tesSUCCESS guard in processOneXRPLRow).
      //
      // This filter was missing while the ledger side had one, and the
      // asymmetry was not harmless. The ledger sweep keeps only tesSUCCESS, so
      // every failed row in the cache was structurally unpairable and got
      // reported as "no ledger AMM tx of this type within a second" — which
      // reads as a hole in the data.
      //
      // Measured on one real cache: all 5 unpaired rows out of 73 were
      // tecAMM_FAILED, clustered in four minutes of retries on 2025-08-27.
      // Every successful AMM transaction paired. The correct verdict was
      // 68 of 68, not 68 of 73 with five unexplained.
      if (raw.TransactionResult && raw.TransactionResult !== 'tesSUCCESS') {
        failedOnChain++;
        continue;
      }
      const submitted = parseFloat(raw.Amount_XRP);
      cached.push({
        type: raw.TransactionType,
        sec: toSecond(r.timestamp),
        ts: r.timestamp,
        submitted: Number.isFinite(submitted) && submitted > 0 ? submitted : null,
      });
    }
    if (!cached.length) continue;
    cachedTotal += cached.length;
    process.stdout.write(`  ${wallet.slice(0, 14)}… ${cached.length} cached AMM tx — sweeping ledger…`.padEnd(78));

    // ── what the ledger holds ──
    const ledgerAmm = [];
    let marker, pages = 0, failed = null;
    for (;;) {
      const params = { account: wallet, ledger_index_min: -1, ledger_index_max: -1,
                       binary: false, forward: false, limit: PAGE_LIMIT };
      if (marker) params.marker = marker;
      let res;
      try { res = await rpc('account_tx', params); }
      catch (e) { failed = e.message; break; }
      if (res.notFound) { failed = 'account not found on this node'; break; }

      for (const entry of res.transactions || []) {
        const tx = entry.tx || entry.tx_json || {};
        if (!AMM_TYPES.has(tx.TransactionType)) continue;
        if (entry.meta && entry.meta.TransactionResult !== 'tesSUCCESS') continue;
        const raw = xrpDeltaFor(entry.meta, wallet);
        if (raw == null) continue;
        // The fee is debited whichever way the value moved, so add it back:
        //   withdrawal  delta = +amount - fee
        //   deposit     delta = -amount - fee
        const delta = Math.abs(raw + feeXrp(tx));
        ledgerAmm.push({
          type: tx.TransactionType,
          sec: rippleTimeToIso(Number(tx.date ?? entry.tx_json?.date)),
          hash: (entry.hash || tx.hash || '').toUpperCase(),
          delta,
          flags: Number(tx.Flags || 0),
        });
      }
      pages++;
      marker = res.marker;
      if (!marker) break;
      await sleep(PAUSE_MS);
    }
    process.stdout.write(`\r${' '.repeat(78)}\r`);
    if (failed) {
      console.log(`  ${wallet.slice(0, 14)}… ledger sweep failed: ${failed}`);
      for (const c of cached) rows.push({ wallet, ...c, delta: null, diff: null, hash: '', note: 'ledger sweep failed' });
      unmatched += cached.length;
      continue;
    }

    // ── pair them ──
    const bucket = new Map();     // "type|second" -> [ledger rows]
    for (const l of ledgerAmm) {
      const k = l.type + '|' + l.sec;
      if (!bucket.has(k)) bucket.set(k, []);
      bucket.get(k).push(l);
    }
    // Pair on the exact second first. Only if that finds nothing, try one
    // second either side — WinDB's timestamp and the ledger's close time can
    // land on opposite sides of a second boundary, which left 5 of 73 rows
    // unpaired on the first real run.
    //
    // A near-miss pairing is MARKED, not silently blended in. Two AMM
    // transactions of the same type a second apart could pair the wrong way
    // round, and a figure that might belong to a different transaction has to
    // say so rather than look like the rest.
    const shiftSec = (sec, by) => {
      const t = Date.parse(sec.replace(' ', 'T') + 'Z');
      return Number.isFinite(t) ? new Date(t + by * 1000).toISOString().replace('T', ' ').slice(0, 19) : sec;
    };
    let paired = 0, nearMiss = 0;
    for (const c of cached) {
      let l = null, off = 0, matchedKey = null;
      for (const by of [0, -1, 1]) {
        const key = c.type + '|' + shiftSec(c.sec, by);
        const list = bucket.get(key);
        if (list && list.length) { l = list.shift(); off = by; matchedKey = key; break; }
      }
      if (!l) {
        unmatched++;
        rows.push({ wallet, ...c, delta: null, diff: null, hash: '',
                    note: 'no ledger AMM tx of this type within a second' });
        continue;
      }
      if (off !== 0) nearMiss++;
      paired++;
      checked++;
      // More than one ledger transaction of this type in that second means the
      // pairing picked one by order. Say so rather than let the number look
      // as settled as the unambiguous ones.
      const ambiguous = (bucket.get(matchedKey) || []).length > 0;
      const diff = c.submitted == null ? null : l.delta - c.submitted;
      if (diff == null) noBasis++;
      else if (Math.abs(diff) <= DUST) exact++;
      else differing++;
      rows.push({ wallet, ...c, delta: l.delta, diff, hash: l.hash, flags: l.flags,
                  note: (c.submitted == null ? 'nothing submitted to compare' : '')
                        + (ambiguous ? ' [same-second pairing, order assumed]' : '')
                        + (off !== 0 ? ` [matched ${off > 0 ? '+' : ''}${off}s away]` : '') });
    }
    const leftover = [...bucket.values()].reduce((n, v) => n + v.length, 0);
    ledgerOnly += leftover;
    console.log(`  ${wallet.slice(0, 14)}… ${cached.length} cached · ${ledgerAmm.length} on ledger · ` +
                `${paired} paired${nearMiss ? ` (${nearMiss} within 1s)` : ''}` +
                `${leftover ? ` · ${leftover} on ledger not in cache` : ''} (${pages} pages)`);
    // Everything found so far survives an interruption from here on.
    writeAmmCsv(csvPath, rows);
  }

  // ── Verdict ──
  console.log('─'.repeat(78));
  console.log(`${cachedTotal} successful cached AMM transaction(s); ${checked} paired with the ledger, ${unmatched} not.`);
  if (failedOnChain) {
    // Reported, not silently dropped — "I excluded some of your data" is a
    // thing the reader has to be told, even when excluding it is right.
    console.log(`${failedOnChain} further AMM transaction(s) FAILED on-chain and were excluded:`);
    console.log(`they moved nothing but the fee, and the tax engine does not book them either.`);
  }
  if (ledgerOnly) {
    console.log(`${ledgerOnly} AMM transaction(s) are on the ledger but NOT in the cache — a completeness`);
    console.log(`gap on top of the amount question. Run without --amm for the full picture.`);
  }
  if (checked) {
    const comparable = exact + differing;
    console.log(`  comparable (an amount on both sides) : ${comparable}`);
    console.log(`    matched the ledger exactly         : ${exact}`);
    console.log(`    differed                           : ${differing}`);
    if (noBasis) {
      console.log(`  no amount cached, nothing to compare : ${noBasis}`);
      console.log(`    (the ledger figure for these is in the CSV regardless)`);
    }
  }

  // ── By withdrawal mode ──
  // Totals say how much is wrong; this says WHICH transactions are wrong, and
  // that is what can be acted on. Printed here rather than left to a second
  // tool, so a 21-wallet run is readable on its own.
  if (checked) {
    const byMode = new Map();
    for (const r of rows) {
      if (r.delta == null) continue;
      const k = r.type + '  ' + ammMode(r.flags);
      if (!byMode.has(k)) byMode.set(k, { n: 0, cmp: 0, exact: 0, diff: 0, tot: 0, pct: [] });
      const e = byMode.get(k);
      e.n++;
      if (r.diff == null) continue;
      e.cmp++; e.tot += r.diff;
      if (Math.abs(r.diff) > DUST) { e.diff++; if (r.submitted) e.pct.push(100 * r.diff / r.submitted); }
      else e.exact++;
    }
    console.log('');
    console.log(`${'Type / mode'.padEnd(38)}${'rows'.padStart(6)}${'cmp'.padStart(6)}` +
                `${'exact'.padStart(7)}${'differ'.padStart(8)}${('net ' + UNIT).padStart(16)}${'median'.padStart(9)}`);
    console.log('─'.repeat(90));
    for (const [k, e] of [...byMode].sort((a, b) => b[1].tot - a[1].tot)) {
      const p = e.pct.slice().sort((a, b) => a - b);
      const med = p.length ? `${p[p.length >> 1] >= 0 ? '+' : ''}${p[p.length >> 1].toFixed(2)}%` : '—';
      console.log(k.padEnd(38) + String(e.n).padStart(6) + String(e.cmp).padStart(6) +
                  String(e.exact).padStart(7) + String(e.diff).padStart(8) +
                  e.tot.toFixed(6).padStart(16) + med.padStart(9));
    }
  }

  const diffs = rows.filter((r) => r.diff != null && Math.abs(r.diff) > DUST);
  if (diffs.length) {
    diffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
    console.log(`\nLargest differences (ledger minus submitted), ${UNIT}:`);
    for (const d of diffs.slice(0, 15)) {
      const pct = d.submitted ? (100 * d.diff / d.submitted) : 0;
      console.log(`  ${d.ts}  ${d.type.padEnd(11)} submitted ${String(d.submitted).padStart(16)}` +
                  `  ledger ${d.delta.toFixed(6).padStart(16)}  diff ${d.diff.toFixed(6).padStart(14)}` +
                  `  (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`);
    }
    if (diffs.length > 15) console.log(`  …and ${diffs.length - 15} more.`);
  }

  console.log('');
  if (checked && differing === 0 && exact === 0) {
    console.log(`VERDICT: none of the ${checked} paired rows had a cached amount to compare.`);
    console.log('The ledger figures are in the CSV, but nothing was verified against them.');
  } else if (checked && differing === 0) {
    console.log('VERDICT: every submitted Amount matched what the ledger moved.');
    console.log('The "as submitted" caveat is unnecessary for these rows — the figures the');
    console.log('app shows are the real ones, and the only thing blocking booking them is');
    console.log('the AMM tax treatment decision, not the data.');
  } else if (checked) {
    const worst = Math.max(...diffs.map((d) => Math.abs(d.diff)));
    const net = diffs.reduce((n, d) => n + d.diff, 0);
    // Denominator is the COMPARABLE rows, not everything paired. Dividing by
    // rows that were never compared makes the rate look worse than it is.
    console.log(`VERDICT: ${differing} of ${exact + differing} comparable rows differ, ` +
                `the largest by ${worst.toFixed(6)} ${UNIT}.`);
    console.log(`Net across all differing rows: ${net >= 0 ? '+' : ''}${net.toFixed(6)} ${UNIT}` +
                `${net > 0 ? ' — the ledger moved MORE than was submitted, so the cached figures are floors.' : '.'}`);
    console.log('The submitted Amount is NOT the delivered amount. The ledger delta in the');
    console.log('CSV is the figure to use; the app should show that instead.');
    console.log('Which modes those are is in the table above; the per-row figures are');
    console.log(`in the CSV${csvPath ? ' at ' + csvPath : ' (pass --out to write one)'}.`);
  } else {
    console.log('VERDICT: nothing could be paired. Nothing is proven either way.');
  }

  writeAmmCsv(csvPath, rows);
  if (csvPath) console.log(`\nWrote ${rows.length} row(s) to ${csvPath}`);
  db.close();
}

// Written after every wallet, not once at the end.
//
// A 21-wallet sweep is a long run against a public endpoint that can and does
// refuse. Holding every row in memory until the last wallet finishes means a
// failure at wallet 19 throws away the work of the first 18 — and the retry
// costs the same hour again. Rewriting the whole file each time is cheap at
// this scale and makes any interruption survivable.
function writeAmmCsv(csvPath, rows) {
  if (!csvPath) return;
  const head = 'Wallet,Type,Timestamp,LedgerHash,SubmittedAmount,LedgerDelta,Difference,Flags,Note';
  const lines = [head, ...rows.map((r) => [
      r.wallet, r.type, r.ts, r.hash || '',
      r.submitted == null ? '' : r.submitted,
      r.delta == null ? '' : r.delta.toFixed(6),
      r.diff == null ? '' : r.diff.toFixed(6),
      r.flags == null ? '' : r.flags,
    (r.note || '').trim(),
  ].map(csvCell).join(','))];
  fs.writeFileSync(csvPath, lines.join('\n'));
}

// ── CLI ───────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { db: defaultDbPath(), wallet: null, limit: null, csv: null, inspect: false, probe: null, endpoint: null, chain: null, amm: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') out.db = argv[++i];
    else if (a === '--wallet') out.wallet = argv[++i];
    else if (a === '--limit') out.limit = parseInt(argv[++i], 10);
    else if (a === '--out') out.csv = argv[++i];
    else if (a === '--inspect') out.inspect = true;
    else if (a === '--probe') out.probe = argv[++i];
    else if (a === '--endpoint') out.endpoint = argv[++i];
    else if (a === '--chain') out.chain = argv[++i];
    else if (a === '--amm') out.amm = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error('Unknown argument: ' + a); printHelp(); process.exit(1); }
  }
  return out;
}

// ── --inspect ─────────────────────────────────────────────────────────────
//
// Offline. Reports the SHAPE of the ids in the cache and nothing else.
//
// This exists because the first useful run reported "all 140 rows carry a
// synthetic id", which has two very different explanations: WinDB really is
// not returning TransactionHash, or the app is storing it in a form this
// script does not recognise as a hash. Those lead to opposite actions — a
// full re-sync versus a one-line decode fix — so guessing is expensive.
//
// A ledger hash is 32 bytes = 64 hex characters. makeTxHash() maps each
// CHARACTER of WinDB's value through charCodeAt and re-hexes it, which is
// correct if WinDB hands back a 32-byte binary string, and doubles the length
// to 128 if WinDB hands back the hash as text that is already hex.
function inspectIds(dbPath, walletFilter) {
  const { db, wallets, rowsFor } = loadCache(dbPath);
  const targets = walletFilter ? wallets.filter((w) => w.wallet === walletFilter) : wallets;

  const byLength = new Map();
  const samples = new Map();
  let total = 0;

  for (const { wallet } of targets) {
    for (const r of rowsFor.all(wallet)) {
      const h = r.tx_hash || '';
      total++;
      byLength.set(h.length, (byLength.get(h.length) || 0) + 1);
      if (!samples.has(h.length)) samples.set(h.length, h);
    }
  }
  db.close();

  console.log(`\nCache id shapes across ${targets.length} XRPL wallet(s), ${total.toLocaleString()} row(s):\n`);
  console.log('  length     count  interpretation                              sample');
  for (const len of [...byLength.keys()].sort((a, b) => a - b)) {
    const n = byLength.get(len);
    const s = samples.get(len);
    let what;
    if (len === 64 && REAL_HASH.test(s)) what = 'ledger hash (correct)';
    else if (len === 128 && /^[0-9A-F]{128}$/.test(s)) what = 'DOUBLE-ENCODED hash — decodes to a real one';
    else if (/_r/.test(s) || /^\d{4}/.test(s)) what = 'synthetic <timestamp>_<wallet> id';
    else what = 'unrecognised';
    console.log(`  ${String(len).padStart(6)}  ${String(n).padStart(8)}  ${what.padEnd(42)}  ${s.slice(0, 24)}${s.length > 24 ? '…' : ''}`);
  }

  const double = byLength.get(128) || 0;
  if (double) {
    console.log(`\n  ${double.toLocaleString()} row(s) are double-encoded. WinDB returns the hash as TEXT that is`);
    console.log('  already hexadecimal, and makeTxHash() hex-encodes it a second time.');
    console.log('  The data is intact — the ids just need decoding, not re-fetching.');
    const s = samples.get(128);
    console.log(`\n  stored:  ${s.slice(0, 32)}…`);
    console.log(`  decodes: ${decodeDoubled(s).slice(0, 16)}…`);
  }
  console.log('');
}

// "3033..." (the ASCII codes of "03…") back to "03…".
function decodeDoubled(s) {
  let out = '';
  for (let i = 0; i + 1 < s.length; i += 2) out += String.fromCharCode(parseInt(s.slice(i, i + 2), 16));
  return out.toUpperCase();
}

function printHelp() {
  console.log(`
verify-xrpl.js — reconcile the XRPL side of the local cache against a
full-history XRPL node (${RPC_URL}).

  --db <path>      cache location (default: the app's own)
  --wallet <addr>  verify one address only
  --limit <n>      verify the n busiest addresses only
  --out <file.csv> also write findings to CSV
  --inspect        offline: show the shape of the ids in the cache
  --chain <XRPL|Xahau>
                   which chain to reconcile. Xahau defaults the endpoint to
                   https://xahau.network/ — UNPROVEN for full history.
  --endpoint <url> override the JSON-RPC endpoint
  --amm            compare every cached AMMDeposit/AMMWithdraw's submitted
                   Amount against what the ledger actually moved, and report
                   the difference. Answers whether those figures can be booked.

PAYING TO GO FASTER (optional)

  The free cluster paces this run at 1.2s per request. XRPL Labs' paid path is
  Dhali — the same provider as WinDB. Export the claim, never pass it as an
  argument (argv is visible in shell history and to the process list):

      export DHALI_PAYMENT_CLAIM='<your claim>'
      node scripts/verify-xrpl.js --endpoint https://run.api.dhali.io/<key>/

  The claim is read from the environment, sent as a header, and never printed
  or written anywhere.
  --probe "<YYYY-MM-DD HH:MM:SS>"
                   offline: dump what the cache holds in that minute for
                   --wallet, to check one reported finding by hand
  --help

Reads only. Never writes to the database.
`);
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

async function main() {
  const args = parseArgs(process.argv);

  if (args.chain) {
    const c = String(args.chain).toLowerCase();
    if (c === 'xahau') { CHAIN = 'Xahau'; UNIT = 'XAH'; RPC_URL = 'https://xahau.network/'; }
    else if (c === 'xrpl') { CHAIN = 'XRPL'; UNIT = 'XRP'; }
    else { console.error('--chain must be XRPL or Xahau'); process.exit(2); }
  }
  // An explicit --endpoint always wins over the per-chain default.
  if (args.endpoint) RPC_URL = args.endpoint;

  if (args.inspect) {
    console.log(`Cache: ${args.db}`);
    inspectIds(args.db, args.wallet);
    return;
  }

  if (args.probe) {
    console.log(`Cache: ${args.db}`);
    probeCache(args.db, args.wallet, args.probe);
    return;
  }

  if (args.amm) {
    await reconcileAmm(args.db, args.wallet, args.limit, args.csv);
    return;
  }

  const { db, wallets, rowsFor } = loadCache(args.db);

  let targets = wallets;
  if (args.wallet) targets = wallets.filter((w) => w.wallet === args.wallet);
  if (args.limit) targets = targets.slice(0, args.limit);

  if (targets.length === 0) {
    console.error(`No ${CHAIN} wallets found in the cache` + (args.wallet ? ' matching ' + args.wallet : '') + '.');
    process.exit(1);
  }

  const cachedTotal = targets.reduce((s, w) => s + w.n, 0);
  console.log(`Cache:    ${args.db}`);
  console.log(`Endpoint: ${RPC_URL}`);
  console.log(`Chain:    ${CHAIN}  (native unit ${UNIT})`);
  console.log(`Checking ${targets.length} ${CHAIN} address(es), ${cachedTotal.toLocaleString()} cached row(s).`);
  console.log('Public infrastructure — this is deliberately paced. Expect minutes, not seconds.\n');

  const report = {
    missing: [], extra: [], mismatch: [], notFound: [], errors: [], ranges: [], timestampMatched: [],
    compared: 0, synthetic: 0, doubled: 0, cachedFailed: 0, pages: 0,
  };

  let i = 0;
  for (const { wallet, n } of targets) {
    i++;
    process.stdout.write(`  [${i}/${targets.length}] ${wallet} (${n.toLocaleString()} cached) … `);
    try {
      await verifyWallet(wallet, rowsFor.all(wallet), report);
      process.stdout.write('ok\n');
    } catch (e) {
      report.errors.push({ wallet, error: e.message });
      process.stdout.write('FAILED: ' + e.message + '\n');
    }
    await sleep(PAUSE_MS);
  }
  db.close();

  // ── Report ──────────────────────────────────────────────────────────
  const bar = '─'.repeat(72);
  console.log('\n' + bar);
  console.log(`Compared ${report.compared.toLocaleString()} XRP payment(s) across ${report.pages} page(s) of ledger history.`);
  if (report.doubled) {
    console.log(`\n  ${report.doubled.toLocaleString()} cached row(s) stored their ledger hash double-encoded and were`);
    console.log('  decoded before matching. See makeTxHash() — the data is fine, the id is not.');
  }
  if (report.synthetic) {
    console.log(`\n! ${report.synthetic.toLocaleString()} cached row(s) carry a synthetic id rather than a ledger hash.`);
    console.log('  WinDB did not return TransactionHash for them, so makeTxHash() fell back');
    console.log('  to "<timestamp>_<wallet>".');
  }
  if (report.timestampMatched.length) {
    console.log(`\n! ${report.timestampMatched.length} wallet(s) had NO usable hashes and were matched by TIMESTAMP instead:`);
    for (const w of report.timestampMatched.slice(0, 10)) console.log('    ' + w);
    console.log('  Completeness below is still meaningful. Amount checking is NOT possible');
    console.log('  for these — that needs a per-transaction pairing only a hash can give.');
    console.log('  Two transactions in the same second are compared by count, not paired.');
  }
  if (report.notFound.length) {
    console.log(`\n! ${report.notFound.length} address(es) do not exist on the XRP Ledger (never funded):`);
    for (const w of report.notFound.slice(0, 10)) console.log('    ' + w);
  }

  // Dust is not a discrepancy worth a verdict. The app discards anything under
  // DUST_MIN_UNITS, so a missing one-drop payment cannot move a tax figure —
  // and ending a clean report with "6 discrepancies, do not file" is how a
  // tool teaches you to ignore its conclusion.
  const materialMissing = report.missing.filter((m) => !m.dust && !m.unknown).length;
  const unknownMissing = report.missing.filter((m) => m.unknown).length;
  const dustMissing = report.missing.length - materialMissing - unknownMissing;
  const problem = materialMissing + report.extra.length + report.mismatch.length;

  // ── Coverage, before any finding is believed ────────────────────────
  // A wallet whose cache starts long after the ledger does was never fully
  // synced, and every "missing" row before that point is a sync gap rather
  // than a data-source bug. Saying which is which is the difference between
  // "re-sync this wallet" and "investigate WinDB".
  if (report.ranges.length) {
    console.log('\nCoverage (cached vs ledger):');
    for (const r of report.ranges) {
      const partial = r.cachedFrom && r.ledgerFrom && r.cachedFrom.slice(0, 10) > r.ledgerFrom.slice(0, 10);
      console.log(`  ${r.wallet}`);
      const okPart = r.cachedSuccess != null
        ? `${String(r.cachedSuccess).padStart(7)} ok + ${r.cachedFailed} failed`
        : `${String(r.cachedRows).padStart(7)} rows`;
      console.log(`    cached ${okPart}  ${r.cachedFrom.slice(0, 10) || '—'} → ${r.cachedTo.slice(0, 10) || '—'}`);
      console.log(`    ledger ${String(r.ledgerRows).padStart(7)} ok (successful only)  ${r.ledgerFrom.slice(0, 10) || '—'} → ${r.ledgerTo.slice(0, 10) || '—'}` +
                  (partial ? '   ← cache starts LATER: this wallet was never synced from the beginning' : ''));
    }
  }

  if (report.missing.length) {
    const material = report.missing.filter((m) => !m.dust && !m.unknown).sort((a, b) => Math.abs(b.xrpDelta || 0) - Math.abs(a.xrpDelta || 0));
    const dust = report.missing.filter((m) => m.dust);
    const unknown = report.missing.filter((m) => m.unknown);
    const atStake = material.reduce((s, m) => s + Math.abs(m.xrpDelta || 0), 0);

    // Which TRANSACTION TYPES are missing. This is the finding that matters:
    // the app's WinDB fetch filters to
    //     TransactionType IN ('Payment','OfferCreate')
    // on both chains, so every other type that moves XRP is never requested,
    // never cached, and invisible to the ledger engine. A Force Full Re-sync
    // reruns the SAME filtered query and recovers none of it.
    const FETCHED_TYPES = new Set(['Payment', 'OfferCreate']);
    const byType = new Map();
    for (const m of report.missing) {
      const t = m.type || '?';
      const e = byType.get(t) || { n: 0, xrp: 0, dust: 0 };
      e.n++;
      if (m.dust) e.dust++;
      e.xrp += Math.abs(m.xrpDelta || 0);
      byType.set(t, e);
    }
    if (byType.size) {
      console.log('\nMissing transactions by type:');
      console.log('  type                 count   (dust)          XRP moved   fetched by the app?');
      for (const [t, e] of [...byType.entries()].sort((a, b) => b[1].xrp - a[1].xrp)) {
        const fetched = FETCHED_TYPES.has(t);
        console.log(`  ${t.padEnd(20)} ${String(e.n).padStart(5)}   ${String(e.dust).padStart(5)}   ${e.xrp.toFixed(6).padStart(16)}   ` +
                    (fetched ? 'yes — investigate' : 'NO — never requested'));
      }
      const unfetched = [...byType.keys()].filter((t) => !FETCHED_TYPES.has(t));
      if (unfetched.length) {
        console.log(`\n  The app's WinDB query asks only for Payment and OfferCreate. These types`);
        console.log(`  are therefore never fetched on EITHER chain: ${unfetched.join(', ')}`);
        console.log('  A Force Full Re-sync would not recover them — the query has to change first.');
      }
    }

    if (material.length) {
      console.log(`\n✗ ${material.length} MATERIAL transaction(s) are on the ledger but NOT in your cache`);
      console.log(`  — ${atStake.toFixed(6)} XRP in total, largest first. The app cannot see these,`);
      console.log('  so any disposal among them is missing from Form 8949.');
      for (const m of material.slice(0, 30)) {
        const dir = (m.xrpDelta || 0) < 0 ? 'out' : 'in ';
        console.log(`    ${m.date}  ${dir}  ${(m.xrpDelta == null ? '?' : m.xrpDelta.toFixed(6)).padStart(16)} XRP  ${m.wallet}  ${m.hash}`);
      }
      if (material.length > 30) console.log(`    … and ${material.length - 30} more`);
    } else {
      console.log('\n✓ No material transactions are missing from the cache.');
    }

    if (unknown.length) {
      console.log(`\n? ${unknown.length} missing transaction(s) have an UNKNOWN amount — the account is not`);
      console.log('  a modified AccountRoot in their metadata, so no balance delta exists to read.');
      console.log('  These are neither confirmed material nor confirmed trivial. Listed in the CSV.');
      for (const m of unknown.slice(0, 10)) {
        console.log(`    ${m.date}  ${m.type.padEnd(24)} ${m.wallet}`);
      }
      if (unknown.length > 10) console.log(`    … and ${unknown.length - 10} more`);
    }

    if (dust.length) {
      console.log(`\n  (${dust.length} further missing transaction(s) are below the ${DUST_MIN_UNITS} XRP dust`);
      console.log('   threshold — one-drop spam. The app discards these anyway, so they');
      console.log('   cannot affect any tax figure. Listed in the CSV, not here.)');
    }
  }

  if (report.extra.length) {
    console.log(`\n✗ ${report.extra.length} cached transaction(s) are NOT on the ledger for that account.`);
    for (const m of report.extra.slice(0, 20)) console.log(`    ${m.wallet}  ${m.hash}`);
    if (report.extra.length > 20) console.log(`    … and ${report.extra.length - 20} more`);
  }

  if (report.mismatch.length) {
    console.log(`\n✗ ${report.mismatch.length} amount mismatch(es) — what the app booked differs from`);
    console.log('  the balance change the ledger actually applied:');
    for (const m of report.mismatch.slice(0, 20)) {
      console.log(`    ${m.date}  ${m.wallet}  ${m.direction}  booked ${m.booked.toFixed(6)}  ledger ${m.ledger.toFixed(6)}  diff ${m.diff.toFixed(6)}`);
    }
    if (report.mismatch.length > 20) console.log(`    … and ${report.mismatch.length - 20} more`);
  }

  if (report.errors.length) {
    console.log(`\n! ${report.errors.length} address(es) could not be checked:`);
    for (const e of report.errors.slice(0, 10)) console.log(`    ${e.wallet}: ${e.error}`);
  }

  if (args.csv) {
    const lines = ['finding,wallet,hash,date,direction,booked_xrp,ledger_xrp,diff_xrp,type'];
    // Material first, largest first — the CSV opens in the same order the
    // console reports, so sorting by column is not needed to find what matters.
    const orderedMissing = report.missing
      .slice()
      .sort((a, b) => (a.dust === b.dust ? Math.abs(b.xrpDelta || 0) - Math.abs(a.xrpDelta || 0) : (a.dust ? 1 : -1)));
    for (const m of orderedMissing) {
      lines.push([m.dust ? 'missing_from_cache_dust' : 'missing_from_cache',
        m.wallet, m.hash, m.date, (m.xrpDelta || 0) < 0 ? 'out' : 'in', '', m.xrpDelta ?? '', '', m.type].map(csvCell).join(','));
    }
    for (const m of report.extra) lines.push(['not_on_ledger', m.wallet, m.hash, '', '', '', '', '', ''].map(csvCell).join(','));
    for (const m of report.mismatch) lines.push(['amount_mismatch', m.wallet, m.hash, m.date, m.direction, m.booked, m.ledger, m.diff, 'Payment'].map(csvCell).join(','));
    fs.writeFileSync(args.csv, lines.join('\n') + '\n');
    console.log(`\nCSV written: ${args.csv}  (${lines.length - 1} finding(s))`);
  }

  console.log('\n' + bar);
  if (problem === 0 && report.errors.length === 0) {
    console.log('✓ The XRPL side of your cache matches the ledger.');
    if (dustMissing) {
      console.log(`  (${dustMissing} sub-${DUST_MIN_UNITS} XRP spam payment(s) are absent from the cache and`);
      console.log('   are listed in the CSV. The app discards these, so nothing is affected.)');
    }
    if (unknownMissing) {
      console.log(`  (${unknownMissing} further one(s) have no computable amount — see above.)`);
    }
    if (report.timestampMatched.length) {
      console.log('  Matched by timestamp, not hash — completeness is verified, amounts are not.');
    }
    console.log('  Xahau is NOT covered by this check.');
    process.exit(0);
  }
  console.log(`${problem} material discrepancy(ies) found. Do not file until these are explained.`);
  process.exit(1);
}

// Exported for the unit tests — the network path cannot be tested offline,
// but the balance-delta arithmetic is the part that can silently be wrong.
module.exports = { rpc, ammMode, AMM_FLAGS, xrpDeltaFor, feeXrp, rippleTimeToIso, toSecond, cachedAmountXrp, REAL_HASH, DOUBLED_HASH, ledgerHashOf, decodeDoubled, retryHintMs, RATE_LIMIT_ERRORS, DUST_MIN_UNITS, reconcileAmm, parseArgs, PAID };

if (require.main === module) {
  main().catch((e) => { console.error('\nverify-xrpl failed: ' + (e && e.stack ? e.stack : e)); process.exit(1); });
}
