// test/price-tables.test.js — the embedded daily prices are on the right day,
// and no single bad print is ever the price of a whole day again.
//
// Until v1.10.3 every key in XRP_PRICES, XAH_PRICES and EVR_PRICES was one day
// late (OHLC close-time read as open-time), and two days carried one thin-market
// print as their HIGH — 19.6x and 3.1x the surrounding days. Both errors are
// invisible in the app: the numbers look like prices. These assertions pin
// real-world events to the dates they happened on, so a re-import that brings
// the shift back fails here rather than on a tax return.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  dailyFromSamples, monthlyVolumes, readTable, writeTable, readVolumes, writeVolumes, mergeDays,
} = require('../scripts/update-prices.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const T = {
  XRP: readTable(html, 'XRP_PRICES'),
  XAH: readTable(html, 'XAH_PRICES'),
  EVR: readTable(html, 'EVR_PRICES'),
};

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); }
  catch (e) { failures++; console.log(`  FAIL - ${name}\n      ${e.message}`); }
}

// ── The embedded tables ─────────────────────────────────────────────────────

test('every entry is a real date with a finite high >= low > 0', () => {
  for (const [sym, t] of Object.entries(T)) {
    for (const [d, v] of Object.entries(t)) {
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)), `${sym} bad key ${d}`);
      assert.ok(Number.isFinite(v.high) && Number.isFinite(v.low) && v.low > 0 && v.high >= v.low,
        `${sym} ${d} ${JSON.stringify(v)}`);
    }
  }
});

test('alignment: XRP tariff-crash low is on 2025-04-07, not the 8th', () => {
  // CoinGecko hourly: 2025-04-07 low 1.6516; 2025-04-08 low 1.8007.
  assert.ok(T.XRP['2025-04-07'].low < 1.70, `04-07 low ${T.XRP['2025-04-07'].low}`);
  assert.ok(T.XRP['2025-04-08'].low > 1.70, `04-08 low ${T.XRP['2025-04-08'].low}`);
});

test('alignment: XRP August-2026 peak is on 2026-08-22, not the 23rd', () => {
  // CoinGecko hourly: 08-22 high 1.6626; 08-23 high 1.5257.
  assert.ok(T.XRP['2026-08-22'].high > 1.60, `08-22 high ${T.XRP['2026-08-22'].high}`);
  assert.ok(T.XRP['2026-08-23'].high < 1.60, `08-23 high ${T.XRP['2026-08-23'].high}`);
});

test('alignment: XAH 2024-08-05 crash and EVR 2024-03-05 high are on their own days', () => {
  // XAH hourly 2024-08-05 low 0.03764 (08-04 low 0.05315); EVR 2024-03-05 high 0.30207 (03-04: 0.28752).
  assert.ok(T.XAH['2024-08-05'].low < 0.045 && T.XAH['2024-08-04'].low > 0.05,
    `XAH 08-04 ${T.XAH['2024-08-04'].low} / 08-05 ${T.XAH['2024-08-05'].low}`);
  assert.ok(T.EVR['2024-03-05'].high > 0.295 && T.EVR['2024-03-04'].high < 0.295,
    `EVR 03-04 ${T.EVR['2024-03-04'].high} / 03-05 ${T.EVR['2024-03-05'].high}`);
});

test('no daily HIGH is more than 2.5x the median of the ten days around it', () => {
  // The tax math values at the daily high, so a spike here is a spike in
  // every proceeds, basis and income figure dated that day.
  const bad = [];
  for (const [sym, t] of Object.entries(T)) {
    const ks = Object.keys(t).sort();
    for (let i = 0; i < ks.length; i++) {
      const nb = [];
      for (let j = Math.max(0, i - 5); j <= Math.min(ks.length - 1, i + 5); j++) if (j !== i) nb.push(t[ks[j]].high);
      nb.sort((a, b) => a - b);
      const m = nb[Math.floor(nb.length / 2)];
      if (t[ks[i]].high > 2.5 * m) bad.push(`${sym} ${ks[i]} ${t[ks[i]].high} vs ~${m}`);
    }
  }
  assert.deepStrictEqual(bad, []);
});

test('the two known spikes stay fixed', () => {
  assert.ok(T.XAH['2026-07-27'].high < 0.02, `XAH 2026-07-27 ${T.XAH['2026-07-27'].high}`);
  assert.ok(T.EVR['2025-09-15'].high < 0.3, `EVR 2025-09-15 ${T.EVR['2025-09-15'].high}`);
});

test('the three series end on the same day (one updater, one run)', () => {
  const ends = Object.values(T).map((t) => Object.keys(t).sort().pop());
  assert.strictEqual(new Set(ends).size, 1, ends.join(' '));
});

// ── The updater's rules ─────────────────────────────────────────────────────

test('dailyFromSamples buckets by the UTC day of the sample', () => {
  const h = 3600000, d0 = Date.parse('2026-01-01T00:00:00Z');
  const out = dailyFromSamples([[d0 - h, 9], [d0, 2], [d0 + 23 * h, 3], [d0 + 24 * h, 7]]);
  assert.deepStrictEqual(Object.keys(out), ['2025-12-31', '2026-01-01', '2026-01-02']);
  assert.strictEqual(out['2026-01-01'].high, 3);
  assert.strictEqual(out['2026-01-01'].low, 2);
});

test('dailyFromSamples drops a lone print far from the day median', () => {
  const h = 3600000, d0 = Date.parse('2026-07-27T00:00:00Z');
  const s = [];
  for (let i = 0; i < 24; i++) s.push([d0 + i * h, 0.014 + i * 0.0001]);
  s.push([d0 + 12 * h + 60000, 0.27978]);
  const out = dailyFromSamples(s)['2026-07-27'];
  assert.strictEqual(out.dropped, 1);
  assert.ok(out.high < 0.02, String(out.high));
});

test('monthlyVolumes takes one point per UTC day and counts the days', () => {
  const d = (s) => Date.parse(s);
  const out = monthlyVolumes([[d('2026-09-01T00:00:00Z'), 10], [d('2026-09-01T00:30:00Z'), 99], [d('2026-09-02T00:00:00Z'), 5]]);
  assert.deepStrictEqual(out, { '2026-09': [15, 2] });
});

test('mergeDays never rewrites an existing day unless told to', () => {
  const t = { '2026-01-01': { high: 1, low: 1 } };
  const days = { '2026-01-01': { high: 5, low: 5 }, '2026-01-02': { high: 2, low: 2 } };
  const r = mergeDays(t, days);
  assert.strictEqual(r.table['2026-01-01'].high, 1);
  assert.deepStrictEqual(r.added, ['2026-01-02']);
  assert.strictEqual(mergeDays(t, days, { overwrite: true }).table['2026-01-01'].high, 5);
  assert.deepStrictEqual(mergeDays(t, days, { through: '2026-01-01' }).added, []);
});

test('writeTable/writeVolumes round-trip without touching anything else', () => {
  const x = writeVolumes(writeTable(html, 'XAH_PRICES', T.XAH), 'XAH', readVolumes(html, 'XAH'));
  assert.strictEqual(x.length, html.length);
  assert.deepStrictEqual(readTable(x, 'XAH_PRICES'), T.XAH);
});

if (failures) { console.log(`\n${failures} test(s) FAILED`); process.exit(1); }
console.log('\nAll price-table tests passed');
