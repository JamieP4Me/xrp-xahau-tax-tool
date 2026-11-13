// test/saved-report.spec.js — build once, load after (1.10.9).
//
// The report is saved after each consistent build, one copy per AMM
// treatment, and loaded instead of rebuilt while its fingerprint matches.
// What must hold:
//   - a saved report comes back identical (lots, disposals, income, the
//     booking journal with its Maps);
//   - ANY change to the data or to a setting that decides the numbers makes
//     it refuse to load (stale is worse than slow);
//   - switching Standard <-> Treatment A loads the saved report and does not
//     rebuild;
//   - long work shows in the progress strip, and an export clicked during a
//     rebuild waits and then runs by itself.
//
// Never put a real address in a test.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_DIR = path.join(__dirname, '..');
const W = 'rTESTsavedReport111111111111111111';
const OTHER = 'rTESTsavedOther11111111111111111111';

let app, window, userDataDir;

test.beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrp-xahau-saved-'));
  app = await electron.launch({
    args: [APP_DIR, '--user-data-dir=' + path.join(userDataDir, 'electron-profile')],
    cwd: APP_DIR,
    env: { ...process.env, HOME: userDataDir },
  });
  window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.waitForFunction(() => typeof _ledgerBuildInFlight !== 'undefined' && _ledgerBuildInFlight === null && !_ledgerLockHeld,
    null, { timeout: 30000 });
});

