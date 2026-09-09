// test/price-history.spec.js — the Price History page, which is now three
// per-asset sub-pages rather than one combined XRP+XAH table.
//
// Runs against the real Electron app so it exercises the actual embedded
// price series, not a fixture. That matters for one assertion in particular:
// the page tells the user, in a highlighted box, that trading volume is not
// shown "because it is not in the data". That is a factual claim about the
// dataset shipped inside the app, and it is the kind of claim that silently
// becomes a lie the day someone embeds a richer price series and forgets the
// note. The volume test below fails loudly on that day.
//
// Run headless-safe with: xvfb-run -a npx playwright test test/price-history.spec.js

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_DIR = path.join(__dirname, '..');

let app, window, userDataDir;

test.beforeAll(async () => {
  // Same isolation as e2e.spec.js: an isolated HOME *and* --user-data-dir.
  // HOME alone is not enough on Linux, where Electron prefers
  // XDG_CONFIG_HOME — which GitHub's runners set, and which is how five of
  // these tests once read a 126,886-row cache that was supposed to be empty.
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrp-xahau-prices-'));
  app = await electron.launch({
    args: [APP_DIR, '--user-data-dir=' + path.join(userDataDir, 'electron-profile')],
    cwd: APP_DIR,
    env: { ...process.env, HOME: userDataDir },
  });
  window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  // The app loads jsPDF from cdnjs, which a CI runner (or an offline machine)
  // may not reach — and a silently skipped PDF test is how an export stays
  // broken for months. Inject the same pinned build from node_modules when the
  // CDN copy did not arrive, so the export is exercised either way.
  const loaded = await window.evaluate(() => !!(window.jspdf && window.jspdf.jsPDF));
  if (!loaded) {
    const umd = path.join(APP_DIR, 'node_modules/jspdf/dist/jspdf.umd.min.js');
    if (fs.existsSync(umd)) {
      await window.evaluate((src) => { new Function(src)(); }, fs.readFileSync(umd, 'utf8'));
    }
  }
});

// The injected copy is only equivalent to the shipped one while the two
// versions agree. They are declared in different files, so nothing but this
// keeps them together.
test('the jsPDF version in the page matches the one the tests inject', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
  const declared = (pkg.devDependencies.jspdf || '').replace(/^[\^~]/, '');
  const html = fs.readFileSync(path.join(APP_DIR, 'renderer/index.html'), 'utf8');
  const cdn = html.match(/cdnjs\.cloudflare\.com\/ajax\/libs\/jspdf\/([\d.]+)\//);
  expect(cdn, 'no pinned jsPDF URL found in renderer/index.html').not.toBeNull();
  expect(cdn[1]).toBe(declared);
});

