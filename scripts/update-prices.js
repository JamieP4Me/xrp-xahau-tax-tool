#!/usr/bin/env node
/**
 * update-prices — extend the embedded daily price tables (XRP, XAH, EVR) and
 * the monthly market-volume table in renderer/index.html.
 *
 * WHY THIS EXISTS. The tables were built once, by hand, and then went stale:
 * they stopped at 2026-09-03 while 2026 was a selectable tax year, so every
 * later transaction was priced at 3 September by lookupPrice()'s nearest-date
 * fallback. They were also a day late throughout (see the comment above
 * EVR_PRICES in the renderer). Nothing in the repo could regenerate them. This
 * does, with the alignment and spike rules written down where they can be
 * tested instead of remembered.
 *
 * THE RULES
 *   - A day is a UTC calendar day: the same day toDK() gives a transaction.
 *   - A day's high/low are the extremes of CoinGecko's HOURLY samples whose
 *     timestamps fall inside that day. Never OHLC candles: their timestamp is
 *     the candle's close, which is exactly how the old tables ended up a day
 *     late.
 *   - Samples more than 2x, or under half, the day's median are dropped
 *     before taking the extremes. The tax math values at the daily HIGH, so a
 *     single bad print otherwise becomes the price of every transaction that
 *     day (XAH 2026-07-27 was 19.6x).
 *   - Only COMPLETE days are added: the default end is yesterday, UTC.
 *   - Existing days are never rewritten unless --overwrite is passed.
 *   - Volume months touched are recomputed whole, from CoinGecko's daily
 *     total_volumes points labelled by their own UTC date — the convention
 *     the existing MARKET_VOLUME_USD figures were built with (re-derived Nov
 *     2026: June-August matched to the dollar).
 *
 * USAGE
 *   npm run prices:update                    # fetch and write
 *   npm run prices:update -- --dry-run       # show what would change
 *   node scripts/update-prices.js --through 2026-12-31
 *   node scripts/update-prices.js --from-json prices.json   # offline input
 *
 * The public CoinGecko API needs no key but is rate-limited and serves about
 * the last 365 days. A free "demo" key raises the limit; it is read from the
 * environment only:   export COINGECKO_DEMO_KEY='...'
 *
 * This changes renderer/index.html. Review `git diff --stat`, run the tests,
 * and commit the result like any other change. It does not touch the cache.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, '..', 'renderer', 'index.html');
const COINS = { XRP: 'ripple', XAH: 'xahau', EVR: 'evernode' };
const DAY = 86400000;

// ── Pure helpers (exported for test/price-tables.test.js) ──────────────────

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const sig = (x) => +x.toPrecision(7);

function median(sorted) {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/** [[ms, price], ...] → { 'YYYY-MM-DD': { high, low, dropped } } */
function dailyFromSamples(samples) {
  const byDay = new Map();
  for (const [ms, p] of samples) {
    if (!Number.isFinite(p) || p <= 0) continue;
    const d = utcDay(ms);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(p);
  }
  const out = {};
  for (const [d, ps] of [...byDay].sort()) {
    const s = ps.slice().sort((a, b) => a - b);
    const m = median(s);
    const kept = s.filter((x) => x <= 2 * m && x >= m / 2);
    out[d] = { high: sig(kept[kept.length - 1]), low: sig(kept[0]), dropped: s.length - kept.length };
  }
  return out;
}

/** [[ms, usd], ...] daily points → { 'YYYY-MM': [totalUsd, daysObserved] } */
function monthlyVolumes(points) {
  const seen = new Map();
  for (const [ms, v] of points) {
    if (!Number.isFinite(v)) continue;
    const d = utcDay(ms);
    if (!seen.has(d)) seen.set(d, v);      // first point of a day wins
  }
  const out = {};
  for (const [d, v] of seen) {
    const ym = d.slice(0, 7);
    const e = out[ym] || (out[ym] = [0, 0]);
    e[0] += v; e[1]++;
  }
  for (const k of Object.keys(out)) out[k][0] = Math.round(out[k][0]);
  return out;
}

function tableRe(name) { return new RegExp(`^const ${name} = (\\{.*\\});$`, 'm'); }

function readTable(html, name) {
  const m = html.match(tableRe(name));
  if (!m) throw new Error(`${name} not found as a one-line table`);
  return JSON.parse(m[1]);
}

function writeTable(html, name, obj) {
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = { high: obj[k].high, low: obj[k].low };
  return html.replace(tableRe(name), () => `const ${name} = ${JSON.stringify(sorted)};`);
}

function volRe(sym) { return new RegExp(`^(  ${sym}: )(\\{.*\\})(,?)$`, 'm'); }

function readVolumes(html, sym) {
  const m = html.match(volRe(sym));
  if (!m) throw new Error(`MARKET_VOLUME_USD.${sym} not found`);
  return JSON.parse(m[2]);
}

function writeVolumes(html, sym, obj) {
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return html.replace(volRe(sym), (_, a, _b, c) => a + JSON.stringify(sorted) + c);
}

/** Merge new days into a table. Returns { table, added, skipped }. */
function mergeDays(table, days, { overwrite = false, through } = {}) {
  const t = { ...table };
  const added = [], skipped = [];
  for (const d of Object.keys(days).sort()) {
    if (through && d > through) { skipped.push(d); continue; }
    if (t[d] && !overwrite) { skipped.push(d); continue; }
    t[d] = { high: days[d].high, low: days[d].low };
    added.push(d);
  }
  return { table: t, added, skipped };
}

