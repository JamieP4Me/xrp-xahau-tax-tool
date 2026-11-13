// renderer/onchain.js — the on-chain balance check, and "Explain this difference".
//
// WHAT IT ANSWERS
//
// The tax engine keeps its own books: every coin it has seen arrive in a
// wallet, minus every coin it has booked leaving. The ledger keeps the real
// balance. If the two disagree, something moved coins that the engine never
// booked (a resting DEX offer filled by someone else, a fee, an AMM deposit,
// a lease payment the download could not see), or the engine booked a
// movement differently from what the ledger did. Either way the cost basis
// and the disposals built on those books are suspect, and nothing inside the
// app could notice: every other check compares the cache with itself.
//
// So, after each build, this compares the two for every fetched wallet and
// asset AT THE SAME MOMENT: the ledger that closed shortly before the last
// download began (the comparison point, or "pin"). Bookings the engine made
// for transactions after that point are taken back out of its figure using
// the booking journal (see bookingJournal in index.html), so a host that
// earned a reward during the download does not show up as a difference.
//
// For a wallet that does differ, "Explain" walks that wallet's complete
// ledger history up to the pin, reads what the ledger itself recorded each
// transaction did to the balance (metadata: before/after), and sets it beside
// what the engine booked for the same transaction. Every transaction that
// disagrees is listed with its hash and a cause, and the causes add up to the
// difference — or the report says by how much they do not.
//
// Source (1.10.10): WinDB through Dhali by default, with the same
// Payment-Claim as the download. WinDB keeps each account's balance as
// daily snapshots (account_balance_history, token_balance_history) and the
// current state (accounts, token_balances), so the check reads the balance at
// the END OF A UTC DAY — the day before the last download began — and
// Explain compares the app's books with the ledger day by day, inside the
// window WinDB's history covers (measured: XRPL from 2024-11-16, Xahau from
// 2026-04-28). Every query takes the newest row by ledger index, because
// these tables hold unmerged duplicates (one account returned seven rows).
// The public ledger servers stay available as the other source, and for the
// transaction-exact walk.
//
// Network for the public-server source: window.chainRpc (main process,
// ledger-rpc.js), read-only. WinDB: the renderer's own windbQuery(), the
// same call the download makes.
// Loaded before the main script; top-level code here must not touch the main
// script's bindings, only declare functions and its own state.

const ONCHAIN_RESULT_KEY = 'onchainCheckV1';
const ONCHAIN_PIN_KEY = 'onchainPinLedgerV1';
const ONCHAIN_FETCH_START_KEY = 'onchainFetchStartV1';
const ONCHAIN_SETTINGS_KEY = 'onchainSettingsV1';
// The comparison point sits this far before the download began, so WinDB had
// certainly indexed everything up to it when each wallet was read.
const ONCHAIN_PIN_MARGIN_MS = 10 * 60 * 1000;
// Without a recorded download start (caches from before 1.10.8), the earliest
// last-sync time of the last run, less this.
const ONCHAIN_SYNC_MARGIN_MS = 30 * 60 * 1000;
const ONCHAIN_RECENT_RUN_MS = 12 * 3600 * 1000;
const ONCHAIN_MATCH_QTY = 0.0001;
const ONCHAIN_MINOR_USD = 5;
const ONCHAIN_EPS = 1e-6;
const ONCHAIN_RIPPLE_EPOCH = 946684800;
const ONCHAIN_NETWORK_ID = { XRPL: 0, Xahau: 21337 };
const ONCHAIN_ASSETS = { XRPL: ['XRP'], Xahau: ['XAH', 'EVR'] };
const ONCHAIN_NATIVE = { XRPL: 'XRP', Xahau: 'XAH' };
const ONCHAIN_DB = { XRPL: 'xrpl', Xahau: 'xahau' };
const ONCHAIN_BATCH = 25;
// Daily differences smaller than this are listed as a total rather than one
// by one: network fees (which the app does not book) move native balances by
// fractions of a coin almost every active day.
const ONCHAIN_DAY_THRESHOLD = { XRP: 1, XAH: 1, EVR: 0.01 };
const DAY_MS = 86400000;

let _onchainResult = null;        // last completed check (also in app_meta)
let _onchainRunning = false;
let _onchainRerun = false;
let _onchainCancel = false;
let _onchainStatus = '';
let _onchainExplain = null;       // last explain report
let _explainRunning = false;
let _fetchStartedAt = null;       // set while a fetch runs
// The renderer's one call into the ledger. A variable, not a direct call, so
// the test suite can stand a fake ledger in its place.
let chainRpcCall = (req) => window.chainRpc.call(req);
// The renderer's one call into WinDB for the check. Same reason.
let windbCall = (sql) => windbQuery(sql, getClaim());

// ── Settings ───────────────────────────────────────────────────────────────
function onchainSettings() {
  const d = { auto: true, source: 'windb', xrplEndpoint: '', xahauEndpoint: '' };
  try { return Object.assign(d, JSON.parse(localStorage.getItem(ONCHAIN_SETTINGS_KEY) || '{}')); }
  catch (e) { return d; }
}
function saveOnchainSettings(next) {
  try { localStorage.setItem(ONCHAIN_SETTINGS_KEY, JSON.stringify(Object.assign(onchainSettings(), next))); } catch (e) {}
}
function onchainEndpoint(chain) {
  const s = onchainSettings();
  return String((chain === 'XRPL' ? s.xrplEndpoint : s.xahauEndpoint) || '').trim();
}
function onchainUsesDhali(chain) { return /^https:\/\/run\.api\.dhali\.io\//i.test(onchainEndpoint(chain)); }
function onchainSource() { return onchainSettings().source === 'rpc' ? 'rpc' : 'windb'; }
function onchainServerName(chain) {
  if (onchainSource() === 'windb') return 'WinDB (Dhali)';
  const ep = onchainEndpoint(chain);
  if (!ep) return chain === 'XRPL' ? 'xrplcluster.com' : 'xahau.network';
  try { return new URL(ep).hostname; } catch (e) { return ep; }
}
function onchainAutoEnabled() {
  return typeof USE_LOCAL_DB !== 'undefined' && USE_LOCAL_DB && (onchainSource() === 'windb' || !!window.chainRpc) &&
    !(window.appInfo && window.appInfo.onchainCheck === false) && onchainSettings().auto;
}

const onchainSleep = (ms) => new Promise((r) => setTimeout(r, ms));
function onchainPause(chain) { return onchainUsesDhali(chain) ? 80 : 300; }

async function onchainRpc(chain, method, params) {
  const req = { chain, method, params, endpoint: onchainEndpoint(chain) };
  // The claim goes along only when the server is Dhali; ledger-rpc.js checks
  // that again in the main process.
  if (onchainUsesDhali(chain) && typeof getClaim === 'function') { const c = getClaim(); if (c) req.claim = c; }
  const r = await chainRpcCall(req);
  return r || { error: 'noResponse' };
}

// ── Ledger arithmetic (pure) ───────────────────────────────────────────────
function onchainDecodeCurrency(raw) {
  const c = String(raw || '').trim();
  if (!/^[0-9A-Fa-f]{40}$/.test(c)) return c.toUpperCase();
  let out = '';
  for (let i = 0; i < 40; i += 2) {
    const b = parseInt(c.slice(i, i + 2), 16);
    if (b === 0) continue;
    if (b < 0x20 || b > 0x7e) return c.toUpperCase();
    out += String.fromCharCode(b);
  }
  return out.trim().toUpperCase() || c.toUpperCase();
}
// AMM LP tokens use a 40-hex currency code that starts 03.
function onchainIsLpCurrency(raw) { return /^03[0-9A-Fa-f]{38}$/.test(String(raw || '')); }

// The native balance change the ledger applied to `account` in one
// transaction, from AccountRoot before/after in the metadata. Includes the
// fee when the account paid it. null when the account's root was untouched.
function onchainNativeDelta(meta, account) {
  if (!meta || !Array.isArray(meta.AffectedNodes)) return null;
  let drops = 0, seen = false;
  for (const w of meta.AffectedNodes) {
    const node = w.ModifiedNode || w.CreatedNode || w.DeletedNode;
    if (!node || node.LedgerEntryType !== 'AccountRoot') continue;
    const fin = node.FinalFields || node.NewFields || {};
    const prev = node.PreviousFields || {};
    if (fin.Account !== account) continue;
    seen = true;
    if (w.CreatedNode) drops += Number(fin.Balance || 0);
    else if (w.DeletedNode) drops -= (prev.Balance != null ? Number(prev.Balance) : Number(fin.Balance || 0));
    else if (prev.Balance != null) drops += Number(fin.Balance || 0) - Number(prev.Balance);
  }
  return seen ? drops / 1e6 : null;
}

// Issued-currency changes for `account`, from RippleState before/after. The
// stored balance is from the LOW account's side; flip it for the high side.
function onchainIouDeltas(meta, account) {
  const out = [];
  if (!meta || !Array.isArray(meta.AffectedNodes)) return out;
  for (const w of meta.AffectedNodes) {
    const node = w.ModifiedNode || w.CreatedNode || w.DeletedNode;
    if (!node || node.LedgerEntryType !== 'RippleState') continue;
    const fin = node.FinalFields || node.NewFields || {};
    const prev = node.PreviousFields || {};
    const high = fin.HighLimit && fin.HighLimit.issuer, low = fin.LowLimit && fin.LowLimit.issuer;
    if (account !== high && account !== low) continue;
    const bal = fin.Balance || {};
    let after = Number(bal.value || 0), before;
    if (w.CreatedNode) before = 0;
    else if (w.DeletedNode) { before = prev.Balance ? Number(prev.Balance.value) : after; after = 0; }
    else { if (!prev.Balance) continue; before = Number(prev.Balance.value); }
    let d = after - before;
    if (account === high) d = -d;
    if (!Number.isFinite(d) || d === 0) continue;
    out.push({ currency: onchainDecodeCurrency(bal.currency), issuer: account === high ? low : high, delta: d });
  }
  return out;
}

// XLS-37 CTID: C, 7 hex of ledger sequence, 4 of transaction index, 4 of
// network id. How WinDB identifies a transaction it holds no hash for.
function onchainCtid(ledgerIndex, txIndex, networkId) {
  if (!Number.isFinite(ledgerIndex) || !Number.isFinite(txIndex)) return null;
  if (ledgerIndex > 0x0FFFFFFF || txIndex > 0xFFFF) return null;
  return ('C' + ledgerIndex.toString(16).padStart(7, '0') + txIndex.toString(16).padStart(4, '0') +
          (networkId || 0).toString(16).padStart(4, '0')).toUpperCase();
}

function onchainCloseMs(ledger) {
  if (!ledger) return null;
  if (Number.isFinite(Number(ledger.close_time))) return (Number(ledger.close_time) + ONCHAIN_RIPPLE_EPOCH) * 1000;
  if (ledger.close_time_iso) { const t = Date.parse(ledger.close_time_iso); return Number.isFinite(t) ? t : null; }
  return null;
}

function onchainStatusOf(variance, usd) {
  if (Math.abs(variance) < ONCHAIN_MATCH_QTY) return 'match';
  if (Math.abs(usd) < ONCHAIN_MINOR_USD) return 'minor';
  return 'material';
}

// ── The comparison point ───────────────────────────────────────────────────
// The comparison point is the END of a UTC day: the day before the download
// began. WinDB's balance history is daily, and every booking after that
// moment is taken back out of the app's side by day (dailyJournal).
function onchainEndOfPreviousDay(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 1;
}
async function onchainPinTimes() {
  let start = null, sync = [];
  try { const v = await window.taxDB.getMeta(ONCHAIN_FETCH_START_KEY); if (v) start = Date.parse(v); } catch (e) {}
  try { sync = await window.taxDB.getSyncTimes(); } catch (e) {}
  const out = {};
  for (const chain of ['XRPL', 'Xahau']) {
    const times = (sync || [])
      .filter((r) => r.chain === chain && r.last_synced_at && isFetchableOwnWallet(r.wallet))
      .map((r) => Date.parse(r.last_synced_at)).filter(Number.isFinite);
    const latest = times.length ? Math.max(...times) : null;
    if (Number.isFinite(start) && start > 0 && (latest == null || start <= latest)) {
      out[chain] = { ms: onchainEndOfPreviousDay(start - ONCHAIN_PIN_MARGIN_MS), source: 'the day before the last download' };
    } else if (latest != null) {
      const recent = times.filter((t) => t >= latest - ONCHAIN_RECENT_RUN_MS);
      out[chain] = { ms: onchainEndOfPreviousDay(Math.min(...recent) - ONCHAIN_SYNC_MARGIN_MS), source: 'the day before the last sync (approximate)' };
    } else {
      out[chain] = null;
    }
  }
  return out;
}

// Called by the main script at the start of every build, after the reset.
async function prepareBookingJournal() {
  let pins = null;
  try { if (window.taxDB) pins = await onchainPinTimes(); } catch (e) {}
  for (const chain of ['XRPL', 'Xahau']) {
    let ms = pins && pins[chain] ? pins[chain].ms : Infinity;
    if (_fetchStartedAt) ms = Math.min(ms, onchainEndOfPreviousDay(_fetchStartedAt - ONCHAIN_PIN_MARGIN_MS));
    journalCutoffMs[chain] = Number.isFinite(ms) ? ms - 60000 : Infinity;
  }
  journalConfigChanged();
  journalBuildInfo = { cutoff: { XRPL: journalCutoffMs.XRPL, Xahau: journalCutoffMs.Xahau },
                       wallets: [...journalWallets], all: journalAll, at: Date.now() };
}
function noteFetchStarted() { _fetchStartedAt = Date.now(); }
async function noteFetchFinished(ok) {
  const started = _fetchStartedAt;
  _fetchStartedAt = null;
  if (ok && started && window.taxDB) {
    try { await window.taxDB.setMeta(ONCHAIN_FETCH_START_KEY, new Date(started).toISOString()); } catch (e) {}
  }
}

async function onchainLedgerClose(chain, index) {
  const r = await onchainRpc(chain, 'ledger', { ledger_index: index, transactions: false, expand: false });
  if (r.ledgerNotFound) return null;
  if (r.error) throw new Error(`ledger ${index}: ${r.error}`);
  return onchainCloseMs(r.ledger);
}

// The last ledger that closed at or before pinMs. Interpolates from the
// current validated ledger, then halves the bracket: ~15 requests.
async function onchainResolvePin(chain, pinMs) {
  const cacheKey = `${chain}|${pinMs}|${onchainServerName(chain)}`;
  let cache = {};
  try { cache = JSON.parse((await window.taxDB.getMeta(ONCHAIN_PIN_KEY)) || '{}') || {}; } catch (e) { cache = {}; }
  if (cache[cacheKey]) return cache[cacheKey];
  const v = await onchainRpc(chain, 'ledger', { ledger_index: 'validated', transactions: false, expand: false });
  if (v.error) throw new Error(`could not read the current ${chain} ledger: ${v.error}`);
  const vIdx = Number(v.ledger_index != null ? v.ledger_index : (v.ledger && v.ledger.ledger_index));
  const vMs = onchainCloseMs(v.ledger);
  if (!Number.isFinite(vIdx) || !Number.isFinite(vMs)) throw new Error(`the ${chain} server did not report a ledger time`);
  let pin;
  if (pinMs >= vMs) {
    pin = { index: vIdx, closeMs: vMs };
  } else {
    let hi = vIdx, lo = null, loMs = null;
    let guess = Math.max(1, Math.round(vIdx - (vMs - pinMs) / 3900));
    for (let i = 0; i < 30 && lo == null; i++) {
      const g = await onchainLedgerClose(chain, guess);
      if (g == null) throw new Error(`the ${chain} server does not hold ledger ${guess}; use a full-history server`);
      if (g <= pinMs) { lo = guess; loMs = g; }
      else { hi = guess; guess = Math.max(1, guess - Math.max(20, Math.round((g - pinMs) / 3900) + 20)); }
      await onchainSleep(onchainPause(chain));
    }
    if (lo == null) throw new Error(`could not find the ${chain} ledger for ${new Date(pinMs).toISOString()}`);
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const m = await onchainLedgerClose(chain, mid);
      if (m == null) throw new Error(`the ${chain} server does not hold ledger ${mid}`);
      if (m <= pinMs) { lo = mid; loMs = m; } else hi = mid;
      await onchainSleep(onchainPause(chain));
    }
    pin = { index: lo, closeMs: loMs };
  }
  cache[cacheKey] = pin;
  const keys = Object.keys(cache);
  if (keys.length > 20) for (const k of keys.slice(0, keys.length - 20)) delete cache[k];
  try { await window.taxDB.setMeta(ONCHAIN_PIN_KEY, JSON.stringify(cache)); } catch (e) {}
  return pin;
}