test.afterAll(async () => {
  if (app) await app.close();
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

// ── The claim on the page ───────────────────────────────────────────────────

test('the daily price series still carries only high and low', async () => {
  const shape = await window.evaluate(() => {
    // Referenced by name rather than off `window`: these are top-level
    // `const`s, which live in the global lexical scope and never become
    // window properties.
    const series = { XRP_PRICES, XAH_PRICES, EVR_PRICES };
    const out = {};
    for (const [key, data] of Object.entries(series)) {
      const fields = new Set();
      let days = 0;
      for (const dk of Object.keys(data)) {
        days++;
        for (const f of Object.keys(data[dk] || {})) fields.add(f);
      }
      out[key] = { days, fields: [...fields].sort() };
    }
    return out;
  });

  for (const key of ['XRP_PRICES', 'XAH_PRICES', 'EVR_PRICES']) {
    expect(shape[key].days, `${key} should carry data`).toBeGreaterThan(0);
    // Volume lives in MARKET_VOLUME_USD, monthly, deliberately not merged in
    // here — the tax math reads these records on the hot path and has no use
    // for a third field.
    expect(shape[key].fields, `${key} fields`).toEqual(['high', 'low']);
  }
});

// ── Market volume ───────────────────────────────────────────────────────────

test('every month with a price has a market-volume figure, except pre-reporting 2013', async () => {
  const cover = await window.evaluate(() => {
    const series = { XRP: XRP_PRICES, XAH: XAH_PRICES, EVR: EVR_PRICES };
    const out = {};
    for (const [sym, data] of Object.entries(series)) {
      const priceMonths = [...new Set(Object.keys(data).map((d) => d.slice(0, 7)))].sort();
      const volMonths = new Set(Object.keys(MARKET_VOLUME_USD[sym] || {}));
      out[sym] = {
        priceMonths: priceMonths.length,
        missing: priceMonths.filter((m) => !volMonths.has(m)),
        extra: [...volMonths].filter((m) => !priceMonths.includes(m)),
      };
    }
    return out;
  });

  // Volume reporting began 2013-12-27. Those four months are absent on
  // purpose: nothing was reported, which is not the same as nothing traded,
  // and the page must render that as an em-dash rather than as $0.
  expect(cover.XRP.missing).toEqual(['2013-08', '2013-09', '2013-10', '2013-11']);
  expect(cover.XAH.missing).toEqual([]);
  expect(cover.EVR.missing).toEqual([]);
  // Volume for a month with no price would have nowhere to appear.
  for (const sym of ['XRP', 'XAH', 'EVR']) expect(cover[sym].extra, sym).toEqual([]);
});

test('market volume is positive, plausible, and marks incomplete months', async () => {
  const facts = await window.evaluate(() => {
    const xrp = MARKET_VOLUME_USD.XRP;
    const bad = Object.entries(xrp).filter(([, v]) => !(v[0] > 0) || !(v[1] > 0 && v[1] <= 31));
    const year = (y) => Object.entries(xrp).filter(([m]) => m.startsWith(y))
      .reduce((s, [, v]) => s + v[0], 0);
    const newest = Object.keys(xrp).sort().pop();
    return {
      badRows: bad.map(([m]) => m),
      y2021: year('2021'),
      y2015: year('2015'),
      newest,
      newestPartial: marketVolume('XRP', newest).partial,
      // A complete past month must not be flagged.
      julyPartial: marketVolume('XRP', '2021-07').partial,
      missingMonth: marketVolume('XRP', '2013-09'),
    };
  });

  expect(facts.badRows).toEqual([]);
  // 2021 was a bull year and 2015 a quiet one; if these ever invert, the data
  // was transcribed wrong.
  expect(facts.y2021).toBeGreaterThan(facts.y2015 * 1000);
  expect(facts.y2021).toBeGreaterThan(1e12);   // trillions, not billions
  expect(facts.y2021).toBeLessThan(1e13);
  expect(facts.newestPartial).toBe(true);
  expect(facts.julyPartial).toBe(false);
  expect(facts.missingMonth).toBeNull();       // absent, not zero
});

test('a year total is the sum of its months, while its high is still the extreme', async () => {
  // The two aggregate in opposite ways and it is easy to apply one rule to
  // both. A summed high would be nonsense; a maxed volume would understate
  // the year twelvefold.
  const y = await window.evaluate(() => {
    const model = priceHistoryModel('XRP');
    const yr = model.years.find((v) => v.year === '2021');
    return {
      monthCount: yr.rows.length,
      sumOfMonths: yr.rows.reduce((s, r) => s + (r.mktUsd || 0), 0),
      summaryUsd: yr.summary.mktUsd,
      maxMonthUsd: Math.max(...yr.rows.map((r) => r.mktUsd)),
      summaryHigh: yr.summary.high,
      maxMonthHigh: Math.max(...yr.rows.map((r) => r.high)),
    };
  });

  expect(y.monthCount).toBe(12);
  expect(y.summaryUsd).toBeCloseTo(y.sumOfMonths, 0);
  expect(y.summaryUsd).toBeGreaterThan(y.maxMonthUsd);   // summed, not maxed
  expect(y.summaryHigh).toBe(y.maxMonthHigh);            // maxed, not summed
});

test('market volume in units is derived from dollars and the midpoint price', async () => {
  const r = await window.evaluate(() => {
    const model = priceHistoryModel('XRP');
    const row = model.years.find((v) => v.year === '2021').rows.find((x) => x.ym === '2021-04');
    return { ...row, expected: row.mktUsd / ((row.high + row.low) / 2) };
  });
  expect(r.mktUnits).toBeCloseTo(r.expected, 0);

  // And it degrades honestly rather than dividing by zero.
  const edge = await window.evaluate(() => [
    marketVolumeUnits(1000, { high: 2, low: 0 }),   // midpoint 1 → 1000
    marketVolumeUnits(1000, { high: 0, low: 0 }),   // no price → null
    marketVolumeUnits(0, { high: 2, low: 1 }),      // no volume → null
    marketVolumeUnits(1000, null),
  ]);
  expect(edge[0]).toBeCloseTo(1000, 6);
  expect(edge[1]).toBeNull();
  expect(edge[2]).toBeNull();
  expect(edge[3]).toBeNull();
});

test('the page shows the volume columns and the note no longer claims volume is absent', async () => {
  await window.evaluate(() => showPriceAsset('XRP'));
  const body = await window.locator('#priceHistoryBody').innerHTML();
  expect(body).toContain('Market Vol ($)');
  expect(body).toContain('Market Vol (XRP, est.)');

  const page = await window.locator('#page-prices').innerText();
  expect(page).not.toContain('not shown, because it is not in the data');
  expect(page).toContain('estimates');
});

// ── Your own volume ─────────────────────────────────────────────────────────

test('an internal shuffle is not volume, but an exchange deposit is', async () => {
  const verdicts = await window.evaluate(() => {
    // Two fetched wallets of your own, plus an exchange address marked "mine"
    // (owned, but never fetched — so it is the boundary, not inside it).
    const A = 'rEXAMPLEwalletAAAAAAAAAAAAAAAAAAAAA';
    const B = 'rEXAMPLEwalletBBBBBBBBBBBBBBBBBBBBB';
    const EX = 'rEXAMPLEexchangeMMMMMMMMMMMMMMMMMMM';
    const OUT = 'rEXAMPLEstrangerZZZZZZZZZZZZZZZZZZZ';

    const savedTransferOnly = transferOnlyAddresses.slice();
    transferOnlyAddresses.length = 0;
    transferOnlyAddresses.push(EX);
    try {
      return {
        ownToOwn:      isInternalShuffle(A, B, true, true),    // shuffle
        ownToExchange: isInternalShuffle(A, EX, true, true),   // real movement
        exchangeToOwn: isInternalShuffle(EX, A, true, true),
        ownToStranger: isInternalShuffle(A, OUT, true, false), // real movement
        strangerToOwn: isInternalShuffle(OUT, A, false, true),
      };
    } finally {
      transferOnlyAddresses.length = 0;
      transferOnlyAddresses.push(...savedTransferOnly);
    }
  });

  expect(verdicts.ownToOwn).toBe(true);
  expect(verdicts.ownToExchange).toBe(false);
  expect(verdicts.exchangeToOwn).toBe(false);
  expect(verdicts.ownToStranger).toBe(false);
  expect(verdicts.strangerToOwn).toBe(false);
});

test('your volume accumulates units exactly and dollars only when a price exists', async () => {
  const res = await window.evaluate(() => {
    const saved = JSON.parse(JSON.stringify(myVolumeByMonth));
    Object.keys(myVolumeByMonth).forEach((k) => delete myVolumeByMonth[k]);
    try {
      recordMyVolume('XRP', 100, '2025-03-04', 2);
      recordMyVolume('XRP', 50, '2025-03-20', 4);
      recordMyVolume('XRP', 25, '2025-03-25', 0);   // priced day missing
      recordMyVolume('XRP', 10, '2025-04-01', 3);
      recordMyVolume('XRP', 0, '2025-04-02', 3);    // zero qty ignored
      recordMyVolume('XRP', 5, null, 3);            // no date ignored
      const mar = myVolume('XRP', '2025-03');
      const apr = myVolume('XRP', '2025-04');
      return {
        marUnits: mar.units, marUsd: mar.usd, marCount: mar.count,
        aprUnits: apr.units, aprCount: apr.count,
        have: haveMyVolume('XRP'), haveXah: haveMyVolume('XAH'),
        emptyMonth: myVolume('XRP', '2025-05'),
      };
    } finally {
      Object.keys(myVolumeByMonth).forEach((k) => delete myVolumeByMonth[k]);
      Object.assign(myVolumeByMonth, saved);
    }
  });

  expect(res.marUnits).toBe(175);              // 100 + 50 + 25, all of it
  expect(res.marUsd).toBe(400);                // 100*2 + 50*4, NOT 25*0
  expect(res.marCount).toBe(3);
  expect(res.aprUnits).toBe(10);
  expect(res.aprCount).toBe(1);
  expect(res.have).toBe(true);
  expect(res.haveXah).toBe(false);
  expect(res.emptyMonth).toBeNull();
});

test('with no cached transactions the personal columns are hidden, not blank', async () => {
  // A fresh install showing four columns of em-dashes reads as a broken
  // feature rather than an empty one.
  const model = await window.evaluate(() => {
    const m = priceHistoryModel('XRP');
    return { showMine: m.showMine, anyMyUnits: m.years.some((y) => y.rows.some((r) => r.myUnits != null)) };
  });
  expect(model.showMine).toBe(false);
  expect(model.anyMyUnits).toBe(false);

  const body = await window.locator('#priceHistoryBody').innerHTML();
  expect(body).not.toContain('Your Vol');
});

// ── Formatting ──────────────────────────────────────────────────────────────

test('large figures are abbreviated so a column stays comparable', async () => {
  const f = await window.evaluate(() => [
    fmtBig(484276062982), fmtBig(2089900000000), fmtBig(5420057), fmtBig(458291), fmtBig(197),
    fmtBig(null), fmtBig(NaN),
    fmtUnits(1735312423), fmtUnits(212305), fmtUnits(1410), fmtUnits(12), fmtUnits(null),
  ]);
  expect(f[0]).toBe('$484.28bn');
  expect(f[1]).toBe('$2.09tn');
  expect(f[2]).toBe('$5.42m');
  expect(f[3]).toBe('$458.3k');
  expect(f[4]).toBe('$197');
  expect(f[5]).toBe('—');
  expect(f[6]).toBe('—');
  expect(f[7]).toBe('1.74bn');
  expect(f[8]).toBe('212.3k');
  expect(f[9]).toBe('1.4k');
  expect(f[10]).toBe('12');
  expect(f[11]).toBe('—');
});

// ── The PDF matches the page ────────────────────────────────────────────────

test('the PDF is built from the same model as the page, in landscape', async () => {
  const info = await window.evaluate(() => {
    if (!(window.jspdf && window.jspdf.jsPDF)) return { noLib: true };
    const doc = buildPriceHistoryPDF('XRP');
    if (!doc) return { noDoc: true };
    const w = doc.internal.pageSize.getWidth();
    const h = doc.internal.pageSize.getHeight();
    const text = doc.output('datauristring').length;
    return { landscape: w > h, width: Math.round(w), pages: doc.internal.getNumberOfPages(), size: text };
  });

  expect(info.noLib, 'jsPDF should have been injected from node_modules').toBeUndefined();
  expect(info.noDoc).toBeUndefined();
  // Nine columns of currency do not fit across letter-portrait's 540pt.
  expect(info.landscape).toBe(true);
  expect(info.width).toBe(792);
  expect(info.pages).toBeGreaterThan(1);
  expect(info.size).toBeGreaterThan(1000);
});

// ── Sub-tabs ────────────────────────────────────────────────────────────────

test('the page opens on XRP with that tab styled, not on an unstyled default', async () => {
  await window.evaluate(() => showTab('prices'));
  expect(await window.evaluate(() => priceAssetTab)).toBe('XRP');

  // The bug this guards: renderPriceHistory() at init drew the XRP table but
  // left every tab looking unselected.
  const styled = await window.evaluate(() => {
    const b = document.getElementById('ptab-XRP');
    return { weight: b.style.fontWeight, bg: b.style.background || b.style.backgroundColor };
  });
  expect(styled.weight).toBe('700');
  expect(styled.bg).not.toBe('');

  const body = await window.locator('#priceHistoryBody').innerHTML();
  expect(body).toContain('XRP —');
  expect(body).not.toContain('XAH —');
});

test('switching to XAH swaps both the table and the tab styling', async () => {
  await window.evaluate(() => showPriceAsset('XAH'));
  expect(await window.evaluate(() => priceAssetTab)).toBe('XAH');

  const tabs = await window.evaluate(() => ({
    xrp: document.getElementById('ptab-XRP').style.fontWeight,
    xah: document.getElementById('ptab-XAH').style.fontWeight,
  }));
  expect(tabs.xah).toBe('700');
  expect(tabs.xrp).toBe(''); // deselected again, not left bold

  const body = await window.locator('#priceHistoryBody').innerHTML();
  expect(body).toContain('XAH —');
  expect(body).not.toContain('XRP —');

  // XAH's ledger went live in November 2023, so nothing earlier can appear.
  expect(body).not.toContain('2022');
  expect(body).toContain('2023');

  await window.evaluate(() => showPriceAsset('XRP')); // leave the page as found
});

test('EVR is a real series of its own, not XAH re-labelled', async () => {
  const same = await window.evaluate(() => {
    const xah = XAH_PRICES, evr = EVR_PRICES;
    const shared = Object.keys(evr).filter(d => xah[d]);
    if (shared.length === 0) return null;
    return shared.every(d => evr[d].high === xah[d].high && evr[d].low === xah[d].low);
  });
  // A stale comment in the renderer claimed EVR had no market of its own and
  // was priced at XAH-at-receipt. The data disagrees, which is why EVR gets a
  // tab. If this ever comes back true, drop the tab rather than mislead.
  expect(same).toBe(false);
});

// ── The arithmetic ──────────────────────────────────────────────────────────

test('spread is high − low, and the percentage is that over the low', async () => {
  const cases = await window.evaluate(() => [
    withSpread({ low: 2, high: 3 }),
    withSpread({ low: 0.5, high: 0.5 }),   // a flat month: zero spread, not null
    withSpread({ low: 0, high: 1 }),       // no percentage is definable against zero
    withSpread(null),
    withSpread({ low: Infinity, high: -Infinity }), // an empty monthlyAgg bucket
  ]);

  expect(cases[0].spread).toBeCloseTo(1, 10);
  expect(cases[0].spreadPct).toBeCloseTo(50, 10);
  expect(cases[1].spread).toBe(0);
  expect(cases[1].spreadPct).toBe(0);
  expect(cases[2].spreadPct).toBeNull();
  expect(cases[3]).toBeNull();
  expect(cases[4]).toBeNull();
});

test('the year row is the extreme of its months, never a sum or an average', async () => {
  // The single easiest way to get this wrong is to total the monthly columns,
  // which for a high/low series is meaningless — and would show XRP peaking
  // somewhere around $30 in 2021.
  const check = await window.evaluate(() => {
    const months = monthlyAgg(XRP_PRICES);
    const ym2021 = Object.keys(months).filter(k => k.startsWith('2021-'));
    const highs = ym2021.map(k => months[k].high);
    const lows = ym2021.map(k => months[k].low);
    return {
      count: ym2021.length,
      yearHigh: Math.max(...highs),
      yearLow: Math.min(...lows),
      sumOfHighs: highs.reduce((s, h) => s + h, 0),
      maxMonthHigh: Math.max(...highs),
      minMonthLow: Math.min(...lows),
    };
  });

  expect(check.count).toBe(12);
  expect(check.yearHigh).toBe(check.maxMonthHigh);
  expect(check.yearLow).toBe(check.minMonthLow);
  expect(check.yearHigh).toBeLessThan(check.sumOfHighs); // i.e. it is not a total

  // Sanity against the real world: XRP's 2021 peak was a little under $2.
  expect(check.yearHigh).toBeGreaterThan(1);
  expect(check.yearHigh).toBeLessThan(5);
});

test('a rendered year carries its months plus exactly one full-year row', async () => {
  const rendered = await window.evaluate(() => {
    showPriceAsset('XRP');
    const html = document.getElementById('priceHistoryBody').innerHTML;
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const table = [...tmp.querySelectorAll('table')]
      .find(t => t.textContent.includes('XRP — 2021'));
    if (!table) return null;
    const bodyRows = [...table.querySelectorAll('tbody tr')];
    const last = bodyRows[bodyRows.length - 1];
    return {
      rows: bodyRows.length,
      cells: bodyRows[0].querySelectorAll('td').length,
      summaryLabel: last.querySelector('td').textContent.trim(),
      summaries: bodyRows.filter(r => /full year/.test(r.textContent)).length,
    };
  });

  expect(rendered).not.toBeNull();
  expect(rendered.rows).toBe(13);            // 12 months + 1 summary
  // Month | Low | High | Spread $ | Spread % | Market Vol $ | Market Vol units.
  // Nine once there are cached transactions to fill the two personal columns.
  expect(rendered.cells).toBe(7);
  expect(rendered.summaryLabel).toBe('2021 full year');
  expect(rendered.summaries).toBe(1);
});

test('XAH and EVR are shown to more decimal places than XRP', async () => {
  // They trade in fractions of a cent; four decimals rounds a real spread to
  // $0.0000 and reads as "no movement".
  // Only the three price columns (Low, High, Spread $) — indexes 1..3. The
  // volume columns are abbreviated ("$484.28bn") and one carries a partial-
  // period dagger, so scraping every $-cell measures the wrong thing.
  const decimals = async (asset) => window.evaluate((a) => {
    showPriceAsset(a);
    const out = [];
    for (const tr of document.querySelectorAll('#priceHistoryBody tbody tr')) {
      const tds = tr.querySelectorAll('td');
      for (const i of [1, 2, 3]) {
        const t = (tds[i] ? tds[i].textContent : '').trim();
        if (t.startsWith('$')) out.push((t.split('.')[1] || '').length);
      }
    }
    return out;
  }, asset);

  const xrp = await decimals('XRP');
  const xah = await decimals('XAH');
  expect(Math.max(...xrp)).toBe(4);
  expect(Math.max(...xah)).toBe(6);

  await window.evaluate(() => showPriceAsset('XRP'));
});

// ── The end-to-end path the user actually walks ─────────────────────────────
//
// Everything above tests recordMyVolume() and the model in isolation. This
// test does the whole journey instead: cache some transactions, build the
// report the way the app builds it, then look at the rendered page. That is
// the only way to catch a break BETWEEN those pieces rather than inside one.

test('a real build from cache fills the personal columns and the page shows them', async () => {
  const { _electron: electronRunner } = require('@playwright/test');
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'xrp-xahau-myvol-'));
  const app2 = await electronRunner.launch({
    args: [APP_DIR, '--user-data-dir=' + path.join(home2, 'electron-profile')],
    cwd: APP_DIR,
    env: { ...process.env, HOME: home2 },
  });
  try {
    const w = await app2.firstWindow();
    await w.waitForLoadState('domcontentloaded');

    const r = await w.evaluate(async () => {
      const mine = 'wMyVolumeWalletOne';
      const other = 'wMyVolumeWalletTwo';
      const stranger = 'rStrangerVolumeCounterpartyXX';
      WALLETS.length = 0; WALLETS.push(mine, other);
      await window.taxDB.clearWalletChain(mine, 'XRPL');
      await window.taxDB.clearWalletChain(other, 'XRPL');

      const pay = (h, ts, from, to, amt) => ({
        tx_hash: h, timestamp: ts, raw_json: JSON.stringify({
          Account: from, Destination: to, TransactionType: 'Payment',
          TransactionResult: 'tesSUCCESS', Timestamp: ts, TransactionHash: h,
          delivered_amount_XRP: String(amt), Amount_XRP: String(amt),
          Amount_value: '', Amount_currency: '' }) });

      await window.taxDB.insertRows(mine, 'XRPL', [
        pay('IN1',  '2025-03-05 10:00:00', stranger, mine, 5000),   // inbound  → counts
        pay('OUT1', '2025-03-20 10:00:00', mine, stranger, 1500),   // outbound → counts
        pay('SHUF', '2025-03-25 10:00:00', mine, other, 900),       // internal → must NOT count
      ]);
      await window.taxDB.insertRows(other, 'XRPL', [
        pay('SHUF', '2025-03-25 10:00:00', mine, other, 900),       // same tx, other side
      ]);
      await window.taxDB.upsertSyncState(mine, 'XRPL', '2025-12-31 00:00:00');
      await window.taxDB.upsertSyncState(other, 'XRPL', '2025-12-31 00:00:00');

      transferOnlyAddresses.length = 0;
      giftAddresses.length = 0;
      await buildReportFromCache({ silent: true });

      const mar = myVolume('XRP', '2025-03');
      const model = priceHistoryModel('XRP');
      const row = model.years.find(y => y.year === '2025').rows.find(x => x.ym === '2025-03');

      showPriceAsset('XRP');
      const html = document.getElementById('priceHistoryBody').innerHTML;

      return {
        units: mar ? mar.units : null,
        usd: mar ? mar.usd : null,
        count: mar ? mar.count : null,
        showMine: model.showMine,
        rowUnits: row.myUnits,
        headerHasYourVol: html.includes('Your Vol'),
      };
    });

    // 5000 in + 1500 out = 6500. The 900 internal shuffle is excluded, and
    // excluded ONCE — it is cached twice, once per wallet's perspective, so a
    // naive count would have produced 8300 and a half-fixed one 7400.
    expect(r.count).toBe(2);
    expect(r.units).toBeCloseTo(6500, 6);
    expect(r.usd).toBeGreaterThan(0);

    // And it has to survive the trip through the model to the page.
    expect(r.showMine).toBe(true);
    expect(r.rowUnits).toBeCloseTo(6500, 6);
    expect(r.headerHasYourVol).toBe(true);
  } finally {
    await app2.close();
    fs.rmSync(home2, { recursive: true, force: true });
  }
});

