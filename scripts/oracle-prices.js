#!/usr/bin/env node
/**
 * oracle-prices — hourly USD prices for Xahau tokens, read from an on-ledger
 * price oracle's own history.
 *
 * WHY. XXX, RVN and the other onexah tokens have no CoinGecko listing, so the
 * app has no price for them at all, and xahau:basis could only value a reward
 * at "the XAH rate you paid on your nearest purchase". That is a reasonable
 * stand-in when the purchase is days away and a poor one when it is months
 * away: RVN was bought at ~24 XAH in August, and the oracle quotes it near 3
 * XAH in November. Rewards are income at fair market value WHEN RECEIVED. An
 * oracle that published a price every few minutes is the closest thing to
 * that number this project can get.
 *
 * WHERE. xahauwin.com lists the XLS-47 oracles on Xahau. The onexah feed
 * (document 1) carries XAH, EVR, XRP, XXX, RVN and others against USD. Every
 * update is an OracleSet transaction from the provider's account, so the full
 * history is that account's transaction list: no indexer, no API key, no
 * Payment-Claim. This script walks it newest-first and stops at --since.
 *
 * The provider address is a required argument rather than a default: the
 * repo's verify-clean gate refuses r-addresses in source, and a public oracle
 * is no exception worth carving out. Copy it from xahauwin.com/oracles.
 *
 * OUTPUT. One CSV row per pair per UTC hour: open/high/low/close and the
 * number of updates. Public market data, no wallet addresses; still
 * gitignored because it is regenerated, not authored.
 *
 *   npm run oracle:prices -- --provider r... --since 2026-06-01
 *   node scripts/oracle-prices.js --provider r... --doc 1 --out Oracle-Prices-2026.csv
 *   node scripts/oracle-prices.js ... --endpoint https://xahau.network/
 *
 * Then:  npm run xahau:basis -- --oracle Oracle-Prices-2026-06-01.csv
 *
 * WHAT IT CANNOT KNOW. Whether the oracle's prices are good. It is one
 * provider's feed, sourced however that provider sources it. xahau:basis
 * prints the oracle beside your own purchase rates so a disagreement shows.
 */
'use strict';

const fs = require('fs');

const RIPPLE_EPOCH = 946684800;
const HOUR = 3600000;

function decodeCurrency(raw) {
  const c = String(raw || '').trim();
  if (!/^[0-9A-Fa-f]{40}$/.test(c)) return c.toUpperCase();
  let out = '';
  for (let i = 0; i < 40; i += 2) {
    const b = parseInt(c.slice(i, i + 2), 16);
    if (b === 0) continue;
    if (b < 0x20 || b > 0x7e) return c.toUpperCase();
    out += String.fromCharCode(b);
  }
  return out.trim() || c.toUpperCase();
}

/** AssetPrice is a UInt64: hex string in JSON, sometimes a number. */
function priceOf(pd) {
  if (pd.AssetPrice == null) return null;
  let n;
  if (typeof pd.AssetPrice === 'number') n = pd.AssetPrice;
  else if (/^[0-9A-Fa-f]+$/.test(String(pd.AssetPrice))) n = Number(BigInt('0x' + pd.AssetPrice));
  else n = Number(pd.AssetPrice);
  const scale = Number(pd.Scale || 0);
  const p = n / Math.pow(10, scale);
  return Number.isFinite(p) && p > 0 ? p : null;
}

/** One account_tx entry → [{ ms, pair, price }] (empty if not a usable OracleSet). */
function pointsFromEntry(entry, docId) {
  const tx = entry.tx || entry.tx_json || {};
  const meta = entry.meta || {};
  if (tx.TransactionType !== 'OracleSet') return [];
  if (meta.TransactionResult && meta.TransactionResult !== 'tesSUCCESS') return [];
  if (docId != null && Number(tx.OracleDocumentID) !== Number(docId)) return [];
  // LastUpdateTime is the provider's own Unix timestamp for the prices; the
  // ledger close time is when they landed. Prefer the former.
  let ms = null;
  if (Number.isFinite(Number(tx.LastUpdateTime)) && Number(tx.LastUpdateTime) > 0) ms = Number(tx.LastUpdateTime) * 1000;
  else if (Number.isFinite(Number(tx.date))) ms = (Number(tx.date) + RIPPLE_EPOCH) * 1000;
  else if (entry.close_time_iso) ms = Date.parse(entry.close_time_iso);
  if (!ms) return [];
  const out = [];
  for (const item of tx.PriceDataSeries || []) {
    const pd = item.PriceData || item;
    const price = priceOf(pd);
    if (price == null) continue;     // an entry with no price deletes the pair
    out.push({ ms, pair: decodeCurrency(pd.BaseAsset) + '/' + decodeCurrency(pd.QuoteAsset), price });
  }
  return out;
}

/** points → Map('pair|hourMs' → {open,high,low,close,n,first,last}) */
function hourly(points) {
  const m = new Map();
  for (const p of points) {
    const h = Math.floor(p.ms / HOUR) * HOUR;
    const k = p.pair + '|' + h;
    let e = m.get(k);
    if (!e) { e = { pair: p.pair, hour: h, open: p.price, high: p.price, low: p.price, close: p.price, n: 0, first: p.ms, last: p.ms }; m.set(k, e); }
    if (p.ms < e.first) { e.first = p.ms; e.open = p.price; }
    if (p.ms >= e.last) { e.last = p.ms; e.close = p.price; }
    e.high = Math.max(e.high, p.price); e.low = Math.min(e.low, p.price); e.n++;
  }
  return m;
}