// ── One account, as the ledger held it ─────────────────────────────────────
async function onchainPaged(chain, method, params, key, maxPages = 50) {
  const all = [];
  let marker, pages = 0, complete = true;
  do {
    const p = Object.assign({}, params, marker ? { marker } : {});
    const r = await onchainRpc(chain, method, p);
    if (r.error) throw new Error(`${method}: ${r.error}${r.error_message ? ' (' + r.error_message + ')' : ''}`);
    for (const x of (r[key] || [])) all.push(x);
    marker = r.marker;
    if (++pages >= maxPages && marker) { complete = false; break; }
    if (marker) await onchainSleep(onchainPause(chain));
  } while (marker);
  return { items: all, complete };
}

async function onchainReadAccount(chain, wallet, ledgerIndex) {
  const li = ledgerIndex == null ? 'validated' : ledgerIndex;
  const out = { exists: true, native: 0, nativeEscrow: 0, nativeChannel: 0, lines: {}, issuers: {},
                iouEscrow: {}, amm: [], ownerCount: 0, ledger: li, notes: [] };
  const info = await onchainRpc(chain, 'account_info', { account: wallet, ledger_index: li });
  if (info.notFound) { out.exists = false; return out; }
  if (info.ledgerNotFound) { out.ledgerMissing = true; return out; }
  if (info.error) throw new Error(`account_info: ${info.error}`);
  const ad = info.account_data || {};
  out.native = Number(ad.Balance || 0) / 1e6;
  out.ownerCount = Number(ad.OwnerCount || 0);
  if (out.ownerCount <= 0) return out;

  await onchainSleep(onchainPause(chain));
  const lines = await onchainPaged(chain, 'account_lines', { account: wallet, ledger_index: li, limit: 400 }, 'lines');
  const lp = [];
  for (const l of lines.items) {
    const bal = Number(l.balance);
    if (!Number.isFinite(bal) || bal <= 0) continue;   // negative = this account issued it
    if (onchainIsLpCurrency(l.currency)) { lp.push({ issuer: l.account, balance: bal }); continue; }
    const cur = onchainDecodeCurrency(l.currency);
    out.lines[cur] = (out.lines[cur] || 0) + bal;
    (out.issuers[cur] = out.issuers[cur] || {})[l.account] = bal;
  }
  if (!lines.complete) out.notes.push('trust lines: more pages than read');

  for (const [type, field] of [['escrow', 'escrow'], ['payment_channel', 'channel']]) {
    await onchainSleep(onchainPause(chain));
    let objs;
    try { objs = await onchainPaged(chain, 'account_objects', { account: wallet, ledger_index: li, type, limit: 200 }, 'account_objects', 20); }
    catch (e) { out.notes.push(`${type}: not read (${e.message})`); continue; }
    if (!objs.complete) out.notes.push(`${type}: more pages than read`);
    for (const o of objs.items) {
      if (o.Account !== wallet) continue;          // only what this account locked up
      if (field === 'escrow') {
        if (typeof o.Amount === 'string') out.nativeEscrow += Number(o.Amount) / 1e6;
        else if (o.Amount && o.Amount.currency) {
          const cur = onchainDecodeCurrency(o.Amount.currency);
          out.iouEscrow[cur] = (out.iouEscrow[cur] || 0) + Number(o.Amount.value || 0);
        }
      } else if (typeof o.Amount === 'string') {
        out.nativeChannel += (Number(o.Amount) - Number(o.Balance || 0)) / 1e6;
      }
    }
  }

  for (const pos of lp) {
    await onchainSleep(onchainPause(chain));
    const r = await onchainRpc(chain, 'amm_info', { amm_account: pos.issuer, ledger_index: li });
    if (r.error || !r.amm) { out.notes.push(`AMM ${pos.issuer.slice(0, 8)}…: not read`); continue; }
    const a = r.amm, total = Number(a.lp_token && a.lp_token.value);
    if (!(total > 0)) continue;
    const share = pos.balance / total;
    const side = (amt) => typeof amt === 'string'
      ? { asset: ONCHAIN_NATIVE[chain], qty: Number(amt) / 1e6 }
      : { asset: onchainDecodeCurrency(amt && amt.currency), qty: Number(amt && amt.value) };
    const s1 = side(a.amount), s2 = side(a.amount2);
    out.amm.push({ pool: pos.issuer, share, legs: [{ asset: s1.asset, qty: s1.qty * share }, { asset: s2.asset, qty: s2.qty * share }] });
  }
  return out;
}

// ── WinDB as the source ────────────────────────────────────────────────────
// Addresses go into SQL text, so each one is checked against the address
// alphabet first; anything else is refused rather than quoted.
function onchainSqlAddr(a) {
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(String(a))) throw new Error('not an XRPL/Xahau address: ' + String(a).slice(0, 12));
  return "'" + a + "'";
}
function onchainSqlTime(ms) { return "'" + new Date(ms).toISOString().slice(0, 19).replace('T', ' ') + "'"; }
function onchainWinDbTimeMs(s) { const t = Date.parse(String(s || '').replace(' ', 'T') + 'Z'); return Number.isFinite(t) ? t : null; }

// The last ledger that closed at or before ms, from WinDB's ledger table.
// Read newest-first, so it stops almost at once for a recent time.
async function onchainLedgerAtWinDB(chain, ms) {
  const r = await windbCall(`SELECT LedgerIndex, Timestamp FROM ${ONCHAIN_DB[chain]}.ledgers WHERE Timestamp <= ${onchainSqlTime(ms)} ORDER BY LedgerIndex DESC LIMIT 1`);
  if (!r || !r[0]) throw new Error(`WinDB has no ${chain} ledger at or before ${new Date(ms).toISOString()}`);
  return { index: Number(r[0].LedgerIndex), closeMs: onchainWinDbTimeMs(r[0].Timestamp) };
}

