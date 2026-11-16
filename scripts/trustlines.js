#!/usr/bin/env node
/*
 * scripts/trustlines.js — which trust lines to remove, and how.
 *
 * Every trust line your account holds locks the owner reserve (0.2 XRP on
 * XRPL today; read live from the server). Xaman's Token Trasher sends a
 * token back to its issuer and deletes the line, which frees that reserve.
 * The catch is tax, not mechanics:
 *
 *   * SENDING A TOKEN BACK TO ITS ISSUER IS NOT A SALE. You receive nothing,
 *     so it is an abandonment, and an individual's loss on abandoned
 *     property is a miscellaneous itemized deduction that §67(g) disallows
 *     (CCA 202302011). A token with basis that is burned loses its loss.
 *   * SELLING IT, at any price, is a disposition on Form 8949 and the loss
 *     counts on Schedule D. So: anything a buyer will take, SELL first, and
 *     only then trash the (now empty) line.
 *   * AN LP TOKEN IS A SHARE OF AN AMM POOL. Trashing it sends it to the
 *     pool's account and gives away your half of the pool. Never trash one.
 *
 * What it reads, per wallet, all read-only and live:
 *   server_info     the current reserve
 *   account_info    balance and owner count
 *   account_lines   every trust line and its balance
 *   account_objects whether each line counts toward YOUR reserve, and your
 *                   open offers (an open offer on a token blocks its removal)
 *   book_offers     who will buy each token for XRP, and at what price
 *   amm_info        the XRP/token AMM pool, if there is one; and for an LP
 *                   token, what your share of its pool is worth
 * and from the local cache (opened readonly): how often each token has
 * arrived and when it last did, so you do not cut off something still paying.
 *
 * Optionally, --holdings <Holdings-By-Wallet-….csv> (the app's own export)
 * supplies the remaining cost basis per wallet and token, which decides
 * whether burning one would throw away a usable loss.
 *
 * Every request goes through ledger-rpc.js, the app's vetted path: listed
 * hosts only, read-only methods only, and the Payment-Claim (if
 * DHALI_PAYMENT_CLAIM is exported) travels to run.api.dhali.io and nowhere
 * else. The public cluster is fine for this; it is a few dozen requests.
 *
 *   npm run trustlines -- --wallet rG9RHCRS --wallet rLNZjhGPvA
 *   npm run trustlines -- --wallet rG9RHCRS --holdings ~/Downloads/Holdings-By-Wallet-2026-11-13.csv
 *   options: --keep-xrp 5     a token worth at least this many XRP is "your call", not "sell"
 *            --min-sell 1     with no basis, a token worth less than this is trashed, not sold
 *                             (a sale for pennies is a Form 8949 line for pennies)
 *            --out file.csv   CSV name (default Trustlines-<date>.csv; gitignored)
 *            --db <path>      cache file (default: the app's)
 *            XRPL_RPC=https://run.api.dhali.io/<api id>/   use Dhali instead of the public cluster
 *
 * Estimates, not quotes: the book and pool move, and an issuer's transfer fee
 * is not deducted. The recommendation is what matters; the price is a guide.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const LP_RE = /^03[0-9A-F]{38}$/i;
const lsfLowReserve = 0x00010000;
const lsfHighReserve = 0x00020000;
const MIN_PROCEEDS_XRP = 0.001;    // below this a "buyer" is noise, not a sale
const RECENT_DAYS = 60;

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const drops = (v) => num(v) / 1e6;
const tokenValue = (v) => (v && typeof v === 'object' ? num(v.value) : num(v));
const isXrpAmount = (v) => typeof v === 'string' || typeof v === 'number';

// XRP received by selling `qty` of a token into the bids (offers whose owner
// gives XRP and wants the token), best price first. Funded amounts win over
// stated ones: an offer its owner cannot cover will not fill.
function sellIntoBook(offers, qty) {
  let left = qty, xrp = 0, filled = 0;
  for (const o of offers || []) {
    if (left <= 0) break;
    const gets = drops(o.taker_gets_funded != null ? o.taker_gets_funded : o.TakerGets);
    const pays = tokenValue(o.taker_pays_funded != null ? o.taker_pays_funded : o.TakerPays);
    if (!(gets > 0) || !(pays > 0)) continue;
    const take = Math.min(left, pays);
    xrp += gets * (take / pays);
    filled += take;
    left -= take;
  }
  return { xrp, filled, bestPrice: (() => {
    for (const o of offers || []) {
      const g = drops(o.taker_gets_funded != null ? o.taker_gets_funded : o.TakerGets);
      const p = tokenValue(o.taker_pays_funded != null ? o.taker_pays_funded : o.TakerPays);
      if (g > 0 && p > 0) return g / p;
    }
    return 0;
  })() };
}

// The XRP and token sides of an amm_info result, whichever order it lists them.
function poolSides(amm) {
  if (!amm) return null;
  const a = amm.amount, b = amm.amount2;
  if (isXrpAmount(a) && !isXrpAmount(b)) return { xrp: drops(a), token: tokenValue(b), fee: num(amm.trading_fee) / 100000 };
  if (isXrpAmount(b) && !isXrpAmount(a)) return { xrp: drops(b), token: tokenValue(a), fee: num(amm.trading_fee) / 100000 };
  return null;
}

// Constant-product swap: XRP out for `qty` token in, after the pool's fee.
function sellIntoAmm(amm, qty) {
  const s = poolSides(amm);
  if (!s || !(s.xrp > 0) || !(s.token > 0) || !(qty > 0)) return { xrp: 0 };
  const inAfterFee = qty * (1 - s.fee);
  return { xrp: s.xrp * inAfterFee / (s.token + inAfterFee), poolXrp: s.xrp, poolToken: s.token };
}

// What an LP token balance is a share of.
function lpShare(amm, balance) {
  if (!amm || !amm.lp_token) return null;
  const total = tokenValue(amm.lp_token);
  if (!(total > 0)) return null;
  const share = balance / total;
  const s = poolSides(amm);
  return {
    share,
    // A pool is balanced by value, so the token half is worth what the XRP half is.
    xrpValue: s ? 2 * s.xrp * share : null,
    sides: [amm.amount, amm.amount2].map((x) => isXrpAmount(x)
      ? { currency: 'XRP', qty: drops(x) * share }
      : { currency: x.currency, issuer: x.issuer, qty: tokenValue(x) * share }),
  };
}

// The recommendation for one line. Everything it needs is on `l`.
//   l.lp, l.balance, l.issuedByYou, l.frozenByIssuer, l.countsReserve,
//   l.proceeds (best of book / pool, XRP), l.basisUsd (null = unknown),
//   l.lastReceived (ISO or null), l.openOffers, l.lpXrp
function recommend(l, opts) {
  const keepXrp = opts.keepXrp, reserve = opts.reserveInc, now = opts.now || Date.now();
  const frees = l.countsReserve ? `frees ${reserve} XRP` : 'frees no reserve (the issuer side holds it)';
  const notes = [];
  if (l.openOffers) notes.push(`cancel your ${l.openOffers} open offer(s) on it first`);
  if (l.lastReceived && (now - Date.parse(l.lastReceived)) / 86400000 <= RECENT_DAYS) {
    notes.push(`still arriving (last ${l.lastReceived.slice(0, 10)}): removing the line stops it`);
  }
  const out = (action, why) => ({ action, why: [why, ...notes].join('; ') });

  if (l.lp) return out('KEEP — LP share',
    `your share of an AMM pool${l.lpXrp ? ` (~${l.lpXrp.toFixed(2)} XRP)` : ''}; trashing it gives the pool your half — withdraw from the pool instead if you want out`);
  if (l.issuedByYou) return out('LEAVE', 'you are the issuer of this balance');
  if (l.frozenByIssuer && l.balance > 0) return out('LEAVE — frozen', 'the issuer froze this line; it cannot be sold or sent until they unfreeze');
  if (!(l.balance > 0)) return out('REMOVE', `empty line; ${frees}`);
  if (l.proceeds >= keepXrp) return out('KEEP or SELL — your call', `a buyer pays ~${l.proceeds.toFixed(2)} XRP for it; if you sell, trash the empty line after (${frees})`);
  if (l.proceeds >= MIN_PROCEEDS_XRP && l.basisUsd != null && l.basisUsd <= 0.5 && l.proceeds < (opts.minSell || 1)) {
    return out('REMOVE (burn)', `worth only ~${l.proceeds.toFixed(l.proceeds < 0.1 ? 4 : 2)} XRP and has no basis: trashing loses no deduction and saves a sale (and a Form 8949 line); ${frees}`);
  }
  if (l.proceeds >= MIN_PROCEEDS_XRP) {
    const tax = l.basisUsd == null ? 'sell (not trash) so any loss counts on Schedule D'
      : l.basisUsd > 0.5 ? `basis $${l.basisUsd.toFixed(2)}: selling turns it into a Schedule D loss; trashing would forfeit it`
      : 'no basis to lose, but selling still beats trashing';
    return out('SELL then REMOVE', `a buyer pays ~${l.proceeds.toFixed(l.proceeds < 0.1 ? 4 : 2)} XRP; ${tax}; then trash the empty line (${frees})`);
  }
  if (l.basisUsd == null) return out('REMOVE (burn)', `no buyer at any price; ${frees}. If the app shows basis for it, that loss is not deductible once burned (§67(g))`);
  if (l.basisUsd > 0.5) return out('REMOVE (burn) — loss not deductible', `no buyer at any price; the $${l.basisUsd.toFixed(2)} basis is lost (abandonment, §67(g)); ${frees}. Keep it if you expect a market to appear`);
  return out('REMOVE (burn)', `no buyer and no basis: nothing is lost; ${frees}`);
}

// Holdings-By-Wallet CSV → Map "wallet|TICKER" → { basis USD, qty }.
// The CSV has no chain column, so one wallet's EVR row is its XRPL and Xahau
// EVR together. Callers prorate by quantity (basisFor) rather than pinning a
// whole holding's basis on a dust trust line.
function readHoldings(file) {
  const map = new Map();
  if (!file) return map;
  const text = fs.readFileSync(file, 'utf8');
  const rows = text.split(/\r?\n/).filter(Boolean).map(parseCsvLine);
  const head = rows.shift() || [];
  const iW = head.indexOf('Wallet'), iA = head.indexOf('Asset'), iB = head.indexOf('Cost Basis USD'), iP = head.indexOf('Unit Price USD'), iQ = head.indexOf('Quantity');
  const iC = head.indexOf('Chain');
  if (iW < 0 || iA < 0 || iB < 0) throw new Error('not a Holdings-By-Wallet CSV (needs Wallet, Asset, Cost Basis USD columns)');
  for (const r of rows) {
    const asset = String(r[iA] || '');
    // Since 1.10.14 an XRPL token is listed as "<code>.<issuer>", which names
    // the trust line exactly. Since 1.10.15 a Chain column says which chain a
    // row is on; a Xahau row (the wallet's Xahau EVR, say) is not about any
    // XRPL trust line and is left out, where before it was prorated in.
    const dot = asset.indexOf('.');
    if (dot > 0) { map.set(r[iW] + '|' + asset.slice(0, dot).toUpperCase() + '.' + asset.slice(dot + 1), { basis: num(r[iB]), qty: iQ >= 0 ? num(r[iQ]) : 0 }); map.set('__EXACT', true); continue; }
    if (iC >= 0 && String(r[iC]) !== 'XRPL' && asset.toUpperCase() !== 'XRP') continue;
    const k = r[iW] + '|' + asset.toUpperCase();
    const h = map.get(k) || { basis: 0, qty: 0 };
    h.basis += num(r[iB]); h.qty += iQ >= 0 ? num(r[iQ]) : 0;
    map.set(k, h);
    if (String(r[iA]).toUpperCase() === 'XRP' && iP >= 0 && num(r[iP]) > 0) map.set('__XRPUSD', num(r[iP]));
  }
  return map;
}

// Basis that belongs to `balance` units: the holding's basis per unit times the
// line's balance, never more than the whole holding.
function basisFor(h, balance) {
  if (!h) return 0;
  if (!(h.qty > 0)) return h.basis;
  return h.basis * Math.min(1, balance / h.qty);
}

function parseCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

const csvField = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

module.exports = { sellIntoBook, sellIntoAmm, poolSides, lpShare, recommend, readHoldings, basisFor, parseCsvLine, LP_RE };

// ─────────────────────────────────────────────────────────────────────────
if (require.main === module) main().catch((e) => { console.error('\n' + (e && e.message || e)); process.exit(1); });

async function main() {
  const { parseArgs, openCache, decodeCurrency, nonNativeLegs } = require('./iou-inventory');
  const ledger = require(path.join(__dirname, '..', 'ledger-rpc.js'));

  const prefixes = []; let holdingsFile = null, keepXrp = 5, minSell = 1;
  const rest = [];
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--wallet') { prefixes.push(String(process.argv[++i] || '')); continue; }
    if (a === '--holdings') { holdingsFile = String(process.argv[++i] || ''); continue; }
    if (a === '--keep-xrp') { keepXrp = num(process.argv[++i]) || 5; continue; }
    if (a === '--min-sell') { minSell = num(process.argv[++i]); continue; }
    rest.push(a);
  }
  const args = parseArgs(rest);
  if (!prefixes.length) { console.error('--wallet <address or prefix> is required (repeat it for more wallets)'); process.exit(2); }
  const chain = String(args.chain || 'XRPL').toLowerCase() === 'xahau' ? 'Xahau' : 'XRPL';
  const endpoint = chain === 'XRPL' ? (process.env.XRPL_RPC || '') : (process.env.XAHAU_RPC || '');
  const claim = process.env.DHALI_PAYMENT_CLAIM || '';
  const paid = !!claim && /^https:\/\/run\.api\.dhali\.io\//i.test(endpoint);
  const pause = paid ? 100 : 400;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const db = openCache(args.db);
  const own = new Set();
  for (const r of db.prepare('SELECT DISTINCT wallet FROM raw_transactions WHERE chain = ?').iterate(chain)) own.add(r.wallet);
  const wallets = prefixes.map((p) => {
    if (/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(p) && !own.has(p) && p.length >= 25) return p;   // a full address not in the cache
    const m = [...own].filter((w) => w.startsWith(p));
    if (m.length !== 1) { console.error(m.length ? `${p} matches ${m.length} wallets: ${m.join(', ')}` : `no cached ${chain} wallet starts with ${p} (give the full address)`); process.exit(2); }
    return m[0];
  });

  let holdings = new Map();
  try { holdings = readHoldings(holdingsFile); } catch (e) { console.error(`--holdings: ${e.message}`); process.exit(2); }
  const xrpUsd = holdings.get('__XRPUSD') || null;

  const call = async (method, params) => {
    await sleep(pause);
    const r = await ledger.call({ chain, method, params, endpoint, claim });
    return r;
  };

  const si = await call('server_info', {});
  const vl = si && si.info && si.info.validated_ledger;
  const reserveBase = vl ? num(vl.reserve_base_xrp) : 1;
  const reserveInc = vl ? num(vl.reserve_inc_xrp) : 0.2;

  console.log(`\nTrust lines — ${chain} · ${paid ? 'Dhali (paid)' : 'public node'} · reserve ${reserveBase} XRP + ${reserveInc} XRP per object`);
  if (claim && !paid) console.log('(DHALI_PAYMENT_CLAIM is set but the endpoint is public, so the claim is not sent.)');
  if (!holdingsFile) console.log('(No --holdings file: basis unknown, so "burn" advice says what it would cost if the token has basis.)');

  const csv = ['Wallet,Currency,Issuer,Balance,Counts Toward Reserve,Bid Book XRP,AMM Pool XRP,Est Proceeds XRP,Est Proceeds USD,Basis USD,Times Received,Last Received,Open Offers,Frozen By Issuer,Recommendation,Why'];
  const totals = { freed: 0, proceeds: 0, remove: 0 };

  for (const W of wallets) {
    const info = await call('account_info', { account: W, ledger_index: 'validated' });
    if (info.notFound) { console.log(`\n${W}: not found on ${chain} (deleted or never funded)`); continue; }
    if (info.error) { console.log(`\n${W}: ${info.error} ${info.error_message || ''}`); continue; }
    const bal = drops(info.account_data.Balance), owners = num(info.account_data.OwnerCount);

    // Lines (paged), plus the RippleState objects that say whose reserve each one uses, plus offers.
    const lines = [];
    for (let marker; ;) {
      const r = await call('account_lines', { account: W, ledger_index: 'validated', limit: 400, ...(marker ? { marker } : {}) });
      if (r.error) throw new Error(`account_lines: ${r.error}`);
      lines.push(...(r.lines || []));
      if (!r.marker) break; marker = r.marker;
    }
    const objs = [];
    for (let marker; ;) {
      const r = await call('account_objects', { account: W, ledger_index: 'validated', limit: 400, ...(marker ? { marker } : {}) });
      if (r.error) throw new Error(`account_objects: ${r.error}`);
      objs.push(...(r.account_objects || []));
      if (!r.marker) break; marker = r.marker;
    }
    const reserveOf = new Map();
    const offersOn = new Map();
    const objCounts = {};
    for (const o of objs) {
      objCounts[o.LedgerEntryType] = (objCounts[o.LedgerEntryType] || 0) + 1;
      if (o.LedgerEntryType === 'RippleState') {
        const weLow = o.LowLimit && o.LowLimit.issuer === W;
        const peer = weLow ? o.HighLimit.issuer : o.LowLimit.issuer;
        const ours = !!(num(o.Flags) & (weLow ? lsfLowReserve : lsfHighReserve));
        reserveOf.set(peer + '|' + o.Balance.currency, ours);
      } else if (o.LedgerEntryType === 'Offer') {
        for (const side of [o.TakerGets, o.TakerPays]) {
          if (side && typeof side === 'object') offersOn.set(side.issuer + '|' + side.currency, (offersOn.get(side.issuer + '|' + side.currency) || 0) + 1);
        }
      }
    }

    // How often each token arrived here, from the cache.
    const recv = new Map();
    for (const r of db.prepare('SELECT timestamp, raw_json FROM raw_transactions WHERE chain = ? AND wallet = ?').iterate(chain, W)) {
      let raw; try { raw = JSON.parse(r.raw_json); } catch (e) { continue; }
      if (raw.TransactionType !== 'Payment' || raw.Destination !== W) continue;
      if (raw.TransactionResult && raw.TransactionResult !== 'tesSUCCESS') continue;
      for (const leg of nonNativeLegs(raw)) {
        const k = leg.issuer + '|' + leg.currency;
        const s = recv.get(k) || { n: 0, last: null };
        s.n++; if (!s.last || r.timestamp > s.last) s.last = r.timestamp;
        recv.set(k, s);
      }
    }

    const spendable = bal - reserveBase - owners * reserveInc;
    console.log(`\n${W}`);
    console.log(`  ${bal.toFixed(6)} XRP · owner count ${owners} (${Object.entries(objCounts).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}) · locked ${(reserveBase + owners * reserveInc).toFixed(2)} XRP · spendable ${spendable.toFixed(6)} XRP`);
    console.log(`  ${lines.length} trust line(s)\n`);

    const rows = [];
    for (const ln of lines) {
      const cur = decodeCurrency(ln.currency), issuer = ln.account;
      const balance = num(ln.balance);
      const lp = LP_RE.test(ln.currency);
      const r = { cur, rawCur: ln.currency, issuer, balance: Math.abs(balance), lp,
                  issuedByYou: balance < 0, frozenByIssuer: !!ln.freeze_peer,
                  countsReserve: reserveOf.has(issuer + '|' + ln.currency) ? reserveOf.get(issuer + '|' + ln.currency) : num(ln.limit) !== 0,
                  openOffers: offersOn.get(issuer + '|' + ln.currency) || 0,
                  bookXrp: 0, ammXrp: 0, proceeds: 0, lpXrp: null };
      const rc = recv.get(issuer + '|' + cur);
      r.received = rc ? rc.n : 0;
      r.lastReceived = rc && rc.last ? String(rc.last).replace(' ', 'T') + 'Z' : null;
      // An exact match on code and issuer when the export has them; the
      // older by-name match (prorated) only for an export that predates that.
      const exact = holdings.get(W + '|' + cur.toUpperCase() + '.' + issuer);
      r.basisUsd = !holdingsFile ? null : exact ? basisFor(exact, r.balance)
        : holdings.get('__EXACT') ? 0 : basisFor(holdings.get(W + '|' + cur.toUpperCase()), r.balance);

      if (lp && chain === 'XRPL') {
        const a = await call('amm_info', { amm_account: issuer, ledger_index: 'validated' });
        const sh = a && a.amm ? lpShare(a.amm, r.balance) : null;
        if (sh) { r.lpXrp = sh.xrpValue; r.lpSides = sh.sides; r.proceeds = sh.xrpValue || 0; r.cur = 'LP ' + sh.sides.map((x) => decodeCurrency(x.currency)).join('/'); }
      } else if (r.balance > 0 && !r.issuedByYou) {
        const bk = await call('book_offers', { taker_gets: { currency: 'XRP' }, taker_pays: { currency: ln.currency, issuer }, limit: 50, ledger_index: 'validated' });
        r.bookXrp = bk && bk.offers ? sellIntoBook(bk.offers, r.balance).xrp : 0;
        if (chain === 'XRPL') {
          const a = await call('amm_info', { asset: { currency: 'XRP' }, asset2: { currency: ln.currency, issuer }, ledger_index: 'validated' });
          r.ammXrp = a && a.amm ? sellIntoAmm(a.amm, r.balance).xrp : 0;
        }
        r.proceeds = Math.max(r.bookXrp, r.ammXrp);
      }
      Object.assign(r, recommend(r, { keepXrp, reserveInc, minSell }));
      rows.push(r);
    }

    const order = ['KEEP — LP share', 'KEEP or SELL — your call', 'LEAVE', 'LEAVE — frozen', 'SELL then REMOVE', 'REMOVE (burn) — loss not deductible', 'REMOVE (burn)', 'REMOVE'];
    rows.sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action) || b.proceeds - a.proceeds || a.cur.localeCompare(b.cur));
    let freed = 0, proceeds = 0;
    for (const r of rows) {
      const removing = /REMOVE/.test(r.action);
      if (removing && r.countsReserve) freed += reserveInc;
      if (r.action === 'SELL then REMOVE') proceeds += r.proceeds;
      const usd = xrpUsd && r.proceeds ? `  ≈ $${(r.proceeds * xrpUsd).toFixed(2)}` : '';
      console.log(`  ${r.action.padEnd(36)} ${r.cur.slice(0, 12).padEnd(12)} ${String(+r.balance.toPrecision(10)).padStart(18)}  issuer ${issuerShort(r.issuer)}${r.proceeds ? `  ~${r.proceeds.toFixed(4)} XRP${usd}` : ''}`);
      console.log(`  ${''.padEnd(36)} ${r.why}`);
      csv.push([W, r.cur, r.issuer, r.balance, r.countsReserve ? 'yes' : 'no', r.bookXrp.toFixed(6), r.ammXrp.toFixed(6), r.proceeds.toFixed(6),
        xrpUsd ? (r.proceeds * xrpUsd).toFixed(2) : '', r.basisUsd == null ? '' : r.basisUsd.toFixed(2), r.received, r.lastReceived ? r.lastReceived.slice(0, 10) : '',
        r.openOffers, r.frozenByIssuer ? 'yes' : '', r.action, r.why].map(csvField).join(','));
    }
    const nRemove = rows.filter((r) => /REMOVE/.test(r.action)).length;
    console.log(`\n  Removing the ${nRemove} line(s) marked REMOVE frees ${freed.toFixed(2)} XRP of reserve` +
      (proceeds ? `, and selling the SELL ones first brings in ~${proceeds.toFixed(4)} XRP` : '') + '.');
    totals.freed += freed; totals.proceeds += proceeds; totals.remove += nRemove;
  }

  if (wallets.length > 1) console.log(`\nAll wallets: ${totals.remove} line(s) to remove, ${totals.freed.toFixed(2)} XRP of reserve freed, ~${totals.proceeds.toFixed(4)} XRP from sales first.`);
  const out = args.csv || `Trustlines-${new Date().toISOString().slice(0, 10)}.csv`;
  fs.writeFileSync(out, csv.join('\n') + '\n');
  console.log(`\nWrote ${out} (contains addresses — keep it out of git; Trustlines-*.csv is ignored).`);
  console.log('Order of work in Xaman: cancel any open offers named above → sell the SELL lines on the DEX → Token Trasher the REMOVE lines. Never trash an LP token.\n');
}

function issuerShort(a) { return a ? a.slice(0, 8) + '…' : ''; }