function toCsv(map) {
  const rows = [...map.values()].sort((a, b) => a.hour - b.hour || a.pair.localeCompare(b.pair));
  const lines = ['Hour (UTC),Pair,Open,High,Low,Close,Updates'];
  for (const e of rows) {
    lines.push([new Date(e.hour).toISOString().slice(0, 13) + ':00', e.pair, e.open, e.high, e.low, e.close, e.n].join(','));
  }
  return lines.join('\n') + '\n';
}

// ── CLI ───────────────────────────────────────────────────────────────────

function parseCli(argv) {
  const a = { doc: 1, since: '2026-01-01', endpoint: process.env.XAHAU_RPC || 'https://xahau.network/', provider: process.env.ORACLE_PROVIDER };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--provider') a.provider = argv[++i];
    else if (k === '--doc') a.doc = Number(argv[++i]);
    else if (k === '--since') a.since = argv[++i];
    else if (k === '--endpoint') a.endpoint = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--help' || k === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); }
    else { console.error('unknown argument: ' + k); process.exit(2); }
  }
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a.provider || '')) {
    console.error('--provider <r-address> is required: the oracle owner account, from xahauwin.com/oracles');
    process.exit(2);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.since)) { console.error('--since must be YYYY-MM-DD'); process.exit(2); }
  a.out = a.out || `Oracle-Prices-${a.since}.csv`;
  return a;
}

async function rpc(endpoint, method, params) {
  for (let attempt = 0; attempt < 8; attempt++) {
    let res, body;
    try {
      res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params: [params] }) });
      body = await res.json();
    } catch (e) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    const r = body && body.result;
    if (r && r.status === 'success') return r;
    const err = r && (r.error || r.error_message);
    if (['tooBusy', 'slowDown', 'noNetwork', 'noCurrent'].includes(err) || res.status === 429 || res.status >= 500) {
      await new Promise((r2) => setTimeout(r2, 3000 * (attempt + 1)));
      continue;
    }
    throw new Error(`${method}: ${err || 'HTTP ' + res.status}`);
  }
  throw new Error(`${method}: gave up after retries`);
}

async function main() {
  const a = parseCli(process.argv);
  const sinceMs = Date.parse(a.since + 'T00:00:00Z');
  const info = await rpc(a.endpoint, 'server_info', {});
  console.log(`endpoint ${a.endpoint}  ledgers ${info.info && info.info.complete_ledgers}`);
  console.log(`provider ${a.provider.slice(0, 8)}…  document ${a.doc}  since ${a.since}\n`);

  const points = [];
  const types = {};
  let marker, pages = 0, txs = 0, oldest = Infinity, done = false, reachedSince = false;
  const t0 = Date.now();
  while (!done) {
    const r = await rpc(a.endpoint, 'account_tx', {
      account: a.provider, ledger_index_min: -1, ledger_index_max: -1, limit: 200, forward: false, ...(marker ? { marker } : {}),
    });
    pages++;
    for (const e of r.transactions || []) {
      txs++;
      const tx = e.tx || e.tx_json || {};
      types[tx.TransactionType] = (types[tx.TransactionType] || 0) + 1;
      const closeMs = Number.isFinite(Number(tx.date)) ? (Number(tx.date) + RIPPLE_EPOCH) * 1000 : (e.close_time_iso ? Date.parse(e.close_time_iso) : null);
      if (closeMs && closeMs < sinceMs) { done = reachedSince = true; break; }
      if (closeMs) oldest = Math.min(oldest, closeMs);
      for (const p of pointsFromEntry(e, a.doc)) if (p.ms >= sinceMs) points.push(p);
    }
    marker = r.marker;
    if (!marker) done = true;
    if (pages % 10 === 0 || done) {
      const reached = Number.isFinite(oldest) ? new Date(oldest).toISOString().slice(0, 16) : '-';
      process.stdout.write(`  page ${pages}: ${txs} tx, ${points.length} prices, back to ${reached}  (${Math.round((Date.now() - t0) / 1000)}s)\n`);
    }
    await new Promise((r2) => setTimeout(r2, 250));
  }

  const h = hourly(points);
  fs.writeFileSync(a.out, toCsv(h));
  const pairs = {};
  for (const p of points) {
    const e = pairs[p.pair] || (pairs[p.pair] = { n: 0, first: Infinity, last: 0, lastPrice: 0 });
    e.n++; e.first = Math.min(e.first, p.ms);
    if (p.ms >= e.last) { e.last = p.ms; e.lastPrice = p.price; }
  }
  console.log('\ntransaction types seen:', Object.entries(types).map(([k, v]) => `${k} ${v}`).join(', '));
  console.log('\npair            updates  first             last              latest');
  for (const [k, e] of Object.entries(pairs).sort()) {
    console.log(`${k.padEnd(14)} ${String(e.n).padStart(8)}  ${new Date(e.first).toISOString().slice(0, 16)}  ${new Date(e.last).toISOString().slice(0, 16)}  ${e.lastPrice}`);
  }
  if (!points.length) {
    console.log('\nNo OracleSet prices found. Check --provider and --doc against xahauwin.com/oracles,');
    console.log('and whether this endpoint holds history back to --since (see "ledgers" above).');
    process.exit(1);
  }
  if (!reachedSince) console.log(`\nNOTE: the account's history ended at ${Number.isFinite(oldest) ? new Date(oldest).toISOString().slice(0, 10) : '?'}, after --since.\n      Either the oracle started then, or this node does not hold older ledgers.`);
  console.log(`\nwritten: ${a.out}  (${h.size} pair-hours)`);
}

module.exports = { decodeCurrency, priceOf, pointsFromEntry, hourly, toCsv };

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