test('the header shows the version from package.json, not a hard-coded string', async () => {
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
  await window.evaluate(() => setAppVersion());
  await window.waitForFunction(() => {
    const el = document.getElementById('hdrVersion');
    return el && el.textContent.trim().length > 0;
  }, null, { timeout: 5000 });
  const shown = (await window.locator('#hdrVersion').innerText()).trim();
  expect(shown).toBe('v' + pkgVersion);

  // The number must not also be written into the HTML anywhere, or the two
  // copies will disagree at the first release someone forgets.
  const html = fs.readFileSync(path.join(APP_DIR, 'renderer/index.html'), 'utf8');
  expect(html).not.toContain('v' + pkgVersion);
});

test('a completed build repaints Price History even while you are looking at it', async () => {
  // The bug: the page renders once at startup, the silent rebuild then runs
  // for minutes on a large cache, and nothing told the page its numbers had
  // arrived. Sitting on the tab, you saw market volume for ever and concluded
  // the personal columns did not work. Switching tabs away and back fixed it,
  // which is exactly what made it look like a feature failure rather than a
  // stale view.
  const { _electron: electronRunner } = require('@playwright/test');
  const home3 = fs.mkdtempSync(path.join(os.tmpdir(), 'xrp-xahau-repaint-'));
  const app3 = await electronRunner.launch({
    args: [APP_DIR, '--user-data-dir=' + path.join(home3, 'electron-profile')],
    cwd: APP_DIR,
    env: { ...process.env, HOME: home3 },
  });
  try {
    const w = await app3.firstWindow();
    await w.waitForLoadState('domcontentloaded');

    const r = await w.evaluate(async () => {
      const mine = 'wRepaintWalletOne';
      WALLETS.length = 0; WALLETS.push(mine);
      await window.taxDB.clearWalletChain(mine, 'XRPL');
      const pay = (h, ts, from, to, amt) => ({
        tx_hash: h, timestamp: ts, raw_json: JSON.stringify({
          Account: from, Destination: to, TransactionType: 'Payment',
          TransactionResult: 'tesSUCCESS', Timestamp: ts, TransactionHash: h,
          delivered_amount_XRP: String(amt), Amount_XRP: String(amt),
          Amount_value: '', Amount_currency: '' }) });
      await window.taxDB.insertRows(mine, 'XRPL', [
        pay('R1', '2025-06-10 10:00:00', 'rRepaintStrangerAddressXYZ', mine, 2500),
      ]);
      await window.taxDB.upsertSyncState(mine, 'XRPL', '2025-12-31 00:00:00');

      // Land on Price History and stay there — no tab switching allowed.
      showTab('prices');
      const before = document.getElementById('priceHistoryBody').innerHTML;

      transferOnlyAddresses.length = 0;
      giftAddresses.length = 0;
      await buildReportFromCache({ silent: true });

      const after = document.getElementById('priceHistoryBody').innerHTML;
      return {
        beforeHasYourVol: before.includes('Your Vol'),
        afterHasYourVol: after.includes('Your Vol'),
      };
    });

    expect(r.beforeHasYourVol).toBe(false);  // nothing built yet
    expect(r.afterHasYourVol).toBe(true);    // and it repainted itself
  } finally {
    await app3.close();
    fs.rmSync(home3, { recursive: true, force: true });
  }
});

