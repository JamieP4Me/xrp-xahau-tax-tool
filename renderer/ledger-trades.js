// renderer/ledger-trades.js — XRPL trades, read from the ledger (1.10.14).
//
// WHY
//
// The download (WinDB) holds what each transaction ASKED for. For a trade
// that is not enough, three ways:
//
//   * An OfferCreate states terms. It may fill at once, in part, later, or
//     never. The app booked every "sell XRP" offer as a sale of the full
//     amount offered, and never booked what was bought with it.
//   * A token sold for XRP was not booked at all: no disposal of the token
//     and no lot for the XRP that arrived.
//   * When someone else's transaction fills your resting offer, that
//     transaction is signed by them and is not in the download under your
//     wallet at all.
//
// The ledger's own record has none of these gaps. Every transaction carries
// metadata listing each balance it changed, before and after. So this reads
// every transaction that touched a wallet (account_tx, the same read-only
// call "Explain" uses) and keeps, for each one that moved a token, what
// actually changed for that wallet: XRP (fee taken out) and each token.
//
// WHAT IS STORED
//
// One cache row per (wallet, transaction), under the key 'LEDGER:<hash>'
// ('LEDGERAMM:<hash>' for AMM transactions), with TransactionType
// 'LedgerChange'. They sit in the same table as the download, so the engine
// meets them in the same chronological stream as everything else and FIFO
// order holds. db.js ledger_sweep records how far each wallet has been read.
//
// WHAT THE ENGINE DOES WITH THEM (processLedgerChangeRow in index.html)
//
//   XRP out, one token in   a purchase: the XRP is disposed of at that day's
//                           price, and the token gets a lot whose basis is
//                           what the XRP was worth.
//   one token out, XRP in   a sale: the token is disposed of for what the XRP
//                           was worth, and the XRP gets a lot at that price.
//   a token in or out alone no value is known. Quantities are kept right (a
//                           dated $0 lot in; lots used up out) and the row is
//                           listed, not put on Form 8949.
//   anything else           listed for review, quantities kept right.
//   AMM transactions        follow the AMM treatment setting. Standard: stored
//                           and listed, not booked. Treatment A (1.10.15):
//                           both assets and the LP tokens are booked from
//                           this record (bookAmmFromLedger in index.html).
//   to or from a bridge     the same coins moving between Xahau and XRPL: no
//                           sale, cost and dates kept (bridgeConfig).
//
// A transaction that has a ledger row is booked from the ledger row ONLY; the
// download's view of the same transaction is skipped. An OfferCreate inside
// the range read that has no ledger row did not trade when it was placed, and
// is no longer booked as a sale.
//
// Network: every request goes through the main process (ledger-rpc.js): the
// listed hosts only, read-only methods only, and the Payment-Claim to Dhali
// alone. The server is the one chosen in the on-chain check's settings.
'use strict';

const LT_ROW_TYPE = 'LedgerChange';
const LT_RIPPLE_EPOCH = 946684800;
const LT_GENESIS_LEDGER = 32570;       // the first ledger any XRPL server holds
const LT_XRP_EPS = 0.0000005;          // under half a drop is float noise, not XRP
const LT_ADDR_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const LT_ABSENT_KEY = 'ledgerTradesNotOnXrpl';   // app_meta: wallet -> when it was last found not to exist on XRPL
const LT_PARTIAL_KEY = 'ledgerTradesPartial';    // app_meta: wallet -> {ledger, txs, stored} of a read that did not finish