// One balance at ledger L from WinDB's two views of it (pure). `hist` is the
// newest daily snapshot at or before L (li = 0 when there is none), `cur`
// the current state. Returns {bal, how} or {unknown: reason}.
function onchainResolveAt(hist, cur, L, scale) {
  const sc = (v) => Number(v || 0) / scale;
  const hli = hist ? Number(hist.li || 0) : 0, cli = cur ? Number(cur.li || 0) : 0;
  if (cur && cli > 0 && cli <= L) return { bal: sc(cur.bal), how: 'current state (no activity since the comparison day)' };
  if (hist && hli > 0) return { bal: sc(hist.bal), how: 'daily history' };
  if (!cur && !hist) return { bal: 0, how: 'none', missing: true };
  return { unknown: "WinDB's daily history does not reach back to the comparison day for this account" };
}

async function onchainBatches(wallets, fn) {
  const out = [];
  for (let i = 0; i < wallets.length; i += ONCHAIN_BATCH) {
    const batch = wallets.slice(i, i + ONCHAIN_BATCH);
    try { out.push(...(await fn(batch))); }
    catch (e) {
      if (batch.length === 1) throw e;
      // A batch WinDB refused: one wallet at a time (the transactions table
      // refused multi-wallet IN () lists once; these tables accepted them).
      for (const w of batch) out.push(...(await fn([w])));
    }
    if (_onchainCancel) break;
  }
  return out;
}

// Every wallet's balances on one chain at ledger L. About four small
// queries per 25 wallets.
async function onchainReadWinDB(chain, wallets, L, onStep = () => {}) {
  const db = ONCHAIN_DB[chain];
  const byW = (rows, key = 'Account') => { const m = new Map(); for (const r of rows || []) m.set(r[key], r); return m; };
  onStep(`Reading ${chain} balances from WinDB…`);
  const hist = byW(await onchainBatches(wallets, (b) => windbCall(
    `SELECT Account, argMaxIf(Balance, LastActiveLedgerIndex, LastActiveLedgerIndex <= ${L}) AS bal, maxIf(LastActiveLedgerIndex, LastActiveLedgerIndex <= ${L}) AS li, toString(min(Date)) AS first ` +
    `FROM ${db}.account_balance_history WHERE Account IN (${b.map(onchainSqlAddr).join(',')}) GROUP BY Account`)));
  const cur = byW(await onchainBatches(wallets, (b) => windbCall(
    `SELECT Account, argMax(Balance, LastActiveLedgerIndex) AS bal, max(LastActiveLedgerIndex) AS li, argMax(isActive, LastActiveLedgerIndex) AS active ` +
    `FROM ${db}.accounts WHERE Account IN (${b.map(onchainSqlAddr).join(',')}) GROUP BY Account`)));
  // EVR is counted the way the engine counts it: every trust line whose
  // currency is EVR, whatever the issuer, each resolved on its own and summed.
  const byWI = (rows) => { const m = new Map(); for (const r of rows || []) { const k = r.Holder; if (!m.has(k)) m.set(k, new Map()); m.get(k).set(r.Issuer, r); } return m; };
  let evrHist = new Map(), evrCur = new Map();
  if (chain === 'Xahau') {
    onStep('Reading EVR balances from WinDB…');
    const tokenWhere = (b) => `Holder IN (${b.map(onchainSqlAddr).join(',')}) AND Currency = 'EVR'`;
    evrHist = byWI(await onchainBatches(wallets, (b) => windbCall(
      `SELECT Holder, Issuer, argMaxIf(Balance, LastActiveLedgerIndex, LastActiveLedgerIndex <= ${L}) AS bal, maxIf(LastActiveLedgerIndex, LastActiveLedgerIndex <= ${L}) AS li ` +
      `FROM xahau.token_balance_history WHERE ${tokenWhere(b)} GROUP BY Holder, Issuer`)));
    evrCur = byWI(await onchainBatches(wallets, (b) => windbCall(
      `SELECT Holder, Issuer, argMax(Balance, LastActiveLedgerIndex) AS bal, max(LastActiveLedgerIndex) AS li ` +
      `FROM xahau.token_balances WHERE ${tokenWhere(b)} GROUP BY Holder, Issuer`)));
  }
  const out = new Map();
  for (const w of wallets) {
    const acct = { exists: true, native: 0, nativeEscrow: 0, nativeChannel: 0, lines: {}, issuers: {}, iouEscrow: {}, amm: [],
                   ownerCount: 0, ledger: L, notes: [], unknown: {}, source: 'windb' };
    const n = onchainResolveAt(hist.get(w), cur.get(w), L, 1e6);
    if (n.unknown) acct.unknown[ONCHAIN_NATIVE[chain]] = n.unknown;
    else { acct.native = n.bal; if (n.missing) acct.exists = false; }
    const c = cur.get(w);
    if (c && Number(c.active) === 0) acct.notes.push('WinDB marks this account inactive (deleted?)');
    if (chain === 'Xahau') {
      const hi = evrHist.get(w) || new Map(), ci = evrCur.get(w) || new Map();
      const issuers = new Set([...hi.keys(), ...ci.keys()]);
      let sum = 0, unknown = null, held = 0;
      for (const iss of issuers) {
        const e = onchainResolveAt(hi.get(iss), ci.get(iss), L, 1);
        if (e.unknown) unknown = e.unknown;
        else { sum += e.bal; if (e.bal > 0) held++; }
      }
      if (unknown) acct.unknown.EVR = unknown;
      else acct.lines.EVR = sum;
      if (held > 1) acct.notes.push(`EVR held from ${held} issuers (counted together, as the app counts them)`);
    }
    out.set(w, acct);
  }
  return out;
}

// ── App side, captured under the ledger lock ───────────────────────────────
function onchainCaptureApp(pins) {
  const pinMs = { XRPL: pins.XRPL ? pins.XRPL.ms : null, Xahau: pins.Xahau ? pins.Xahau.ms : null };
  const qty = {};
  for (const [w, tickers] of Object.entries(walletLedger)) {
    for (const [tk, lots] of Object.entries(tickers)) {
      let q = 0;
      for (const l of lots) if (l.remaining > 0) q += l.remaining;
      qty[w + '|' + tk] = { held: q, post: 0, postN: 0 };
    }
  }
  // Bookings after the comparison day come back out, summed by UTC day.
  for (const [jk, m] of dailyJournal) {
    const tk = jk.slice(jk.lastIndexOf('|') + 1);
    const p = pinMs[tk === 'XRP' ? 'XRPL' : 'Xahau'];
    if (p == null) continue;
    const lastDay = Math.floor(p / DAY_MS);
    for (const [day, e] of m) {
      if (!(day > lastDay)) continue;
      const r = qty[jk] || (qty[jk] = { held: 0, post: 0, postN: 0 });
      r.post += e.add - e.used; r.postN++;
    }
  }
  const haveDaily = dailyJournal.size > 0 || Object.keys(walletLedger).length === 0;
  const journalOk = { XRPL: haveDaily && pinMs.XRPL != null, Xahau: haveDaily && pinMs.Xahau != null };
  return { qty, journalOk };
}