test.afterAll(async () => {
  if (app) await app.close();
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

// Books: 100 EVR received, 40 sold, plus a journal entry.
async function bookFixture(extraSale) {
  return window.evaluate(({ W, OTHER, extraSale }) => {
    resetLedgerState();
    if (!WALLETS.includes(W)) WALLETS.push(W);
    journalAll = true; journalConfigChanged();
    const ws = new Set([W]);
    const xh = makeXahauPriceHelpers();
    const pay = (hash, ts, from, to, val) => ({ TransactionType: 'Payment', TransactionResult: 'tesSUCCESS', Account: from,
      Destination: to, Timestamp: ts, TransactionHash: hash, Amount_XRP: '', delivered_amount_XRP: '',
      Amount_value: val, Amount_currency: 'EVR', delivered_amount_value: val, delivered_amount_currency: 'EVR' });
    processOneXahauRow(pay('S1', '2025-01-02 00:00:00', OTHER, W, '100'), W, ws, 'in', xh);
    processOneXahauRow(pay('S2', '2025-03-02 00:00:00', W, OTHER, '40'), W, ws, 'out', xh);
    if (extraSale) processOneXahauRow(pay('S3', '2025-04-02 00:00:00', W, OTHER, '10'), W, ws, 'out', xh);
    journalAll = false; journalConfigChanged();
    rowsStreamedThisBuild = extraSale ? 3 : 2;
    applyReportingYear(2025);
    return { disposals: allDisposalsHigh.length };
  }, { W, OTHER, extraSale: !!extraSale });
}

test('lots pack into typed columns and unpack identically', async () => {
  const out = await window.evaluate(() => {
    const wl = { rA: { XRP: [{ date: '2024-01-01', qty: 5, unitCost: 0.5, remaining: 2, source: 'received' },
                             { date: null, qty: 1.25, unitCost: 0, remaining: 1.25, source: 'transfer_in' }] },
                 rB: { EVR: [{ date: '2025-02-03', qty: 3, unitCost: 0.2, remaining: 0, source: 'reward' }] } };
    const p = packWalletLedger(wl);
    return { same: JSON.stringify(unpackWalletLedger(p)) === JSON.stringify(wl), typed: p.lots[0][2] instanceof Float64Array };
  });
  expect(out.same).toBe(true);
  expect(out.typed).toBe(true);
});

test('a saved report loads back identical, journal Maps and all', async () => {
  await bookFixture(false);
  const out = await window.evaluate(async () => {
    const before = { d: JSON.stringify(allDisposalsHigh), i: JSON.stringify(allIncomeRows), l: JSON.stringify(walletLedger),
                     j: bookingJournal.size, rows: rowsStreamedThisBuild };
    const saved = await withLedgerLock('test save', () => saveCurrentReport());
    resetLedgerState();
    const emptied = allDisposalsHigh.length + Object.keys(walletLedger).length;
    const loaded = await withLedgerLock('test load', () => loadSavedReport(ammTreatment));
    const firstMap = [...bookingJournal.values()][0];
    return { saved, emptied, loaded,
      same: JSON.stringify(allDisposalsHigh) === before.d && JSON.stringify(allIncomeRows) === before.i && JSON.stringify(walletLedger) === before.l,
      journalIsMap: firstMap instanceof Map, journalSize: bookingJournal.size === before.j, rows: rowsStreamedThisBuild === before.rows,
      info: (await window.taxDB.reportInfo()).map((r) => r.key) };
  });
  expect(out.saved).toBe(true);
  expect(out.emptied).toBe(0);
  expect(out.loaded).toBe(true);
  expect(out.same).toBe(true);
  expect(out.journalIsMap).toBe(true);
  expect(out.journalSize).toBe(true);
  expect(out.rows).toBe(true);
  expect(out.info).toContain('report:none');
});

test('new data, a reclassified wallet, or a changed basis input makes the saved report refuse to load', async () => {
  const out = await window.evaluate(async ({ W, OTHER }) => {
    const load = () => withLedgerLock('test load', () => loadSavedReport(ammTreatment));
    const save = () => withLedgerLock('test save', () => saveCurrentReport());
    const results = {};
    results.baseline = await load();
    // 1. new cached rows bump the data version
    await window.taxDB.insertRows(W, 'Xahau', [{ tx_hash: 'NEWROW1', timestamp: '2025-05-01 00:00:00', raw_json: '{}' }]);
    results.afterNewData = await load();
    await save();
    results.resaved = await load();
    // 2. re-inserting the identical row changes nothing, so it still loads
    await window.taxDB.insertRows(W, 'Xahau', [{ tx_hash: 'NEWROW1', timestamp: '2025-05-01 00:00:00', raw_json: '{}' }]);
    results.sameRowAgain = await load();
    // 3. a wallet becomes "lost"
    lostWallets.push({ addr: OTHER, lostDate: '2025-01-01', note: 't' });
    results.afterReclassify = await load();
    lostWallets.pop();
    results.afterUndo = await load();
    // 4. the XRP basis input changes
    const el = document.getElementById('xrpBasis');
    const was = el.value; el.value = '0.99';
    results.afterBasis = await load();
    el.value = was;
    results.afterBasisUndo = await load();
    return results;
  }, { W, OTHER });
  expect(out.baseline).toBe(true);
  expect(out.afterNewData).toBe(false);
  expect(out.resaved).toBe(true);
  expect(out.sameRowAgain).toBe(true);
  expect(out.afterReclassify).toBe(false);
  expect(out.afterUndo).toBe(true);
  expect(out.afterBasis).toBe(false);
  expect(out.afterBasisUndo).toBe(true);
});

test('switching to Treatment A and back loads the saved reports and never rebuilds', async () => {
  // Two saved reports that differ, so a load can be told from a rebuild.
  await bookFixture(false);
  await window.evaluate(() => withLedgerLock('t', async () => { ammTreatment = 'none'; await saveCurrentReport(); }));
  await bookFixture(true);
  await window.evaluate(() => withLedgerLock('t', async () => { ammTreatment = 'A'; await saveCurrentReport(); ammTreatment = 'none'; }));
  await bookFixture(false);
  const out = await window.evaluate(async () => {
    const realBuild = _runLedgerBuild;
    let builds = 0;
    // eslint-disable-next-line no-func-assign
    _runLedgerBuild = async () => { builds++; return realBuild({ silent: true }); };
    const realConfirm = window.confirm;
    window.confirm = () => true;
    try {
      await setAmmTreatmentUI('A');
      const onA = { t: ammTreatment, disposals: allDisposalsHigh.length };
      await setAmmTreatmentUI('none');
      const onNone = { t: ammTreatment, disposals: allDisposalsHigh.length };
      return { builds, onA, onNone };
    } finally {
      // eslint-disable-next-line no-func-assign
      _runLedgerBuild = realBuild;
      window.confirm = realConfirm;
    }
  });
  expect(out.builds).toBe(0);
  expect(out.onA.t).toBe('A');
  expect(out.onNone.t).toBe('none');
  expect(out.onA.disposals).toBeGreaterThan(out.onNone.disposals);   // the A copy had the extra sale
});

test('the progress strip shows what is running, how far, and clears when done', async () => {
  const out = await window.evaluate(async () => {
    progressSet('build', 'Building the standard report: Xahau rows', 250, 1000);
    const box = document.getElementById('appProgress');
    const shown = { visible: box.style.display !== 'none', text: box.innerText };
    progressSet('compare', 'Standard vs Treatment A comparison: building');
    const both = box.querySelectorAll('.ap-row').length;
    progressDone('build'); progressDone('compare');
    return { shown, both, hidden: box.style.display === 'none' };
  });
  expect(out.shown.visible).toBe(true);
  expect(out.shown.text).toContain('Xahau rows');
  expect(out.shown.text).toContain('25%');
  expect(out.both).toBe(2);
  expect(out.hidden).toBe(true);
});

test('an export clicked during a rebuild waits, says so, and then runs by itself', async () => {
  const out = await window.evaluate(async () => {
    const realDownload = downloadCSV, realAlert = window.alert;
    let downloaded = null, alerted = false;
    downloadCSV = (lines, name) => { downloaded = name; };
    window.alert = () => { alerted = true; };
    let release;
    const held = withLedgerLock('test rebuild', () => new Promise((r) => { release = r; }));
    try {
      exportHoldingsCSV();
      const waitingText = document.getElementById('appProgress').innerText;
      const beforeRelease = downloaded;
      release();
      await held;
      await new Promise((r) => setTimeout(r, 50));
      return { alerted, waitingText, beforeRelease, after: downloaded };
    } finally {
      downloadCSV = realDownload; window.alert = realAlert;
    }
  });
  expect(out.alerted).toBe(false);
  expect(out.waitingText).toContain('Waiting to download when this finishes: Holdings CSV');
  expect(out.beforeRelease).toBeNull();
  expect(out.after).toMatch(/^Holdings-By-Wallet-/);
});