test('a build that stops mid-way repaints and says so, instead of claiming it is still building', async () => {
  // The failure this locks down: the repaint used to sit at the end of the
  // inner build function, so an exception skipped it. The page kept its
  // "Building your own volume from the cache now" line for ever, the startup
  // call had no .catch so nothing was logged, and the result was a feature
  // that looked broken with no error anywhere to explain it.
  const { _electron: electronRunner } = require('@playwright/test');
  const home4 = fs.mkdtempSync(path.join(os.tmpdir(), 'xrp-xahau-buildfail-'));
  const app4 = await electronRunner.launch({
    args: [APP_DIR, '--user-data-dir=' + path.join(home4, 'electron-profile')],
    cwd: APP_DIR,
    env: { ...process.env, HOME: home4 },
  });
  try {
    const w = await app4.firstWindow();
    await w.waitForLoadState('domcontentloaded');

    const r = await w.evaluate(async () => {
      const mine = 'wBuildFailWalletOne';
      WALLETS.length = 0; WALLETS.push(mine);
      await window.taxDB.clearWalletChain(mine, 'XRPL');
      await window.taxDB.insertRows(mine, 'XRPL', [{
        tx_hash: 'F1', timestamp: '2025-06-10 10:00:00', raw_json: JSON.stringify({
          Account: 'rBuildFailStrangerAddressAB', Destination: mine, TransactionType: 'Payment',
          TransactionResult: 'tesSUCCESS', Timestamp: '2025-06-10 10:00:00', TransactionHash: 'F1',
          delivered_amount_XRP: '1000', Amount_XRP: '1000', Amount_value: '', Amount_currency: '' }) }]);
      await window.taxDB.upsertSyncState(mine, 'XRPL', '2025-12-31 00:00:00');

      showTab('prices');

      // Break the build the way a real failure would: something it depends on
      // throws part-way through.
      //
      // Stubbing window.taxDB does NOT work — contextBridge exposes a frozen
      // object, so the assignment silently does nothing and the build then
      // succeeds, which is exactly how this test first passed for the wrong
      // reason. streamChainIntoLedger is a plain declaration in renderer
      // scope, and failing there is also the realistic case: it is the long
      // pass over millions of rows, and it fails BEFORE any volume has
      // accumulated, so the page is left in the state the user reported.
      const realStream = streamChainIntoLedger;
      // eslint-disable-next-line no-func-assign
      streamChainIntoLedger = async () => { throw new Error('simulated cache read failure'); };

      let threw = false;
      try { await buildReportFromCache({ silent: true }); }
      catch (e) { threw = true; }

      // eslint-disable-next-line no-func-assign
      streamChainIntoLedger = realStream;

      const html = document.getElementById('priceHistoryBody').innerHTML;
      return {
        threw,
        stillClaimsBuilding: html.includes('will fill in when it finishes'),
        reportsFailure: html.includes('stopped before it finished'),
        inFlightCleared: _ledgerBuildInFlight === null,
      };
    });

    expect(r.threw).toBe(true);
    expect(r.inFlightCleared).toBe(true);
    // The two that matter: it must NOT still be promising to fill in...
    expect(r.stillClaimsBuilding).toBe(false);
    // ...and it must say what actually happened.
    expect(r.reportsFailure).toBe(true);
  } finally {
    await app4.close();
    fs.rmSync(home4, { recursive: true, force: true });
  }
});