function onchainHoldingsHash(qty) {
  const s = Object.keys(qty).sort().map((k) => k + '=' + qty[k].held.toFixed(6)).join(';');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

async function onchainStamp(pins, app) {
  let ds = '';
  try { ds = await dataStamp(); } catch (e) {}
  return JSON.stringify({ ds, t: typeof ammTreatment !== 'undefined' ? ammTreatment : '',
    pins: { XRPL: pins.XRPL && pins.XRPL.ms, Xahau: pins.Xahau && pins.Xahau.ms },
    ep: [onchainSource(), onchainServerName('XRPL'), onchainServerName('Xahau')], h: onchainHoldingsHash(app.qty) });
}

async function loadOnchainResult() {
  if (_onchainResult) return _onchainResult;
  try { const v = await window.taxDB.getMeta(ONCHAIN_RESULT_KEY); if (v) _onchainResult = JSON.parse(v); } catch (e) {}
  return _onchainResult;
}

// After every build. Re-uses the stored result when nothing it depends on has
// changed, so launching the app does not query the ledger every time.
async function scheduleOnchainCheck(reason) {
  if (!onchainAutoEnabled()) return;
  if (_onchainRunning) { _onchainRerun = true; return; }
  if (typeof buildIsConsistent === 'function' && !buildIsConsistent()) return;
  try { await runOnchainCheck({ reason, reuse: true }); } catch (e) { /* reported in the panel */ }
}

async function runOnchainCheck(opts = {}) {
  if (_onchainRunning) { _onchainRerun = true; return _onchainResult; }
  _onchainRunning = true; _onchainCancel = false; _onchainRerun = false;
  _onchainStatus = 'Preparing…';
  renderOnchainPanel();
  try {
    // 1. Everything the app side needs, in one turn of the ledger lock: the
    // background treatment comparison swaps the books out while it runs.
    const snap = await withLedgerLock('on-chain check', async () => {
      const pins = await onchainPinTimes();
      const app = onchainCaptureApp(pins);
      const stamp = await onchainStamp(pins, app);
      let sync = [];
      try { sync = await window.taxDB.getSyncTimes(); } catch (e) {}
      return { pins, app, stamp, sync };
    });
    if (opts.reuse) {
      const stored = await loadOnchainResult();
      if (stored && stored.stamp === snap.stamp && !stored.cancelled) {
        _onchainStatus = '';
        return stored;
      }
    }

    // 2. Which wallets, on which chain.
    const pairs = [];
    const lastSync = {};
    for (const r of snap.sync) {
      if (!isFetchableOwnWallet(r.wallet) || !ONCHAIN_ASSETS[r.chain]) continue;
      pairs.push({ wallet: r.wallet, chain: r.chain });
      lastSync[r.wallet + '|' + r.chain] = r.last_synced_at || null;
    }
    const checked = new Set(pairs.map((p) => p.wallet + '|' + p.chain));
    const notChecked = [];
    for (const [k, v] of Object.entries(snap.app.qty)) {
      const [w, tk] = [k.slice(0, k.lastIndexOf('|')), k.slice(k.lastIndexOf('|') + 1)];
      const chain = tk === 'XRP' ? 'XRPL' : 'Xahau';
      if (v.held > ONCHAIN_MATCH_QTY && !checked.has(w + '|' + chain)) notChecked.push({ wallet: w, ticker: tk, qty: v.held });
    }

    const source = onchainSource();
    if (source === 'windb' && !(typeof getClaim === 'function' && getClaim())) {
      throw new Error('enter your Payment-Claim on the Setup tab — the check reads WinDB through Dhali, like the download');
    }
    const pins = {};
    const readings = new Map();
    const errors = [];
    if (source === 'windb') {
      for (const chain of ['XRPL', 'Xahau']) {
        const ws = pairs.filter((x) => x.chain === chain).map((x) => x.wallet);
        if (!ws.length) continue;
        const p = snap.pins[chain];
        if (!p) { errors.push({ wallet: '(all)', chain, message: 'no sync record to choose a comparison day from' }); continue; }
        try {
          _onchainStatus = `Finding the ${chain} ledger that closed the comparison day…`; renderOnchainPanel();
          const lg = await onchainLedgerAtWinDB(chain, p.ms);
          pins[chain] = { ms: p.ms, source: p.source, index: lg.index, closeMs: lg.closeMs, fallback: false, via: 'windb' };
          const got = await onchainReadWinDB(chain, ws, lg.index, (m) => { _onchainStatus = m; renderOnchainPanel(); });
          for (const [w, acct] of got) readings.set(w + '|' + chain, acct);
        } catch (e) {
          errors.push({ wallet: '(all)', chain, message: e.message });
        }
      }
    } else {
    // 3. The ledger that is the comparison point, per chain.
    for (const chain of ['XRPL', 'Xahau']) {
      const p = snap.pins[chain];
      if (!pairs.some((x) => x.chain === chain)) continue;
      if (!p) { pins[chain] = { ms: null, index: null, fallback: true, source: 'no sync record' }; continue; }
      _onchainStatus = `Finding the ${chain} ledger for ${new Date(p.ms).toLocaleString()}…`;
      renderOnchainPanel();
      try {
        const r = await onchainResolvePin(chain, p.ms);
        pins[chain] = { ms: p.ms, source: p.source, index: r.index, closeMs: r.closeMs, fallback: false };
      } catch (e) {
        pins[chain] = { ms: p.ms, source: p.source, index: null, fallback: true, error: e.message };
      }
    }

    // 4. Read every account at its chain's comparison point.
    let done = 0;
    const queue = pairs.slice();
    const workers = Math.min(queue.length, onchainUsesDhali('XRPL') || onchainUsesDhali('Xahau') ? 4 : 2);
    const work = async () => {
      while (queue.length && !_onchainCancel) {
        const p = queue.shift();
        const pin = pins[p.chain] || {};
        try {
          let acct = await onchainReadAccount(p.chain, p.wallet, pin.index);
          if (acct.ledgerMissing) {
            acct = await onchainReadAccount(p.chain, p.wallet, null);
            acct.notes.push('read at the current ledger: the server does not hold the comparison ledger');
            acct.atCurrent = true;
          }
          if (pin.index == null) acct.atCurrent = true;
          readings.set(p.wallet + '|' + p.chain, acct);
        } catch (e) {
          errors.push({ wallet: p.wallet, chain: p.chain, message: e.message });
        }
        done++;
        _onchainStatus = `Reading balances: ${done} of ${pairs.length}…`;
        if (done % 5 === 0 || done === pairs.length) renderOnchainPanel();
        await onchainSleep(onchainPause(p.chain));
      }
    };
    await Promise.all(Array.from({ length: Math.max(workers, 1) }, work));
    }

    // 5. Compare.
    const rows = [];
    for (const p of pairs) {
      const acct = readings.get(p.wallet + '|' + p.chain);
      if (!acct) continue;
      for (const tk of ONCHAIN_ASSETS[p.chain]) {
        const a = snap.app.qty[p.wallet + '|' + tk] || { held: 0, post: 0, postN: 0 };
        const native = tk === ONCHAIN_NATIVE[p.chain];
        const bal = native ? acct.native : (acct.lines[tk] || 0);
        const escrow = native ? acct.nativeEscrow + acct.nativeChannel : (acct.iouEscrow[tk] || 0);
        const amm = acct.amm.reduce((s, x) => s + x.legs.filter((l) => l.asset === tk).reduce((t, l) => t + l.qty, 0), 0);
        const usePost = !acct.atCurrent && snap.app.journalOk[p.chain];
        const appAtPin = a.held - (usePost ? a.post : 0);
        if (acct.unknown && acct.unknown[tk]) {
          if (Math.abs(appAtPin) < ONCHAIN_MATCH_QTY) continue;
          rows.push({ wallet: p.wallet, chain: p.chain, ticker: tk, type: walletTypeOf(p.wallet), label: labelFor(p.wallet),
            lastSync: lastSync[p.wallet + '|' + p.chain], appHeld: a.held, appPost: usePost ? a.post : 0, app: appAtPin,
            balance: NaN, escrow: 0, amm: 0, ledger: NaN, variance: 0, price: latestPriceFor(tk).price || 0, usd: 0,
            status: 'unknown', atCurrent: false, notes: [acct.unknown[tk] + ' — use the public ledger servers for this one'] });
          continue;
        }
        if (Math.abs(appAtPin) < ONCHAIN_MATCH_QTY && Math.abs(bal + escrow) < ONCHAIN_MATCH_QTY && Math.abs(amm) < ONCHAIN_MATCH_QTY) continue;
        const ledger = bal + escrow;
        const variance = appAtPin - ledger;
        const price = latestPriceFor(tk).price || 0;
        const notes = acct.notes.slice();
        if (!acct.exists) notes.push('account not on the ledger at the comparison point (never funded, or deleted)');
        if (!native && acct.issuers[tk] && Object.keys(acct.issuers[tk]).length > 1) notes.push(`${tk} held from ${Object.keys(acct.issuers[tk]).length} issuers`);
        if (escrow > 0) notes.push(`${fmtOnchainQty(escrow)} ${tk} in escrow/channels counted as held`);
        if (amm > 0) notes.push(`AMM pool share worth ${fmtOnchainQty(amm)} ${tk} (not counted above)`);
        if (!usePost && a.postN) notes.push('bookings after the comparison point could not be separated');
        rows.push({
          wallet: p.wallet, chain: p.chain, ticker: tk, type: walletTypeOf(p.wallet), label: labelFor(p.wallet),
          lastSync: lastSync[p.wallet + '|' + p.chain], appHeld: a.held, appPost: usePost ? a.post : 0,
          app: appAtPin, balance: bal, escrow, amm, ledger, variance, price, usd: variance * price,
          status: onchainStatusOf(variance, variance * price), atCurrent: !!acct.atCurrent, notes,
        });
      }
    }
    rows.sort((x, y) => Math.abs(y.usd) - Math.abs(x.usd));
    const result = {
      version: 1, at: Date.now(), stamp: snap.stamp, cancelled: _onchainCancel, pins, rows, notChecked, errors,
      journalOk: snap.app.journalOk, source, servers: { XRPL: onchainServerName('XRPL'), Xahau: onchainServerName('Xahau') },
      pairs: pairs.length, read: readings.size,
    };
    _onchainResult = result;
    try { await window.taxDB.setMeta(ONCHAIN_RESULT_KEY, JSON.stringify(result)); } catch (e) {}
    _onchainStatus = '';
    const mat = rows.filter((r) => r.status === 'material');
    if (typeof log === 'function') {
      log(mat.length
        ? `On-chain check: ${mat.length} wallet/asset balance(s) differ from the ledger by more than $${ONCHAIN_MINOR_USD} — see Holdings.`
        : `✓ On-chain check: every checked balance agrees with the ledger within $${ONCHAIN_MINOR_USD}.`, mat.length ? 'wa' : 'ok');
    }
    return result;
  } catch (e) {
    _onchainStatus = 'The check stopped: ' + e.message;
    throw e;
  } finally {
    _onchainRunning = false;
    renderOnchainPanel();
    try { if (typeof renderDataSummary === 'function') renderDataSummary(); } catch (e) {}
    if (_onchainRerun) { _onchainRerun = false; setTimeout(() => scheduleOnchainCheck('rerun'), 0); }
  }
}

function cancelOnchain() { _onchainCancel = true; _explainCancel = true; }

// ── Explain one wallet ─────────────────────────────────────────────────────
let _explainCancel = false;

const EXPLAIN_CATEGORIES = {
  not_downloaded_affected: 'Moved by someone else\'s transaction, never downloaded (e.g. a resting DEX offer filled, an AMM or lease payment)',
  not_downloaded: 'This wallet\'s own transaction, never downloaded',
  fee: 'Network fees (the app does not book fees)',
  dust: 'Below the app\'s dust floor',
  type_not_booked: 'Downloaded, but a type the app does not book',
  dex_terms: 'DEX offer booked at its full terms when placed; the ledger moved a different amount in that transaction',
  amount_differs: 'Booked, but at a different amount than the ledger moved',
  shortfall: 'The app took coins it had no record of this wallet receiving',
  booked_not_on_ledger: 'Booked by the app, with no matching transaction on the ledger',
};

// Classify one transaction's effect on one asset. Pure. Returns the parts:
// a fee portion (native, sender) and a remainder with its category.
function explainClassify({ ledger, fee, app, short, inCache, type, ticker }) {
  const diff = app - ledger;
  if (Math.abs(diff) <= ONCHAIN_EPS) return { match: true, fee: 0, diff: 0, category: null };
  const feePart = fee > 0 ? fee : 0;
  const rest = diff - feePart;
  if (Math.abs(rest) <= ONCHAIN_EPS) return { match: false, fee: feePart, diff: 0, category: null };
  const moved = ledger + feePart;               // what moved, excluding the fee
  let category;
  if (Math.abs(app) <= ONCHAIN_EPS && !(short > 0)) {
    if (typeof dustOk === 'function' && !dustOk(ticker, Math.abs(moved))) category = 'dust';
    else if (inCache) category = 'type_not_booked';
    else category = null;                       // caller decides own vs affected
  } else if (short > 0 && Math.abs(rest - short) <= Math.max(ONCHAIN_EPS, short * 1e-9)) {
    category = 'shortfall';
  } else if (type === 'OfferCreate') {
    category = 'dex_terms';
  } else {
    category = 'amount_differs';
  }
  return { match: false, fee: feePart, diff: rest, category };
}

async function explainOnchainRow(i) {
  const r = _onchainResult && _onchainResult.rows[i];
  if (!r) return;
  return explainOnchain(r.wallet, r.chain);
}

// "Explain": day by day from WinDB when that is the source, otherwise the
// transaction-exact walk on a public ledger server.
async function explainOnchain(wallet, chain) {
  const r = await loadOnchainResult();
  if (r && r.source === 'windb') return explainDaily(wallet, chain);
  return explainExact(wallet, chain);
}

const dayStr = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);

// The day-by-day comparison (pure). ledgerDays: [{day, bal}] — WinDB's
// end-of-day balance on each active day up to the comparison day. appDaily:
// Map(day -> app's net booking that day). appAtD / dayD: the app's holding at
// the end of the comparison day, and that day's number.
function explainDailyCompute({ ledgerDays, appDaily, appAtD, dayD, threshold }) {
  const out = { firstDay: null, startDiff: null, events: [], small: { n: 0, sum: 0 }, finalDiff: null, ledgerAtD: null, appAtD };
  const days = ledgerDays.filter((x) => x.day <= dayD).sort((a, b) => a.day - b.day);
  if (!days.length) return out;
  const F = days[0].day;
  out.firstDay = F;
  // App holding at the end of day F: walk back from the comparison day.
  let appAtF = appAtD;
  for (const [day, net] of appDaily) if (day > F && day <= dayD) appAtF -= net;
  out.startDiff = appAtF - days[0].bal;
  // Every later day on which either side moved.
  const ledgerOn = new Map(days.map((x) => [x.day, x.bal]));
  const active = new Set([...ledgerOn.keys(), ...[...appDaily.keys()].filter((d) => d > F && d <= dayD)]);
  const order = [...active].filter((d) => d > F).sort((a, b) => a - b);
  let lastBal = days[0].bal, running = out.startDiff;
  for (const d of order) {
    const bal = ledgerOn.has(d) ? ledgerOn.get(d) : lastBal;
    const ledgerChange = bal - lastBal;
    const app = appDaily.get(d) || 0;
    const delta = app - ledgerChange;
    lastBal = bal;
    if (Math.abs(delta) <= ONCHAIN_EPS) continue;
    running += delta;
    if (Math.abs(delta) < threshold) { out.small.n++; out.small.sum += delta; continue; }
    out.events.push({ day: d, ledger: ledgerChange, app, delta, running });
  }
  out.ledgerAtD = lastBal;
  out.finalDiff = appAtD - lastBal;
  return out;
}