// ── Token names ────────────────────────────────────────────────────────────
// A token is identified by its currency code AND its issuer; two issuers can
// both call a token "USD". The engine keys lots by one string, so that string
// is "<code>.<issuer>".
//
// The code is chosen by whoever issued the token and is shown in tables all
// over the app, so it is reduced to letters and digits here, once. Anything
// else (a 20-byte code that is not plain text, an LP token, a symbol) stays
// as its 40-hex form, which is equally unique and cannot carry markup.
function ltCurrencyCode(raw) {
  const c = String(raw || '').trim();
  if (/^[A-Za-z0-9]{3}$/.test(c)) return c;
  if (/^[0-9A-Fa-f]{40}$/.test(c)) {
    let out = '';
    for (let i = 0; i < 40; i += 2) {
      const b = parseInt(c.slice(i, i + 2), 16);
      if (b === 0) continue;
      out += String.fromCharCode(b);
    }
    return /^[A-Za-z0-9]{1,20}$/.test(out) ? out : c.toUpperCase();
  }
  // A 3-character code with a symbol in it: hex of its characters.
  let hex = '';
  for (const ch of c) hex += ch.charCodeAt(0).toString(16).padStart(2, '0');
  return ('X' + hex).toUpperCase().slice(0, 41);
}
function ltTicker(rawCurrency, issuer) {
  if (!LT_ADDR_RE.test(String(issuer || ''))) return null;
  const code = ltCurrencyCode(rawCurrency);
  return code ? code + '.' + issuer : null;
}
const ltIsToken = (ticker) => typeof ticker === 'string' && ticker.indexOf('.') > 0;
// For descriptions: "mXRP (rEXAMPL…)". Letters, digits, spaces, brackets only.
function ltTokenLabel(ticker) {
  if (!ltIsToken(ticker)) return String(ticker);
  const i = ticker.indexOf('.');
  const code = ticker.slice(0, i), issuer = ticker.slice(i + 1);
  if (/^03[0-9A-F]{38}$/.test(code)) {
    // An LP token's code is a hash. Once the engine has seen the pool's
    // assets it is named for them: "LP XRP/MAG".
    const pool = (typeof lpPoolName === 'function') ? lpPoolName(ticker) : null;
    return pool || `LP token ${code.slice(2, 8)} (${issuer.slice(0, 7)}…)`;
  }
  const name = code.length > 20 ? code.slice(0, 8) + '…' : code;
  return `${name} (${issuer.slice(0, 7)}…)`;
}

// ── Reading one transaction (pure) ─────────────────────────────────────────
// Token balance changes for `account`, keeping the RAW currency code. The
// stored balance is from the low account's side; flipped for the high side.
// Changes on several trust lines of one token are added together.
function ltIouDeltas(meta, account) {
  const sum = new Map();
  if (!meta || !Array.isArray(meta.AffectedNodes)) return [];
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
    const issuer = account === high ? low : high;
    const k = String(bal.currency) + '|' + issuer;
    sum.set(k, (sum.get(k) || 0) + d);
  }
  const out = [];
  for (const [k, d] of sum) {
    if (!d) continue;
    const i = k.indexOf('|');
    out.push({ c: k.slice(0, i), i: k.slice(i + 1), d });
  }
  return out;
}