// ── Network ───────────────────────────────────────────────────────────────

async function cg(id, fromMs, toMs) {
  const u = `https://api.coingecko.com/api/v3/coins/${id}/market_chart/range` +
    `?vs_currency=usd&from=${Math.floor(fromMs / 1000)}&to=${Math.floor(toMs / 1000)}`;
  const headers = { accept: 'application/json' };
  if (process.env.COINGECKO_DEMO_KEY) headers['x-cg-demo-api-key'] = process.env.COINGECKO_DEMO_KEY;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(u, { headers });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 15000 * (attempt + 1))); continue; }
    if (!res.ok) throw new Error(`CoinGecko ${id}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
  throw new Error(`CoinGecko ${id}: still rate-limited after 5 attempts`);
}

async function fetchSymbol(sym, startDay, throughDay) {
  const id = COINS[sym];
  const prices = [];
  // Hourly granularity is only served for ranges of 90 days or less.
  let a = Date.parse(startDay + 'T00:00:00Z');
  const end = Date.parse(throughDay + 'T00:00:00Z') + DAY - 1000;
  while (a <= end) {
    const b = Math.min(a + 85 * DAY - 1000, end);
    const r = await cg(id, a, b);
    prices.push(...(r.prices || []));
    a = b + 1000;
    await new Promise((r) => setTimeout(r, 2500));
  }
  // Daily volume points need a range LONGER than 90 days.
  const vFrom = Date.parse(startDay.slice(0, 7) + '-01T00:00:00Z');
  const v = await cg(id, Math.min(vFrom, end - 100 * DAY), end);
  const firstMonth = startDay.slice(0, 7);
  const vols = monthlyVolumes(v.total_volumes || []);
  for (const k of Object.keys(vols)) if (k < firstMonth) delete vols[k];
  const days = dailyFromSamples(prices);
  return { days, vols };
}

// ── CLI ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = { dryRun: false, overwrite: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dry-run') a.dryRun = true;
    else if (k === '--overwrite') a.overwrite = true;
    else if (k === '--through') a.through = argv[++i];
    else if (k === '--from-json') a.fromJson = argv[++i];
    else if (k === '--html') a.html = argv[++i];
    else if (k === '--help' || k === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); }
    else { console.error(`unknown argument: ${k}`); process.exit(2); }
  }
  if (a.through && !/^\d{4}-\d{2}-\d{2}$/.test(a.through)) { console.error('--through must be YYYY-MM-DD'); process.exit(2); }
  return a;
}

async function main() {
  const args = parseArgs(process.argv);
  const file = args.html || HTML;
  let html = fs.readFileSync(file, 'utf8');
  const yesterday = utcDay(Date.now() - DAY);
  const through = args.through && args.through < yesterday ? args.through : yesterday;
  const offline = args.fromJson ? JSON.parse(fs.readFileSync(args.fromJson, 'utf8')) : null;

  for (const sym of Object.keys(COINS)) {
    const name = `${sym}_PRICES`;
    const table = readTable(html, name);
    const last = Object.keys(table).sort().pop();
    const start = args.overwrite && args.through ? last : utcDay(Date.parse(last + 'T00:00:00Z') + DAY);
    let days, vols;
    if (offline) {
      days = {};
      for (const [d, v] of Object.entries((offline.prices || {})[sym] || {})) {
        days[d] = Array.isArray(v) ? { high: v[0], low: v[1], dropped: 0 } : v;
      }
      vols = (offline.vols || {})[sym] || {};
    } else {
      if (start > through) { console.log(`${sym}: up to date (last ${last})`); continue; }
      console.log(`${sym}: fetching ${start} .. ${through}`);
      ({ days, vols } = await fetchSymbol(sym, start, through));
    }
    const { table: t2, added } = mergeDays(table, days, { overwrite: args.overwrite, through });
    const cleaned = added.filter((d) => days[d].dropped > 0);
    console.log(`${sym}: last ${last} -> ${added.length ? added[added.length - 1] : last}, +${added.length} day(s)` +
      (cleaned.length ? `; spike samples dropped on ${cleaned.join(', ')}` : ''));
    html = writeTable(html, name, t2);

    const vt = readVolumes(html, sym);
    const changed = [];
    for (const [ym, v] of Object.entries(vols)) {
      if (ym > through.slice(0, 7)) continue;
      if (!vt[ym] || vt[ym][0] !== v[0] || vt[ym][1] !== v[1]) { vt[ym] = v; changed.push(`${ym}(${v[1]}d)`); }
    }
    if (changed.length) console.log(`${sym}: volume months updated ${changed.join(' ')}`);
    html = writeVolumes(html, sym, vt);
  }

  if (args.dryRun) { console.log('\n--dry-run: nothing written.'); return; }
  fs.writeFileSync(file, html);
  console.log(`\nwrote ${path.relative(process.cwd(), file)} — review with git diff --stat, then npm run test:db`);
}

module.exports = { dailyFromSamples, monthlyVolumes, readTable, writeTable, readVolumes, writeVolumes, mergeDays, utcDay };

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