// Daily rows -> one end-of-day total per day. Several issuers' lines (EVR)
// each carry their last balance forward until they next change.
function explainDailyTotals(rows, scale) {
  const byDay = new Map();
  for (const r of rows) {
    const day = Math.floor(Date.parse(r.d + 'T00:00:00Z') / DAY_MS);
    if (!byDay.has(day)) byDay.set(day, new Map());
    byDay.get(day).set(r.Issuer || '', Number(r.bal) / scale);
  }
  const last = new Map(), out = [];
  for (const day of [...byDay.keys()].sort((a, b) => a - b)) {
    for (const [iss, bal] of byDay.get(day)) last.set(iss, bal);
    out.push({ day, bal: [...last.values()].reduce((s, v) => s + v, 0) });
  }
  return out;
}

async function explainDaily(wallet, chain) {
  if (_explainRunning) return;
  const result = await loadOnchainResult();
  const pin = result && result.pins && result.pins[chain];
  if (!pin || pin.index == null) { alert('Run the on-chain check first.'); return; }
  _explainRunning = true; _explainCancel = false;
  const setStatus = (m) => { _onchainStatus = m; renderOnchainPanel(); };
  try {
    const L = pin.index, dayD = Math.floor(pin.ms / DAY_MS), db = ONCHAIN_DB[chain];
    const app = await withLedgerLock('explain', async () => {
      const o = {};
      for (const tk of ONCHAIN_ASSETS[chain]) {
        const lots = (walletLedger[wallet] || {})[tk] || [];
        const held = lots.reduce((s, l) => s + (l.remaining > 0 ? l.remaining : 0), 0);
        const net = new Map();
        for (const [day, e] of (dailyJournal.get(wallet + '|' + tk) || new Map())) net.set(day, e.add - e.used);
        let later = 0;
        for (const [day, v] of net) if (day > dayD) later += v;
        o[tk] = { appAtD: held - later, net };
      }
      return o;
    });
    const assets = {};
    for (const tk of ONCHAIN_ASSETS[chain]) {
      setStatus(`Reading ${tk} daily balances for this wallet from WinDB…`);
      const native = tk === ONCHAIN_NATIVE[chain];
      const sql = native
        ? `SELECT toString(Date) AS d, argMax(Balance, LastActiveLedgerIndex) AS bal FROM ${db}.account_balance_history ` +
          `WHERE Account = ${onchainSqlAddr(wallet)} AND LastActiveLedgerIndex <= ${L} GROUP BY Date ORDER BY Date`
        : `SELECT toString(Date) AS d, Issuer, argMax(Balance, LastActiveLedgerIndex) AS bal FROM xahau.token_balance_history ` +
          `WHERE Holder = ${onchainSqlAddr(wallet)} AND Currency = 'EVR' AND LastActiveLedgerIndex <= ${L} GROUP BY Date, Issuer ORDER BY Date`;
      const rows = await windbCall(sql);
      const ledgerDays = explainDailyTotals(rows || [], native ? 1e6 : 1);
      const c = explainDailyCompute({ ledgerDays, appDaily: app[tk].net, appAtD: app[tk].appAtD, dayD, threshold: ONCHAIN_DAY_THRESHOLD[tk] || 1 });
      c.events.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      assets[tk] = c;
    }
    // What was downloaded on the days that matter most, from the local cache.
    setStatus('Listing the downloaded transactions on those days…');
    const wanted = new Set();
    for (const c of Object.values(assets)) for (const e of c.events.slice(0, 25)) wanted.add(e.day);
    const txByDay = {};
    for (const d of wanted) {
      let rows = [];
      try { rows = await window.taxDB.getRowsBetween(wallet, chain, dayStr(d) + ' 00:00:00', dayStr(d + 1) + ' 00:00:00', 80); } catch (e) {}
      txByDay[d] = rows.map((r) => explainTxSummary(r, wallet));
    }
    _onchainExplain = { kind: 'daily', wallet, chain, pin, at: Date.now(), assets, txByDay, balanceAtPin: {} };
    for (const x of (result.rows || []).filter((y) => y.wallet === wallet && y.chain === chain)) {
      _onchainExplain.balanceAtPin[x.ticker] = { balance: x.balance, escrow: x.escrow, variance: x.variance };
    }
    setStatus('');
  } catch (e) {
    setStatus('Explain stopped: ' + e.message);
  } finally {
    _explainRunning = false;
    renderOnchainPanel();
  }
}

// One cached row in a line: time, type, direction, amount.
function explainTxSummary(r, wallet) {
  let raw = {};
  try { raw = JSON.parse(r.raw_json); } catch (e) {}
  const pick = (...v) => { for (const x of v) { const s = String(x == null ? '' : x).trim(); if (s && s !== '0') return s; } return ''; };
  const native = pick(raw.delivered_amount_XRP, raw.Amount_XRP);
  const val = pick(raw.delivered_amount_value, raw.Amount_value);
  const cur = onchainDecodeCurrency(pick(raw.delivered_amount_currency, raw.Amount_currency));
  let amount = native ? `${native} native` : val ? `${val} ${cur}` : '';
  if (raw.TransactionType === 'OfferCreate') {
    const g = pick(raw.TakerGets_XRP) ? `${raw.TakerGets_XRP} native` : `${pick(raw.TakerGets_value)} ${onchainDecodeCurrency(raw.TakerGets_currency)}`;
    const p = pick(raw.TakerPays_XRP) ? `${raw.TakerPays_XRP} native` : `${pick(raw.TakerPays_value)} ${onchainDecodeCurrency(raw.TakerPays_currency)}`;
    amount = `offers ${g} for ${p}`;
  }
  const dir = raw.Account === wallet ? (raw.Destination ? 'out to ' + String(raw.Destination).slice(0, 10) + '…' : 'signed') :
              raw.Destination === wallet ? 'in from ' + String(raw.Account || '').slice(0, 10) + '…' : 'other';
  return { ts: String(r.timestamp || '').slice(0, 19), type: raw.TransactionType || '?', dir, amount: amount.trim(),
           result: raw.TransactionResult || '', affected: String(r.tx_hash || '').startsWith('AFFECTED:') };
}

async function explainExact(wallet, chain) {
  if (_explainRunning) return;
  const result = await loadOnchainResult();
  if (!result) { alert('Run the on-chain check first.'); return; }
  const pin = result.pins && result.pins[chain];
  _explainRunning = true; _explainCancel = false;
  const setStatus = (m) => { _onchainStatus = m; renderOnchainPanel(); };
  try {
    // 1. A full booking record for this wallet. One rebuild from the cache,
    // the same build the app runs at launch, with the journal kept for it.
    const info = journalBuildInfo;
    if (!info || !(info.all || (info.wallets || []).includes(wallet))) {
      journalWallets.add(wallet);
      journalConfigChanged();
      setStatus('Rebuilding the report with a full booking record for this wallet (no Payment-Claim used)…');
      const ok = await buildReportFromCache({ silent: true });
      if (!ok) throw new Error('the rebuild did not complete');
    }
    // 2. What the cache holds for it, and what the engine booked.
    let cached = new Set();
    try { cached = new Set((await window.taxDB.getTxHashes(wallet, chain)).map(cacheTxKey)); } catch (e) {}
    const report = await withLedgerLock('explain', async () => {
      const j = {};
      for (const tk of ONCHAIN_ASSETS[chain]) {
        const m = bookingJournal.get(wallet + '|' + tk);
        j[tk] = m ? new Map(m) : new Map();
      }
      let held = {};
      for (const tk of ONCHAIN_ASSETS[chain]) {
        const lots = (walletLedger[wallet] || {})[tk] || [];
        held[tk] = lots.reduce((s, l) => s + (l.remaining > 0 ? l.remaining : 0), 0);
      }
      return { j, held };
    });
    // 3. Walk the ledger.
    const rep = await explainWalk({ wallet, chain, pin, journal: report.j, held: report.held, cached, setStatus });
    rep.balanceAtPin = {};
    const row = (result.rows || []).filter((x) => x.wallet === wallet && x.chain === chain);
    for (const x of row) rep.balanceAtPin[x.ticker] = { balance: x.balance, escrow: x.escrow };
    rep.kind = 'exact';
    _onchainExplain = rep;
    setStatus('');
  } catch (e) {
    setStatus('Explain stopped: ' + e.message);
  } finally {
    _explainRunning = false;
    renderOnchainPanel();
  }
}