// One account_tx entry -> what changed for `wallet`, or null when it failed
// or cannot be read. `xrp` is the change with the fee taken out, so a trade's
// XRP side is what was traded, not that amount less a few drops.
function ltChangesFromTx(entry, wallet) {
  const tx = (entry && (entry.tx || entry.tx_json)) || {};
  const meta = (entry && (entry.meta || entry.metaData)) || {};
  if (meta.TransactionResult !== 'tesSUCCESS') return null;
  const hash = String(entry.hash || tx.hash || '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hash)) return null;
  const dateMs = tx.date != null ? (Number(tx.date) + LT_RIPPLE_EPOCH) * 1000
    : (entry.close_time_iso ? Date.parse(entry.close_time_iso) : NaN);
  if (!Number.isFinite(dateMs)) return null;
  const signer = tx.Account === wallet;
  const native = onchainNativeDelta(meta, wallet);
  const fee = signer ? Number(tx.Fee || 0) / 1e6 : 0;
  let xrp = (native == null ? 0 : native) + fee;
  xrp = Math.abs(xrp) < LT_XRP_EPS ? 0 : Math.round(xrp * 1e6) / 1e6;
  return {
    hash, dateMs,
    ledgerIndex: Number(entry.ledger_index != null ? entry.ledger_index : tx.ledger_index) || null,
    txIndex: Number.isFinite(Number(meta.TransactionIndex)) ? Number(meta.TransactionIndex) : null,
    type: String(tx.TransactionType || ''),
    account: String(tx.Account || ''), destination: String(tx.Destination || ''),
    role: signer ? 'sent' : (tx.Destination === wallet ? 'received' : 'affected'),
    fee, xrp, tokens: ltIouDeltas(meta, wallet),
    pool: /^AMM/.test(String(tx.TransactionType || '')) ? [tx.Asset, tx.Asset2].map(ltAssetTicker).filter(Boolean) : [],
  };
}

// An AMM transaction names its pool's two assets: { currency: 'XRP' } or { currency, issuer }.
function ltAssetTicker(a) {
  if (!a || typeof a !== 'object') return null;
  if (a.currency === 'XRP' && !a.issuer) return 'XRP';
  return ltTicker(a.currency, a.issuer);
}

const ltTs = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

// The cache row for one change, or null when no token moved (those are left
// to the download: an XRP payment is already booked from it).
function ltCacheRow(ch) {
  if (!ch || !ch.tokens.length) return null;
  const amm = /^AMM/.test(ch.type);
  const ts = ltTs(ch.dateMs);
  const raw = {
    _ledger: 1, TransactionType: LT_ROW_TYPE, TransactionResult: 'tesSUCCESS', Timestamp: ts,
    LedgerHash: ch.hash, LedgerType: ch.type, LedgerIndex: ch.ledgerIndex, TxIndex: ch.txIndex,
    Account: ch.account, Destination: ch.destination, Role: ch.role,
    Fee_XRP: ch.fee, XRP: ch.xrp, Tokens: ch.tokens,
  };
  if (amm && Array.isArray(ch.pool) && ch.pool.length === 2) raw.Pool = ch.pool;
  return { tx_hash: (amm ? 'LEDGERAMM:' : 'LEDGER:') + ch.hash, timestamp: ts, raw_json: JSON.stringify(raw) };
}

// What kind of event one stored row is. Pure: the engine and the tests agree
// on it by calling the same function.
function ltShape(row) {
  const tokens = (Array.isArray(row && row.Tokens) ? row.Tokens : []).filter((t) => t && Number.isFinite(Number(t.d)) && Number(t.d) !== 0);
  let x = Number(row && row.XRP) || 0;
  if (Math.abs(x) < LT_XRP_EPS) x = 0;
  if (/^AMM/.test(String((row && row.LedgerType) || ''))) return { kind: 'amm', xrp: x, tokens };
  if (!tokens.length) return { kind: 'none', xrp: x, tokens };
  if (tokens.length === 1) {
    const t = tokens[0], d = Number(t.d);
    if (x < 0 && d > 0) return { kind: 'buy', xrp: -x, qty: d, token: t, tokens };
    if (x > 0 && d < 0) return { kind: 'sell', xrp: x, qty: -d, token: t, tokens };
    if (x === 0) return { kind: d > 0 ? 'token_in' : 'token_out', xrp: 0, qty: Math.abs(d), token: t, tokens };
    return { kind: 'complex', xrp: x, tokens };
  }
  if (tokens.length === 2 && x === 0 && (Number(tokens[0].d) > 0) !== (Number(tokens[1].d) > 0)) return { kind: 'token_swap', xrp: 0, tokens };
  return { kind: 'complex', xrp: x, tokens };
}

const LT_KIND_WORDS = {
  buy: 'Bought a token with XRP', sell: 'Sold a token for XRP',
  token_in: 'Token received, no value recorded ($0 basis)', transfer_in: 'Token moved in from another of your wallets',
  transfer_out: 'Token moved to another of your wallets',
  to_issuer: 'Token sent to its issuer (burn, redemption or migration), no proceeds recorded',
  gift_unpriced: 'Token sent to a gift address, value not known', sent_unvalued: 'Token sent, value not known',
  other_out: 'Token left the wallet, value not known', token_swap: 'Token traded for another token, value not known',
  complex: 'Several assets moved, review needed', amm: 'AMM transaction, not booked (Standard treatment)',
  lost_wallet: 'From a lost wallet, quantities only',
  swap_valued: 'Token traded for another token, valued at the bridged asset\'s price',
  amm_deposit: 'Deposited to an AMM pool: assets sold at value, LP tokens received',
  amm_withdraw: 'Withdrawn from an AMM pool: LP tokens sold for the value received',
  amm_carried: 'AMM pool, no value known: cost carried across, nothing reported as sold',
  amm_other: 'Other AMM transaction, quantities only',
  bridge_out: 'Sent to a bridge: in transit to the other chain, not a sale',
  bridge_in: 'Arrived from a bridge with its original cost and dates',
  bridge_in_unmatched: 'Arrived from a bridge with nothing recorded as sent: booked at that day\'s price',
  gift: 'Gift of a token (see the Gift Log)',
};
// Which kinds put a row on Form 8949.
const LT_ON_8949 = new Set(['buy', 'sell', 'swap_valued', 'amm_deposit', 'amm_withdraw']);

// ── The sweep ──────────────────────────────────────────────────────────────
let _ltRunning = false, _ltCancel = false, _ltStatus = '';

function ltWalletsToRead() {
  const out = new Set(typeof WALLETS !== 'undefined' ? WALLETS : []);
  if (typeof lostWallets !== 'undefined') for (const w of lostWallets) out.add(w.addr);
  return [...out].filter((w) => LT_ADDR_RE.test(w));
}

// Read one wallet from just after `prev.through_ledger` (or from the start)
// up to `bound`. Stores as it goes; returns counts. Throws on a server error.
//
// A first read of a busy wallet is a few hundred requests to a public server.
// If one fails, the next attempt should not start again from the beginning:
// after each page the ledger it reached is noted (`partial`), and a later
// read resumes from that ledger. The note is only a place to resume from. A
// wallet is recorded as read (ledger_sweep) only when a read reaches `bound`.
async function ltSweepWallet(wallet, prev, bound, onStep, partial, savePartial) {
  const after = prev ? Number(prev.through_ledger) + 1 : -1;
  if (prev && after > bound) return { txs: 0, stored: 0, upToDate: true };
  const resume = partial && Number.isInteger(partial.ledger) && partial.ledger > Math.max(after, LT_GENESIS_LEDGER) && partial.ledger <= bound;
  const min = resume ? partial.ledger : after;
  const limit = onchainUsesDhali('XRPL') ? 400 : 200;
  let marker, txs = resume ? Number(partial.txs) || 0 : 0, stored = resume ? Number(partial.stored) || 0 : 0, first = !resume;
  do {
    if (_ltCancel) throw new Error('stopped');
    const params = { account: wallet, ledger_index_min: min, ledger_index_max: bound, forward: true, limit };
    if (marker) params.marker = marker;
    const r = await onchainRpc('XRPL', 'account_tx', params);
    if (r.notFound) return { notFound: true, txs: 0, stored: 0 };
    if (r.error) throw new Error(`account_tx: ${r.error}${r.error_message ? ' (' + r.error_message + ')' : ''}`);
    // A first read must start where the ledger starts. A server that keeps
    // only recent history would answer with what it has, and the result would
    // look complete while missing every earlier trade.
    if (first && !prev && Number(r.ledger_index_min) > LT_GENESIS_LEDGER) {
      throw new Error(`this server only holds ledgers from ${Number(r.ledger_index_min).toLocaleString()} on, not the full history; choose a full-history server in the on-chain check's settings`);
    }
    first = false;
    const rows = [];
    let lastLedger = null;
    for (const e of (r.transactions || [])) {
      txs++;
      const li = Number(e.ledger_index != null ? e.ledger_index : (e.tx || e.tx_json || {}).ledger_index);
      if (Number.isInteger(li)) lastLedger = li;
      const row = ltCacheRow(ltChangesFromTx(e, wallet));
      if (row) rows.push(row);
    }
    // insertRows answers with the rows it actually wrote, so a ledger read a
    // second time after a resume is not counted twice.
    if (rows.length) stored += Number(await window.taxDB.insertRows(wallet, 'XRPL', rows)) || 0;
    marker = r.marker;
    // The last ledger on a page may continue on the next one, so the resume
    // point is that ledger itself, read again in full.
    if (marker && lastLedger != null && savePartial) await savePartial({ ledger: lastLedger, txs, stored });
    onStep(txs, stored);
    if (marker) await onchainSleep(onchainPause('XRPL'));
  } while (marker);
  return { txs, stored };
}

// Read every wallet. opts.auto: only wallets already read once, quietly (run
// after a download so the trades stay current). Returns a summary, or null
// when it did not run.
async function sweepLedgerTrades(opts = {}) {
  if (!USE_LOCAL_DB || !window.taxDB.getLedgerSweeps || _ltRunning) return null;
  const prevAll = new Map();
  for (const s of await window.taxDB.getLedgerSweeps()) if (s.chain === 'XRPL') prevAll.set(s.wallet, s);
  if (opts.auto && !prevAll.size) return null;
  // Most Evernode host accounts exist on Xahau only. Asking the XRP Ledger
  // about each of them after every download is a minute of requests that can
  // only answer "not found" again, so the automatic run skips the ones found
  // absent in the last 30 days. Pressing the button asks about all of them.
  let absent = {};
  try { absent = JSON.parse((await window.taxDB.getMeta(LT_ABSENT_KEY)) || '{}') || {}; } catch (e) { absent = {}; }
  const recent = (w) => absent[w] && Date.now() - absent[w] < 30 * 86400000;
  let partials = {};
  try { partials = JSON.parse((await window.taxDB.getMeta(LT_PARTIAL_KEY)) || '{}') || {}; } catch (e) { partials = {}; }
  const savePartials = async () => { try { await window.taxDB.setMeta(LT_PARTIAL_KEY, JSON.stringify(partials)); } catch (e) {} };
  const wallets = ltWalletsToRead().filter((w) => !opts.auto || prevAll.has(w) || !recent(w));
  if (!wallets.length) { if (!opts.auto) alert('No wallets to read. Add your wallets on the Setup tab first.'); return null; }

  _ltRunning = true; _ltCancel = false;
  const sum = { wallets: 0, notOnXrpl: 0, txs: 0, stored: 0, failed: [], stopped: false, changed: false };
  let before = '0';
  try { before = await window.taxDB.getDataVersion(); } catch (e) {}
  const say = (s) => { _ltStatus = s; refreshLedgerTradesPanel(); };
  try {
    await withLedgerLock('read of XRPL trades from the ledger', async () => {
      // One upper bound for every wallet: the newest validated ledger now.
      const v = await onchainRpc('XRPL', 'ledger', { ledger_index: 'validated', transactions: false, expand: false });
      const bound = Number(v && (v.ledger_index != null ? v.ledger_index : (v.ledger && v.ledger.ledger_index)));
      const closeMs = onchainCloseMs(v && v.ledger);
      if (v.error || !Number.isInteger(bound) || bound <= 0 || !Number.isFinite(closeMs)) {
        throw new Error('could not read the newest ledger from ' + onchainServerName('XRPL') + (v && v.error ? ` (${v.error})` : ''));
      }
      for (let i = 0; i < wallets.length; i++) {
        const w = wallets[i], prev = prevAll.get(w) || null;
        const label = (typeof labelFor === 'function' && labelFor(w)) || w.slice(0, 10) + '…';
        const step = (txs, stored) => {
          progressSet('ledgerTrades', `Reading XRPL trades from the ledger: wallet ${i + 1} of ${wallets.length} (${label}), ${txs.toLocaleString()} transactions read`, i, wallets.length);
          _ltStatus = `Reading wallet ${i + 1} of ${wallets.length}: ${txs.toLocaleString()} transactions read, ${stored.toLocaleString()} moved a token…`;
        };
        step(0, 0); refreshLedgerTradesPanel();
        try {
          const r = await ltSweepWallet(w, prev, bound, step, partials[w], async (p) => { partials[w] = p; await savePartials(); });
          if (partials[w]) { delete partials[w]; await savePartials(); }
          if (r.notFound) { sum.notOnXrpl++; absent[w] = Date.now(); }
          else {
            sum.wallets++; sum.txs += r.txs; sum.stored += r.stored;
            await window.taxDB.setLedgerSweep({ wallet: w, chain: 'XRPL', through_ledger: bound, through_ts: ltTs(closeMs),
              txs: (prev ? prev.txs : 0) + r.txs, stored: (prev ? prev.stored : 0) + r.stored });
          }
        } catch (e) {
          if (_ltCancel) { sum.stopped = true; break; }
          // One wallet failing must not hide the rest; it keeps its old range
          // (or none), so nothing is claimed that was not read.
          sum.failed.push({ wallet: w, error: String(e && e.message || e) });
        }
        await onchainSleep(onchainPause('XRPL'));
      }
    });
  } catch (e) {
    sum.failed.push({ wallet: '', error: String(e && e.message || e) });
  } finally {
    progressDone('ledgerTrades');
    _ltRunning = false;
  }
  try { await window.taxDB.setMeta(LT_ABSENT_KEY, JSON.stringify(absent)); } catch (e) {}
  try { sum.changed = (await window.taxDB.getDataVersion()) !== before; } catch (e) { sum.changed = true; }
  _ltStatus = sum.stopped ? 'Stopped. Wallets already finished keep what was read.'
    : sum.failed.length ? `Finished with ${sum.failed.length} problem(s): ${sum.failed.map((f) => (f.wallet ? f.wallet.slice(0, 8) + '… ' : '') + f.error).join('; ')}`
    : `Read ${sum.wallets} wallet(s): ${sum.txs.toLocaleString()} new transaction(s), ${sum.stored.toLocaleString()} moved a token.` +
      (sum.notOnXrpl ? ` ${sum.notOnXrpl} wallet(s) do not exist on the XRP Ledger.` : '');
  if (typeof log === 'function') log('XRPL trades from the ledger: ' + _ltStatus, sum.failed.length ? 'wa' : 'ok');
  await refreshLedgerTradesPanel();
  // The figures depend on what was just read: build them again.
  if (sum.changed && typeof buildReportFromCache === 'function') await buildReportFromCache({ silent: true });
  await refreshLedgerTradesPanel();
  return sum;
}

async function sweepLedgerTradesUI() {
  if (_ltRunning) return;
  const server = onchainServerName('XRPL');
  if (!confirm(`Read every XRPL transaction of your wallets from ${server}?\n\n` +
      'Read-only. A wallet with thousands of transactions takes a few minutes the first time; later reads only fetch what is new. ' +
      'When it finishes the report is rebuilt, and XRPL trades are booked from what the ledger says actually moved.')) return;
  await sweepLedgerTrades();
}
function stopLedgerTrades() { _ltCancel = true; }

// After a download: bring wallets that were already read up to date. Off in
// the test suite (it would reach real servers).
async function autoSweepLedgerTrades() {
  if (window.appInfo && window.appInfo.onchainCheck === false) return null;
  try { return await sweepLedgerTrades({ auto: true }); } catch (e) { return null; }
}

async function clearLedgerTradesUI() {
  if (!USE_LOCAL_DB || !window.taxDB.clearLedgerTrades || _ltRunning) return;
  if (typeof ledgerBusy === 'function' && ledgerBusy()) return;
  if (!confirm('Remove everything read from the ledger?\n\nXRPL trades go back to being booked from the download: offers at the amount offered, token sales not booked. You can read them again at any time.')) return;
  const n = await window.taxDB.clearLedgerTrades();
  _ltStatus = `Removed ${n.toLocaleString()} ledger row(s).`;
  await refreshLedgerTradesPanel();
  if (typeof buildReportFromCache === 'function') await buildReportFromCache({ silent: true });
  await refreshLedgerTradesPanel();
}

async function refreshLedgerTradesPanel() {
  const section = document.getElementById('ledgerTradesSection');
  if (!section) return;
  if (!USE_LOCAL_DB || !window.taxDB.getLedgerSweeps) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  const box = document.getElementById('ledgerTradesStats');
  const btn = document.getElementById('ledgerTradesBtn'), stop = document.getElementById('ledgerTradesStop');
  if (btn) { btn.disabled = _ltRunning; btn.textContent = _ltRunning ? '⏳ Reading…' : '⟳ Read XRPL trades from the ledger'; }
  if (stop) stop.style.display = _ltRunning ? '' : 'none';
  try {
    const sweeps = (await window.taxDB.getLedgerSweeps()).filter((s) => s.chain === 'XRPL');
    let html;
    if (!sweeps.length) {
      html = '<span style="color:#b06000">Not read yet.</span> XRPL offers are booked at the amount <b>offered</b>, and tokens bought or sold are not booked.';
    } else {
      const txs = sweeps.reduce((s, x) => s + x.txs, 0), stored = sweeps.reduce((s, x) => s + x.stored, 0);
      const oldest = sweeps.map((s) => s.through_ts).sort()[0];
      const s = (typeof ledgerTradeStats !== 'undefined') ? ledgerTradeStats : null;
      html = `<b>${sweeps.length}</b> wallet(s) read through <b>${escapeHTML(oldest)} UTC</b> &nbsp;·&nbsp; ` +
        `${txs.toLocaleString()} transactions read, <b>${stored.toLocaleString()}</b> moved a token` +
        (s && s.rows ? `<br>In this report: ${s.buys.toLocaleString()} purchase(s), ${s.sells.toLocaleString()} sale(s), ` +
          `${s.offersNotFilled.toLocaleString()} offer(s) that did not trade, ${(s.tokenIn + s.tokenOut + s.swaps + s.complex).toLocaleString()} listed without a value.` : '');
    }
    if (_ltStatus) html += `<br><span style="color:#7a4a00">${escapeHTML(_ltStatus)}</span>`;
    box.innerHTML = html;
  } catch (e) { box.textContent = 'Could not read: ' + e.message; }
  try { renderBridgeBox(); } catch (e) {}
}

// ── Bridge between Xahau and the XRP Ledger: the panel ─────────────────────
// The settings and the booking live in index.html (bridgeConfig, bridgeDepart,
// bridgeArrive). This lists what is marked, lets an address be added, and
// suggests candidates from what the ledger read found: an XRPL token named
// XAH or EVR that arrived from, or was sent to, one particular address.
//
// A suggestion is only a suggestion. Anyone can issue a token and call it
// "EVR", so nothing is treated as a bridge until the user says it is.
let _bridgeSuggestions = [], _bridgeHints = [];

function bridgeSuggestions() {
  const by = new Map();
  if (typeof ledgerTradeLog === 'undefined') return [];
  for (const r of ledgerTradeLog) {
    if ((r.chain || 'XRPL') !== 'XRPL' || !ltIsToken(r.ticker) || !LT_ADDR_RE.test(r.counterparty || '')) continue;
    if (r.kind !== 'token_in' && r.kind !== 'sent_unvalued') continue;
    const code = r.ticker.slice(0, r.ticker.indexOf('.')).toUpperCase();
    if (code !== 'XAH' && code !== 'EVR') continue;
    if (isBridgeAddress(r.counterparty) && bridgedNative(r.ticker)) continue;
    // Never offer an address that would be refused: one of your own wallets,
    // an exchange address of yours, a gift address or a lost wallet.
    if (bridgeAddressConflict(r.counterparty)) continue;
    let e = by.get(r.counterparty);
    if (!e) by.set(r.counterparty, e = { addr: r.counterparty, tokens: new Map(), n: 0 });
    let t = e.tokens.get(r.ticker);
    if (!t) e.tokens.set(r.ticker, t = { ticker: r.ticker, native: code, inQty: 0, outQty: 0 });
    if (r.kind === 'token_in') t.inQty += r.qty; else t.outQty += r.qty;
    e.n++;
  }
  // Dust from strangers is not a bridge: at least one whole coin each way in total.
  return [...by.values()].filter((e) => [...e.tokens.values()].some((t) => t.inQty + t.outQty >= 1))
    .sort((a, b) => b.n - a.n).slice(0, 8);
}

function renderBridgeBox() {
  const box = document.getElementById('bridgeBox');
  if (!box || typeof bridgeConfig === 'undefined') return;
  const q = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  _bridgeSuggestions = bridgeSuggestions();
  _bridgeHints = (typeof bridgeScan === 'undefined') ? [] : Object.entries(bridgeScan.hints)
    .filter(([a]) => LT_ADDR_RE.test(a) && !isBridgeAddress(a) && !bridgeAddressConflict(a))
    .map(([addr, h]) => ({ addr, n: h.n, qty: h.qty, native: h.native, dir: h.dir })).sort((a, b) => b.n - a.n).slice(0, 6);
  const s = (typeof ledgerTradeStats !== 'undefined') ? ledgerTradeStats : {};
  const transit = (typeof walletLedger !== 'undefined' && walletLedger[BRIDGE_TRANSIT]) || {};
  const waiting = Object.entries(transit).map(([t, lots]) => [t, lots.reduce((n, l) => n + l.remaining, 0)]).filter(([, n]) => n > 1e-9);
  const tokens = Object.entries(bridgeConfig.tokens);
  box.innerHTML = `
    <div class="sec-title" style="font-size:11px">Bridge between Xahau and the XRP Ledger</div>
    <div style="font-size:11px;color:#333;line-height:1.7">
      ${bridgeConfig.addresses.length
        ? `Bridge addresses: ${bridgeConfig.addresses.map((a, i) => `<code style="font-size:10px">${escapeHTML(a)}</code> <a href="#" style="font-size:9.5px" onclick="removeBridgeUI(${i});return false;">remove</a>`).join(' &nbsp;·&nbsp; ')}`
        : '<span style="color:#666">No bridge marked.</span> Coins sent to a bridge are booked as sold, and what arrives on the other chain has no cost.'}
      ${tokens.length ? `<br>Same coin on both chains: ${tokens.map(([t, n]) => `${escapeHTML(ltTokenLabel(t))} = ${n}`).join(', ')}` : ''}
      ${(s.bridgeOut || s.bridgeIn) ? `<br>In this report: ${s.bridgeOut} sent to a bridge, ${s.bridgeIn} arrived from one` +
        (s.bridgeUnmatched ? `, <strong style="color:#8b0000">${s.bridgeUnmatched} arrival(s) with nothing recorded as sent</strong> (mark the bridge's address on the other chain too)` : '') +
        (waiting.length ? `; still in transit: ${waiting.map(([t, n]) => `${q(n)} ${t}`).join(', ')}` : '') + '.' : ''}
    </div>
    ${_bridgeSuggestions.length ? `<div style="margin-top:6px;padding:8px 10px;background:#fff8e6;border:1px solid #e0c060;border-radius:4px;font-size:10.5px;color:#5a4300">
      <strong>These look like a bridge.</strong> A token named XAH or EVR moved between your wallets and one address. Mark it only if you used that address to move your own coins between the chains.
      ${_bridgeSuggestions.map((e, i) => `<div style="margin-top:4px"><code style="font-size:10px">${escapeHTML(e.addr)}</code>:
        ${[...e.tokens.values()].map((t) => `${t.inQty ? q(t.inQty) + ' received' : ''}${t.inQty && t.outQty ? ', ' : ''}${t.outQty ? q(t.outQty) + ' sent' : ''} of ${escapeHTML(ltTokenLabel(t.ticker))}`).join('; ')}
        <button class="sml" style="margin-left:6px" onclick="markBridgeSuggestion(${i})">Mark as bridge</button></div>`).join('')}
    </div>` : ''}
    ${_bridgeHints.length ? `<div style="margin-top:6px;padding:8px 10px;background:#fff8e6;border:1px solid #e0c060;border-radius:4px;font-size:10.5px;color:#5a4300">
      <strong>The other side of the bridge, on Xahau.</strong> These addresses sent or received about the same amount within two hours of a crossing on the XRP Ledger.
      ${_bridgeHints.map((e, i) => `<div style="margin-top:4px"><code style="font-size:10px">${escapeHTML(e.addr)}</code>:
        ${e.n} transfer(s), ${q(e.qty)} ${escapeHTML(e.native)} ${e.dir === 'to' ? 'sent to it' : 'received from it'}
        <button class="sml" style="margin-left:6px" onclick="markBridgeHint(${i})">Mark as bridge</button></div>`).join('')}
    </div>` : ''}
    <div class="row" style="margin-top:6px">
      <input id="bridgeAddrInput" style="flex:1;max-width:340px;font-size:11px;margin:0" placeholder="The bridge's own address (not your wallet)">
      <button class="sml" onclick="addBridgeUI()">Add bridge address</button>
    </div>
    <div style="font-size:10px;color:#888;margin-top:4px;line-height:1.5">
      A bridge moves your XAH or EVR between Xahau and the XRP Ledger. Marked, a payment to it is not a sale and what arrives from it is not
      income: the coins keep their cost and dates across the crossing. Mark the bridge's address on <b>both</b> chains if they differ.<br>
      <b>The bridge's address is not your wallet.</b> It is the address your wallet sent the coins to, and the one that paid them to you
      on the other chain. A wallet app such as Xaman fills it in for you, so you may never have seen it: the app finds it on the ledger
      and lists it above with a "Mark as bridge" button. Type an address here only if a bridge you used is not listed.
    </div>`;
}

async function bridgeChanged() {
  renderBridgeBox();
  if (typeof buildReportFromCache === 'function') await buildReportFromCache({ silent: true });
  await refreshLedgerTradesPanel();
  if (typeof renderHoldings === 'function') { try { await renderHoldings(); } catch (e) {} }
}
// Why an address was refused, and what to do instead.
function bridgeRefusal(why) {
  const own = /your own/.test(why);
  return `That address cannot be a bridge: ${why}.` + (own
    ? '\n\nA bridge is not the wallet you sent from. It is the address your wallet sent the coins TO on one chain, and the address that paid them to you on the other. ' +
      'Your wallet app filled it in for you. Look in the yellow panel above this box: the app lists the addresses it found on the ledger, each with a "Mark as bridge" button.'
    : '');
}
async function markBridgeSuggestion(i) {
  const e = _bridgeSuggestions[i];
  if (!e || (typeof ledgerBusy === 'function' && ledgerBusy())) return;
  const why = bridgeAddressConflict(e.addr);
  if (why) { alert(bridgeRefusal(why)); return; }
  addBridgeAddress(e.addr);
  for (const t of e.tokens.values()) setBridgedToken(t.ticker, t.native);
  await bridgeChanged();
}
async function markBridgeHint(i) {
  const e = _bridgeHints[i];
  if (e) await markBridgeUI(e.addr);
}
async function markBridgeUI(addr) {
  if (typeof ledgerBusy === 'function' && ledgerBusy()) return;
  const why = bridgeAddressConflict(addr);
  if (why) { alert(bridgeRefusal(why)); return; }
  if (!confirm(`Mark ${addr} as a bridge?\n\nCoins you sent to it will no longer be booked as sold; they are treated as your own coins moving to the other chain. Only do this for an address you used as a bridge.`)) return;
  addBridgeAddress(addr);
  await bridgeChanged();
}
async function addBridgeUI() {
  const el = document.getElementById('bridgeAddrInput');
  const addr = String((el && el.value) || '').trim();
  if (!addr) return;
  await markBridgeUI(addr);
}
async function removeBridgeUI(i) {
  const addr = bridgeConfig.addresses[i];
  if (!addr || (typeof ledgerBusy === 'function' && ledgerBusy())) return;
  if (!confirm(`Stop treating ${addr} as a bridge? Payments to it go back to being booked as sales.`)) return;
  removeBridgeAddress(addr);
  // A token stays "the same coin" only while some bridge address remains.
  if (!bridgeConfig.addresses.length) for (const t of Object.keys(bridgeConfig.tokens)) setBridgedToken(t, null);
  await bridgeChanged();
}