// The ledger walk and the classification, separated from the UI so the test
// suite can drive it with a fake ledger.
async function explainWalk({ wallet, chain, pin, journal, held, cached, setStatus = () => {} }) {
  const assets = ONCHAIN_ASSETS[chain];
  const native = ONCHAIN_NATIVE[chain];
  const pinIndex = pin && pin.index != null ? pin.index : -1;
  const pinMs = pin && pin.index != null ? pin.ms : Infinity;
  const per = {};
  for (const tk of assets) per[tk] = { walk: 0, buckets: {}, matchN: 0, matchedKeys: new Set(), journalAtPin: 0, journalLater: 0 };
  const rows = [];
  const bucket = (tk, cat, ledger, app, diff) => {
    const b = per[tk].buckets[cat] || (per[tk].buckets[cat] = { n: 0, ledger: 0, app: 0, diff: 0 });
    b.n++; b.ledger += ledger; b.app += app; b.diff += diff;
  };
  let marker, pages = 0, txn = 0;
  const limit = onchainUsesDhali(chain) ? 400 : 200;
  do {
    if (_explainCancel) throw new Error('cancelled');
    const params = { account: wallet, ledger_index_min: -1, ledger_index_max: pinIndex, forward: true, limit };
    if (marker) params.marker = marker;
    const r = await onchainRpc(chain, 'account_tx', params);
    if (r.notFound) break;
    if (r.error) throw new Error(`account_tx: ${r.error}${r.error_message ? ' (' + r.error_message + ')' : ''}`);
    for (const e of (r.transactions || [])) {
      const tx = e.tx || e.tx_json || {};
      const meta = e.meta || e.metaData || {};
      const hash = String(e.hash || tx.hash || '').toUpperCase();
      const li = Number(e.ledger_index != null ? e.ledger_index : tx.ledger_index);
      const ctid = String(e.ctid || tx.ctid || onchainCtid(li, Number(meta.TransactionIndex), ONCHAIN_NETWORK_ID[chain]) || '').toUpperCase();
      const keys = [hash, ctid ? 'CTID:' + ctid : null].filter(Boolean);
      const role = tx.Account === wallet ? 'sent' : tx.Destination === wallet ? 'received' : 'affected';
      const type = tx.TransactionType || '?';
      const dateMs = tx.date != null ? (Number(tx.date) + ONCHAIN_RIPPLE_EPOCH) * 1000 : (e.close_time_iso ? Date.parse(e.close_time_iso) : null);
      const iou = onchainIouDeltas(meta, wallet);
      txn++;
      for (const tk of assets) {
        const isNative = tk === native;
        let d = isNative ? onchainNativeDelta(meta, wallet) : iou.filter((x) => x.currency === tk).reduce((s, x) => s + x.delta, 0);
        if (d == null) d = 0;
        const fee = isNative && role === 'sent' ? Number(tx.Fee || 0) / 1e6 : 0;
        const m = journal[tk];
        let je = null, jk = null;
        for (const k of keys) { if (m.has(k)) { je = m.get(k); jk = k; break; } }
        if (d === 0 && !je) continue;
        per[tk].walk += d;
        const app = je ? je.add - je.used : 0;
        const short = je ? je.short : 0;
        if (jk) per[tk].matchedKeys.add(jk);
        const inCache = keys.some((k) => cached.has(k));
        const c = explainClassify({ ledger: d, fee, app, short, inCache, type, ticker: tk });
        if (c.match) { per[tk].matchN++; continue; }
        if (c.fee) bucket(tk, 'fee', -c.fee, 0, c.fee);
        if (!c.category && Math.abs(c.diff) <= ONCHAIN_EPS) continue;
        const category = c.category || (role === 'affected' ? 'not_downloaded_affected' : 'not_downloaded');
        const ledgerExFee = d + (c.fee || 0);
        bucket(tk, category, ledgerExFee, app, c.diff);
        rows.push({ dateMs, ticker: tk, category, type, role, counterparty: role === 'sent' ? (tx.Destination || '') : (tx.Account || ''),
                    ledger: ledgerExFee, fee: c.fee || 0, app, short, diff: c.diff, inCache, hash, ctid,
                    result: meta.TransactionResult || '' });
      }
    }
    marker = r.marker;
    pages++;
    setStatus(`Walking the ${chain} ledger: ${txn.toLocaleString()} transactions read…`);
    if (marker) await onchainSleep(onchainPause(chain));
  } while (marker);

  // Bookings with no ledger transaction to match.
  for (const tk of assets) {
    for (const [k, e] of journal[tk]) {
      const eff = e.add - e.used;
      if (e.ms > pinMs) { per[tk].journalLater += eff; continue; }
      per[tk].journalAtPin += eff;
      if (per[tk].matchedKeys.has(k)) continue;
      if (Math.abs(eff) <= ONCHAIN_EPS) continue;
      bucket(tk, 'booked_not_on_ledger', 0, eff, eff);
      rows.push({ dateMs: e.ms, ticker: tk, category: 'booked_not_on_ledger', type: e.type, role: '', counterparty: '',
                  ledger: 0, fee: 0, app: eff, short: e.short, diff: eff, inCache: true,
                  hash: /^[0-9A-F]{64}$/.test(k) ? k : '', ctid: k.startsWith('CTID:') ? k.slice(5) : '', id: k, result: '' });
    }
  }

  const summary = {};
  for (const tk of assets) {
    const p = per[tk];
    const appAtPin = (held[tk] || 0) - p.journalLater;
    const explained = Object.values(p.buckets).reduce((s, b) => s + b.diff, 0);
    summary[tk] = {
      appAtPin, walk: p.walk, variance: appAtPin - p.walk, explained,
      residual: (appAtPin - p.walk) - explained,
      journalGap: appAtPin - p.journalAtPin,     // bookings the journal did not see (should be 0)
      buckets: p.buckets, matchN: p.matchN,
    };
  }
  rows.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  return { wallet, chain, pin, at: Date.now(), txn, pages, rows, summary, server: onchainServerName(chain) };
}

// ── Data-quality line on the 8949 / Setup summary ──────────────────────────
function onchainQualityHTML() {
  const r = _onchainResult;
  if (!r || !r.rows) return '';
  const mat = r.rows.filter((x) => x.status === 'material');
  if (!mat.length && !r.errors.length) return '';
  const usd = mat.reduce((s, x) => s + Math.abs(x.usd), 0);
  return `<div style="margin-top:8px;padding:10px 12px;background:#fff8e1;border:2px solid #b07a00;border-radius:4px;font-size:11px;color:#6a4a00">
    <strong>⚠ On-chain balance check: ${mat.length} wallet/asset balance(s) differ from the ledger</strong>
    by more than $${ONCHAIN_MINOR_USD} each (about $${fmt(usd)} in total at today's prices)${r.errors.length ? `, and ${r.errors.length} could not be read` : ''}.
    The app's books for those wallets do not match what the ledger holds, so the basis and disposals built on them need explaining
    before they are relied on. Holdings tab → On-chain balance check → Explain.
  </div>`;
}

// ── Panel on the Holdings tab ──────────────────────────────────────────────
function fmtOnchainQty(n) {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: Math.abs(n) < 1 ? 6 : 4 });
}
function onchainWalletCell(w, label) {
  const short = w.slice(0, 10) + '…' + w.slice(-4);
  return label ? `${escapeHTML(label)}<br><span style="color:#888">${escapeHTML(short)}</span>` : escapeHTML(short);
}

async function renderOnchainPanel() {
  // Mirror a running check or explain into the progress strip, so it is
  // visible from any tab, not only Holdings.
  if (typeof progressSet === 'function') {
    if ((_onchainRunning || _explainRunning) && _onchainStatus) progressSet('onchain', 'On-chain check: ' + _onchainStatus);
    else progressDone('onchain');
  }
  const box = document.getElementById('onchainPanel');
  if (!box) return;
  if (typeof USE_LOCAL_DB === 'undefined' || !USE_LOCAL_DB) { box.innerHTML = ''; return; }
  const r = _onchainResult || await loadOnchainResult();
  const s = onchainSettings();
  const busy = _onchainRunning || _explainRunning;
  const head = `<h3 style="font-size:13px;margin:0 0 4px">On-chain balance check</h3>
    <div style="font-size:11px;color:#555;line-height:1.6;margin-bottom:8px">
      Compares what the app holds for each fetched wallet with what the ledger held at the same moment: the end of the
      UTC day before the last download began. Bookings made after that are left out of the app's side. A difference means
      the app's books for that wallet are missing or misreading something — <b>Explain</b> shows the days it happened and
      what was downloaded on them.
      ${onchainSource() === 'windb'
        ? 'Source: <b>WinDB through Dhali</b>, with the Payment-Claim from Setup (a few small queries per 25 wallets).'
        : `Source: <b>public ledger servers</b> (${escapeHTML(onchainServerName('XRPL'))}, ${escapeHTML(onchainServerName('Xahau'))}); no Payment-Claim unless a Dhali server is set.`}
    </div>
    <div class="row" style="margin-bottom:8px;gap:6px;flex-wrap:wrap">
      <button class="sml" style="background:#1a3a7a;color:#fff;border-color:#1a3a7a" ${busy ? 'disabled' : ''} onclick="runOnchainCheck().catch(()=>{})">↻ Run check now</button>
      <button class="sml" ${r && r.rows ? '' : 'disabled'} onclick="exportOnchainCSV()">⬇ Check CSV</button>
      ${busy ? '<button class="sml" onclick="cancelOnchain()">Stop</button>' : ''}
      <label style="font-size:11px;margin-left:8px"><input type="checkbox" id="onchainAutoChk" ${s.auto ? 'checked' : ''}
        onchange="saveOnchainSettings({auto:this.checked})"> run automatically after each build</label>
    </div>
    <details style="font-size:11px;margin-bottom:8px"><summary>Source and servers</summary>
      <div style="padding:6px 0;line-height:1.8">
        <label><input type="radio" name="onchainSrc" ${onchainSource() === 'windb' ? 'checked' : ''} onchange="saveOnchainSettings({source:'windb'}); renderOnchainPanel();">
          WinDB through Dhali (default) — uses the Payment-Claim; balances as WinDB records them each day</label><br>
        <label><input type="radio" name="onchainSrc" ${onchainSource() === 'rpc' ? 'checked' : ''} onchange="saveOnchainSettings({source:'rpc'}); renderOnchainPanel();">
          Public full-history ledger servers — reads each balance at the exact ledger; Explain walks every transaction</label><br>
        XRPL <input id="onchainXrplEp" style="width:340px;font-size:11px" placeholder="https://xrplcluster.com/ (default)" value="${escapeHTML(s.xrplEndpoint)}"><br>
        Xahau <input id="onchainXahauEp" style="width:340px;font-size:11px" placeholder="https://xahau.network/ (default)" value="${escapeHTML(s.xahauEndpoint)}">
        <button class="sml" onclick="saveOnchainSettings({xrplEndpoint:document.getElementById('onchainXrplEp').value.trim(), xahauEndpoint:document.getElementById('onchainXahauEp').value.trim()}); renderOnchainPanel();">Save</button><br>
        <span style="color:#666">Allowed: xrplcluster.com, s2.ripple.com, xahau.network, or a Dhali API (https://run.api.dhali.io/&lt;api id&gt;/).
        For Dhali, the Payment-Claim from Setup is sent to Dhali only, never to the public servers.
        The comparison and the explain walk need a full-history server.</span>
      </div></details>`;
  const status = _onchainStatus ? `<div style="font-size:11px;color:#7a4a00;margin-bottom:8px">${escapeHTML(_onchainStatus)}</div>` : '';
  if (!r || !r.rows) {
    box.innerHTML = head + status + `<div class="empty" style="font-size:11px">Not run yet${onchainAutoEnabled() ? ' — it runs after the next build' : ''}.</div>` + explainHTML();
    return;
  }
  const by = (st) => r.rows.filter((x) => x.status === st);
  const mat = by('material'), minor = by('minor'), match = by('match');
  const pinLine = Object.entries(r.pins || {}).map(([c, p]) => p
    ? `${c}: ${p.index != null ? 'ledger ' + p.index.toLocaleString() + ', closed ' + new Date(p.closeMs).toLocaleString() : 'current ledger (' + escapeHTML(p.error || p.source || 'no comparison point') + ')'}${p.source ? ' · from ' + escapeHTML(p.source) : ''}`
    : '').filter(Boolean).join('<br>');
  const totals = {};
  for (const x of r.rows) {
    const t = totals[x.ticker] || (totals[x.ticker] = { qty: 0, usd: 0 });
    if (x.status !== 'match') { t.qty += x.variance; t.usd += x.usd; }
  }
  const color = (st) => st === 'material' ? '#8b0000' : st === 'minor' ? '#7a4a00' : st === 'unknown' ? '#666' : '#1a5c2a';
  const unknownN = by('unknown').length;
  const list = r.rows.map((x, i) => ({ x, i })).filter(({ x }) => x.status !== 'match');
  const table = list.length ? `<table style="border-collapse:collapse;font-size:10px;width:100%;margin-top:6px">
      <tr style="background:#eef"><th style="text-align:left;padding:3px 5px">Wallet</th><th style="text-align:left;padding:3px 5px">Type</th>
        <th style="text-align:left;padding:3px 5px">Asset</th><th style="text-align:right;padding:3px 5px">App holds</th>
        <th style="text-align:right;padding:3px 5px">Ledger holds</th><th style="text-align:right;padding:3px 5px">Difference (app − ledger)</th>
        <th style="text-align:right;padding:3px 5px">At today's price</th><th style="text-align:left;padding:3px 5px">Notes</th><th></th></tr>
      ${list.map(({ x, i }) => `<tr style="border-top:1px solid #ddd">
        <td style="padding:3px 5px">${onchainWalletCell(x.wallet, x.label)}</td>
        <td style="padding:3px 5px">${escapeHTML(x.type || '')}</td>
        <td style="padding:3px 5px">${escapeHTML(x.ticker)} <span style="color:#888">${escapeHTML(x.chain)}</span></td>
        <td style="padding:3px 5px;text-align:right">${fmtOnchainQty(x.app)}</td>
        <td style="padding:3px 5px;text-align:right">${fmtOnchainQty(x.ledger)}</td>
        <td style="padding:3px 5px;text-align:right;color:${color(x.status)};font-weight:700">${x.status === 'unknown' ? '—' : fmtOnchainQty(x.variance)}</td>
        <td style="padding:3px 5px;text-align:right;color:${color(x.status)}">${x.status === 'unknown' ? '—' : '$' + fmt(x.usd)}</td>
        <td style="padding:3px 5px;color:#555">${x.notes.map(escapeHTML).join('; ')}</td>
        <td style="padding:3px 5px"><button class="sml" ${busy ? 'disabled' : ''} onclick="explainOnchainRow(${i})">Explain</button></td>
      </tr>`).join('')}
    </table>` : '<div style="font-size:11px;color:#1a5c2a;margin-top:6px">✓ Every checked balance agrees with the ledger.</div>';
  const notChecked = (r.notChecked || []).length ? `<div style="font-size:10px;color:#555;margin-top:6px">Not checked (holdings in addresses the app does not fetch — exchanges and other addresses marked as yours):
      ${r.notChecked.map((n) => `${escapeHTML(n.wallet.slice(0, 10))}… ${fmtOnchainQty(n.qty)} ${escapeHTML(n.ticker)}`).join(' · ')}</div>` : '';
  const errs = (r.errors || []).length ? `<div style="font-size:10px;color:#8b0000;margin-top:6px">Could not read: ${r.errors.slice(0, 10).map((e) => `${escapeHTML(e.wallet.slice(0, 10))}… ${escapeHTML(e.chain)} (${escapeHTML(e.message)})`).join(' · ')}${r.errors.length > 10 ? ` …and ${r.errors.length - 10} more` : ''}</div>` : '';
  const journalNote = (r.journalOk && (!r.journalOk.XRPL || !r.journalOk.Xahau))
    ? `<div style="font-size:10px;color:#7a4a00;margin-top:4px">Bookings made after the comparison point could not be separated on ${['XRPL', 'Xahau'].filter((c) => r.journalOk[c] === false).join(' and ')}; active wallets may show small differences until the next build.</div>` : '';
  box.innerHTML = head + status + `
    <div style="font-size:11px;margin-bottom:4px">Last run ${new Date(r.at).toLocaleString()}${r.cancelled ? ' (stopped before finishing)' : ''} ·
      ${r.read} of ${r.pairs} wallet/chain pairs read ·
      <span style="color:#1a5c2a">${match.length} agree</span> ·
      <span style="color:#7a4a00">${minor.length} differ by under $${ONCHAIN_MINOR_USD}</span> ·
      <span style="color:#8b0000;font-weight:700">${mat.length} differ by more</span>${unknownN ? ` · <span style="color:#666">${unknownN} not determinable from WinDB</span>` : ''} ·
      source ${escapeHTML(r.source === 'rpc' ? 'public ledger servers' : 'WinDB (Dhali)')}</div>
    <div style="font-size:10px;color:#666;margin-bottom:4px">Comparison point — ${pinLine || 'none'}</div>
    <div style="font-size:10px;color:#666">Net difference: ${Object.entries(totals).map(([t, v]) => `${fmtOnchainQty(v.qty)} ${escapeHTML(t)} ($${fmt(v.usd)})`).join(' · ') || 'none'}</div>
    ${journalNote}${table}${notChecked}${errs}` + explainHTML();
}

function explainHTML() {
  const x = _onchainExplain;
  if (!x) return '<div id="onchainExplain"></div>';
  if (x.kind === 'daily') return explainDailyHTML(x);
  const label = labelFor(x.wallet);
  const sections = Object.entries(x.summary).map(([tk, s]) => {
    const bal = (x.balanceAtPin || {})[tk];
    const cats = Object.entries(s.buckets).sort((a, b) => Math.abs(b[1].diff) - Math.abs(a[1].diff));
    if (!cats.length && Math.abs(s.variance) <= ONCHAIN_EPS) {
      return `<div style="font-size:11px;margin:6px 0"><b>${escapeHTML(tk)}</b>: the app's books and the ledger agree transaction by transaction (${s.matchN.toLocaleString()} matched).</div>`;
    }
    const closes = Math.abs(s.residual) <= 1e-4;
    return `<div style="margin:8px 0">
      <div style="font-size:11px"><b>${escapeHTML(tk)}</b> — app holds ${fmtOnchainQty(s.appAtPin)}, the ledger walk ends at
        ${fmtOnchainQty(s.walk)}${bal ? ` (balance read at the comparison point: ${fmtOnchainQty(bal.balance)}${bal.escrow ? `, plus ${fmtOnchainQty(bal.escrow)} in escrow/channels` : ''})` : ''}.
        Difference <b>${fmtOnchainQty(s.variance)}</b>; ${s.matchN.toLocaleString()} transactions agree exactly.</div>
      <table style="border-collapse:collapse;font-size:10px;width:100%;margin-top:4px">
        <tr style="background:#f3f3f3"><th style="text-align:left;padding:3px 5px">Cause</th><th style="text-align:right;padding:3px 5px">Transactions</th>
          <th style="text-align:right;padding:3px 5px">Ledger moved</th><th style="text-align:right;padding:3px 5px">App booked</th>
          <th style="text-align:right;padding:3px 5px">Difference</th></tr>
        ${cats.map(([c, b]) => `<tr style="border-top:1px solid #eee"><td style="padding:3px 5px">${escapeHTML(EXPLAIN_CATEGORIES[c] || c)}</td>
          <td style="padding:3px 5px;text-align:right">${b.n.toLocaleString()}</td><td style="padding:3px 5px;text-align:right">${fmtOnchainQty(b.ledger)}</td>
          <td style="padding:3px 5px;text-align:right">${fmtOnchainQty(b.app)}</td><td style="padding:3px 5px;text-align:right;font-weight:700">${fmtOnchainQty(b.diff)}</td></tr>`).join('')}
        <tr style="border-top:2px solid #999"><td style="padding:3px 5px"><b>${closes ? 'Explained — the causes add up to the difference' : 'Not explained (residual)'}</b></td><td></td><td></td><td></td>
          <td style="padding:3px 5px;text-align:right;font-weight:700;color:${closes ? '#1a5c2a' : '#8b0000'}">${fmtOnchainQty(closes ? s.explained : s.residual)}</td></tr>
      </table>
      ${bal && Math.abs(s.walk - bal.balance) > 1e-4 ? `<div style="font-size:10px;color:#8b0000">The ledger walk ends at ${fmtOnchainQty(s.walk)} but the balance at the comparison point was ${fmtOnchainQty(bal.balance)}: the server's history for this account is incomplete, so part of the difference is outside what was read. Use a full-history server (Ledger servers, above).</div>` : ''}
      ${Math.abs(s.journalGap) > 1e-4 ? `<div style="font-size:10px;color:#8b0000">The booking record is short by ${fmtOnchainQty(s.journalGap)} ${escapeHTML(tk)} against the app's holdings; rebuild and explain again.</div>` : ''}
    </div>`;
  }).join('');
  const top = x.rows.slice(0, 25);
  const rowsTable = top.length ? `<div style="font-size:11px;margin-top:6px"><b>Largest differences</b> (all ${x.rows.length.toLocaleString()} in the CSV)</div>
    <table style="border-collapse:collapse;font-size:10px;width:100%;margin-top:4px">
      <tr style="background:#f3f3f3"><th style="text-align:left;padding:3px 5px">Date (UTC)</th><th style="text-align:left;padding:3px 5px">Asset</th>
        <th style="text-align:left;padding:3px 5px">Type / role</th><th style="text-align:right;padding:3px 5px">Ledger moved</th>
        <th style="text-align:right;padding:3px 5px">App booked</th><th style="text-align:right;padding:3px 5px">Difference</th>
        <th style="text-align:left;padding:3px 5px">Cause</th><th style="text-align:left;padding:3px 5px">Transaction</th></tr>
      ${top.map((t) => `<tr style="border-top:1px solid #eee"><td style="padding:3px 5px">${t.dateMs ? new Date(t.dateMs).toISOString().slice(0, 16).replace('T', ' ') : ''}</td>
        <td style="padding:3px 5px">${escapeHTML(t.ticker)}</td><td style="padding:3px 5px">${escapeHTML(t.type)}${t.role ? ' · ' + escapeHTML(t.role) : ''}</td>
        <td style="padding:3px 5px;text-align:right">${fmtOnchainQty(t.ledger)}</td><td style="padding:3px 5px;text-align:right">${fmtOnchainQty(t.app)}</td>
        <td style="padding:3px 5px;text-align:right;font-weight:700">${fmtOnchainQty(t.diff)}</td>
        <td style="padding:3px 5px">${escapeHTML(t.category.replace(/_/g, ' '))}</td>
        <td style="padding:3px 5px;font-family:monospace">${escapeHTML((t.hash || t.ctid || t.id || '').slice(0, 16))}…</td></tr>`).join('')}
    </table>` : '';
  return `<div id="onchainExplain" style="margin-top:12px;padding:10px;border:1px solid #ccd;border-radius:4px;background:#fafaff">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
      <div style="font-size:12px"><b>Explain:</b> ${label ? escapeHTML(label) + ' · ' : ''}<span style="font-family:monospace">${escapeHTML(x.wallet)}</span> on ${escapeHTML(x.chain)}</div>
      <div><button class="sml" onclick="exportExplainCSV()">⬇ Explain CSV</button> <button class="sml" onclick="_onchainExplain=null; renderOnchainPanel()">Close</button></div>
    </div>
    <div style="font-size:10px;color:#666;margin:4px 0">${x.txn.toLocaleString()} ledger transactions read from ${escapeHTML(x.server)} up to
      ${x.pin && x.pin.index != null ? 'ledger ' + x.pin.index.toLocaleString() : 'the current ledger'}, each compared with what the app booked for it.
      Differences are app minus ledger: positive means the app thinks the wallet holds more.</div>
    ${sections}${rowsTable}</div>`;
}

// ── CSV ────────────────────────────────────────────────────────────────────
function exportOnchainCSV() {
  const r = _onchainResult;
  if (!r || !r.rows) return;
  const lines = ['Wallet,Description,Type,Chain,Asset,App Holds (at comparison point),App Bookings After Comparison Point,Ledger Balance,Ledger Escrow/Channels,Ledger Total,Difference (app - ledger),Unit Price USD,Difference USD,Status,AMM Share (not counted),Last Synced,Notes'];
  for (const x of r.rows) {
    const f6 = (v) => Number.isFinite(v) ? v.toFixed(6) : '';
    lines.push([x.wallet, x.label || '', x.type || '', x.chain, x.ticker, f6(x.app), f6(x.appPost), f6(x.balance),
      f6(x.escrow), f6(x.ledger), x.status === 'unknown' ? '' : f6(x.variance), f6(x.price), x.status === 'unknown' ? '' : x.usd.toFixed(2), x.status,
      x.amm ? x.amm.toFixed(6) : '', x.lastSync || '', x.notes.join('; ')].map(csvField).join(','));
  }
  for (const n of r.notChecked || []) lines.push([n.wallet, labelFor(n.wallet), walletTypeOf(n.wallet), '', n.ticker, n.qty.toFixed(6), '', '', '', '', '', '', '', 'not checked', '', '', 'not fetched by the app'].map(csvField).join(','));
  for (const e of r.errors || []) lines.push([e.wallet, labelFor(e.wallet), walletTypeOf(e.wallet), e.chain, '', '', '', '', '', '', '', '', '', 'not read', '', '', e.message].map(csvField).join(','));
  downloadCSV(lines, `Onchain-Check-${new Date(r.at).toISOString().slice(0, 10)}.csv`);
}

function explainDailyHTML(x) {
  const label = labelFor(x.wallet);
  const sections = Object.entries(x.assets).map(([tk, c]) => {
    const chk = (x.balanceAtPin || {})[tk];
    if (c.firstDay == null) {
      return `<div style="font-size:11px;margin:6px 0"><b>${escapeHTML(tk)}</b>: WinDB has no daily balance for this wallet up to the comparison day
        (its history starts ${x.chain === 'XRPL' ? '2024-11-16' : '2026-04-28'} and this wallet had no ${escapeHTML(tk)} activity since, or none at all).
        The app holds ${fmtOnchainQty(c.appAtD)}. Use the exact walk below to trace it.</div>`;
    }
    const evTotal = c.events.reduce((s, e) => s + e.delta, 0);
    const closes = Math.abs(c.startDiff + c.small.sum + evTotal - c.finalDiff) <= 1e-4;
    const top = c.events.slice(0, 25);
    return `<div style="margin:8px 0">
      <div style="font-size:11px"><b>${escapeHTML(tk)}</b> — at the end of ${dayStr(Math.floor(x.pin.ms / DAY_MS))} the app holds ${fmtOnchainQty(c.appAtD)}
        and WinDB's daily balance is ${fmtOnchainQty(c.ledgerAtD)}: difference <b>${fmtOnchainQty(c.finalDiff)}</b>${chk && Number.isFinite(chk.variance) ? ` (the check found ${fmtOnchainQty(chk.variance)})` : ''}.</div>
      <table style="border-collapse:collapse;font-size:10px;width:100%;margin-top:4px">
        <tr style="background:#f3f3f3"><th style="text-align:left;padding:3px 5px">Where the difference comes from</th><th style="text-align:right;padding:3px 5px">Days</th><th style="text-align:right;padding:3px 5px">Difference</th></tr>
        <tr style="border-top:1px solid #eee"><td style="padding:3px 5px">Already there on ${dayStr(c.firstDay)}, the first day of WinDB's history for this wallet (older than WinDB's history: trace it with the exact walk)</td><td></td>
          <td style="padding:3px 5px;text-align:right;font-weight:700">${fmtOnchainQty(c.startDiff)}</td></tr>
        <tr style="border-top:1px solid #eee"><td style="padding:3px 5px">Small daily differences, each under ${ONCHAIN_DAY_THRESHOLD[tk]} ${escapeHTML(tk)} (mostly network fees, which the app does not book)</td>
          <td style="padding:3px 5px;text-align:right">${c.small.n.toLocaleString()}</td><td style="padding:3px 5px;text-align:right;font-weight:700">${fmtOnchainQty(c.small.sum)}</td></tr>
        <tr style="border-top:1px solid #eee"><td style="padding:3px 5px">Days the books and the ledger part (listed below)</td>
          <td style="padding:3px 5px;text-align:right">${c.events.length.toLocaleString()}</td><td style="padding:3px 5px;text-align:right;font-weight:700">${fmtOnchainQty(evTotal)}</td></tr>
        <tr style="border-top:2px solid #999"><td style="padding:3px 5px"><b>${closes ? 'Total — adds up to the difference' : 'Total (does not add up: see the note)'}</b></td><td></td>
          <td style="padding:3px 5px;text-align:right;font-weight:700;color:${closes ? '#1a5c2a' : '#8b0000'}">${fmtOnchainQty(c.startDiff + c.small.sum + evTotal)}</td></tr>
      </table>
      ${top.length ? `<table style="border-collapse:collapse;font-size:10px;width:100%;margin-top:6px">
        <tr style="background:#f3f3f3"><th style="text-align:left;padding:3px 5px">Day (UTC)</th><th style="text-align:right;padding:3px 5px">Ledger moved</th>
          <th style="text-align:right;padding:3px 5px">App booked</th><th style="text-align:right;padding:3px 5px">Difference</th>
          <th style="text-align:right;padding:3px 5px">Running</th><th style="text-align:left;padding:3px 5px">Downloaded transactions that day</th></tr>
        ${top.map((e) => {
          const txs = (x.txByDay || {})[e.day] || [];
          const brief = txs.length
            ? `<details><summary>${txs.length}${txs.length >= 80 ? '+' : ''}: ${escapeHTML([...new Set(txs.map((t) => t.type))].join(', '))}</summary>${txs.map((t) =>
                `<div style="font-family:monospace;font-size:9px">${escapeHTML(t.ts.slice(11))} ${escapeHTML(t.type)} ${escapeHTML(t.dir)} ${escapeHTML(t.amount)}${t.result && t.result !== 'tesSUCCESS' ? ' ' + escapeHTML(t.result) : ''}${t.affected ? ' (lease/affected import)' : ''}</div>`).join('')}</details>`
            : '<span style="color:#8b0000">none — the ledger moved without a transaction the app downloaded (e.g. a resting DEX offer filled by someone else)</span>';
          return `<tr style="border-top:1px solid #eee;vertical-align:top"><td style="padding:3px 5px">${dayStr(e.day)}</td>
            <td style="padding:3px 5px;text-align:right">${fmtOnchainQty(e.ledger)}</td><td style="padding:3px 5px;text-align:right">${fmtOnchainQty(e.app)}</td>
            <td style="padding:3px 5px;text-align:right;font-weight:700">${fmtOnchainQty(e.delta)}</td><td style="padding:3px 5px;text-align:right">${fmtOnchainQty(e.running)}</td>
            <td style="padding:3px 5px">${brief}</td></tr>`;
        }).join('')}
      </table>` : ''}
    </div>`;
  }).join('');
  return `<div id="onchainExplain" style="margin-top:12px;padding:10px;border:1px solid #ccd;border-radius:4px;background:#fafaff">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
      <div style="font-size:12px"><b>Explain (day by day):</b> ${label ? escapeHTML(label) + ' · ' : ''}<span style="font-family:monospace">${escapeHTML(x.wallet)}</span> on ${escapeHTML(x.chain)}</div>
      <div><button class="sml" onclick="exportExplainCSV()">⬇ Explain CSV</button>
        <button class="sml" title="Walks every transaction on a public full-history server; slower, needs those servers reachable" onclick="explainExact('${escapeHTML(x.wallet)}','${escapeHTML(x.chain)}')">Exact transactions (public server)</button>
        <button class="sml" onclick="_onchainExplain=null; renderOnchainPanel()">Close</button></div>
    </div>
    <div style="font-size:10px;color:#666;margin:4px 0">Each day the wallet was active, WinDB's end-of-day balance is set beside what the app booked that day.
      A difference shows the day the app's books and the ledger part company, and lists what was downloaded that day. Differences are app minus ledger:
      positive means the app thinks the wallet holds more.</div>
    ${sections}</div>`;
}

function exportExplainCSV() {
  const x = _onchainExplain;
  if (!x) return;
  if (x.kind === 'daily') {
    const lines = ['Day (UTC),Asset,Kind,Ledger Moved,App Booked,Difference (app - ledger),Running Difference,Downloaded Transactions,Types'];
    for (const [tk, c] of Object.entries(x.assets)) {
      if (c.firstDay == null) { lines.push(['', tk, 'no WinDB history up to the comparison day', '', c.appAtD.toFixed(6), '', '', '', ''].map(csvField).join(',')); continue; }
      lines.push([dayStr(c.firstDay), tk, 'difference already present at the start of WinDB history', '', '', c.startDiff.toFixed(6), c.startDiff.toFixed(6), '', ''].map(csvField).join(','));
      for (const e of c.events.slice().sort((a, b) => a.day - b.day)) {
        const txs = (x.txByDay || {})[e.day];
        lines.push([dayStr(e.day), tk, 'day the books and the ledger part', e.ledger.toFixed(6), e.app.toFixed(6), e.delta.toFixed(6), e.running.toFixed(6),
          txs ? String(txs.length) : '', txs ? [...new Set(txs.map((t) => t.type))].join(' ') : ''].map(csvField).join(','));
      }
      lines.push(['', tk, `small daily differences (${c.small.n} days)`, '', '', c.small.sum.toFixed(6), '', '', ''].map(csvField).join(','));
      lines.push([dayStr(Math.floor(x.pin.ms / DAY_MS)), tk, 'difference at the comparison day', c.ledgerAtD.toFixed(6), c.appAtD.toFixed(6), c.finalDiff.toFixed(6), '', '', ''].map(csvField).join(','));
    }
    downloadCSV(lines, `Onchain-Explain-Daily-${x.wallet.slice(0, 10)}-${x.chain}-${new Date(x.at).toISOString().slice(0, 10)}.csv`);
    return;
  }
  const lines = ['Date (UTC),Asset,Cause,Cause Detail,Transaction Type,Role,Counterparty,Ledger Moved (excl. fee),Fee,App Booked,App Shortfall,Difference (app - ledger),In Cache,Result,Ledger Hash,CTID'];
  for (const t of x.rows) {
    lines.push([t.dateMs ? new Date(t.dateMs).toISOString().replace('T', ' ').slice(0, 19) : '', t.ticker, t.category, EXPLAIN_CATEGORIES[t.category] || '',
      t.type, t.role, t.counterparty, t.ledger.toFixed(6), t.fee.toFixed(6), t.app.toFixed(6), (t.short || 0).toFixed(6), t.diff.toFixed(6),
      t.inCache ? 'yes' : 'no', t.result, t.hash || t.id || '', t.ctid || ''].map(csvField).join(','));
  }
  for (const [tk, s] of Object.entries(x.summary)) {
    for (const [c, b] of Object.entries(s.buckets)) {
      lines.push(['TOTAL', tk, c, EXPLAIN_CATEGORIES[c] || '', `${b.n} transactions`, '', '', b.ledger.toFixed(6), '', b.app.toFixed(6), '', b.diff.toFixed(6), '', '', '', ''].map(csvField).join(','));
    }
    lines.push(['TOTAL', tk, 'difference', `app ${s.appAtPin.toFixed(6)} vs ledger walk ${s.walk.toFixed(6)}; residual ${s.residual.toFixed(6)}`, '', '', '', '', '', '', '', s.variance.toFixed(6), '', '', '', ''].map(csvField).join(','));
  }
  downloadCSV(lines, `Onchain-Explain-${x.wallet.slice(0, 10)}-${x.chain}-${new Date(x.at).toISOString().slice(0, 10)}.csv`);
}
