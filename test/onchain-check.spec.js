// test/onchain-check.spec.js — the on-chain balance check and "Explain".
//
// A fake ledger stands in for the node (chainRpcCall is swapped out), with
// balances and transaction metadata built so the right answer is known in
// advance:
//
//   wallet A (XRPL) received 1,000 XRP (H1), placed an offer (H3, fee only),
//   and had 300 XRP taken by someone else's transaction crossing that offer
//   (H2, never downloaded). The app also booked 7 XRP from a row with no
//   ledger hash (H5), and 50 XRP that arrived after the comparison point
//   (H4). So: app 1,057 held, 1,007 at the comparison point; ledger 699.99999;
//   difference 307.00001 = 300 (affected) + 7 (booked, not on ledger) +
//   0.00001 (fee).
//
//   wallet B (Xahau) received 10 EVR as a reward and holds 5 XAH the app never
//   saw: EVR agrees, XAH differs by a few cents (a "minor" difference).
//
// Never put a real address in a test.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_DIR = path.join(__dirname, '..');
const A = 'rTESTonchainA11111111111111111111';
const B = 'rTESTonchainB11111111111111111111';
const OTHER = 'rTESTonchainOther111111111111111';
const ISSUER = 'rTESTonchainIssuer11111111111111';
const H = (c) => c.repeat(64);

let app, window, userDataDir;

test.beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrp-xahau-onchain-'));
  app = await electron.launch({
    args: [APP_DIR, '--user-data-dir=' + path.join(userDataDir, 'electron-profile')],
    cwd: APP_DIR,
    env: { ...process.env, HOME: userDataDir },
  });
  window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.waitForFunction(() => typeof _ledgerBuildInFlight !== 'undefined' && _ledgerBuildInFlight === null,
    null, { timeout: 30000 });
});

test.afterAll(async () => {
  if (app) await app.close();
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

// ── Pure pieces ────────────────────────────────────────────────────────────

test('ledger deltas: native from AccountRoot, issued currency from RippleState with the high-side flip', async () => {
  const out = await window.evaluate(({ A, ISSUER }) => {
    const meta = { AffectedNodes: [
      { ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: A, Balance: '699999990' }, PreviousFields: { Balance: '999999990' } } },
      { ModifiedNode: { LedgerEntryType: 'RippleState',
          FinalFields: { Balance: { currency: 'EVR', value: '-12.5' }, HighLimit: { issuer: A }, LowLimit: { issuer: ISSUER } },
          PreviousFields: { Balance: { currency: 'EVR', value: '-10' } } } },
    ] };
    const created = { AffectedNodes: [{ CreatedNode: { LedgerEntryType: 'AccountRoot', NewFields: { Account: A, Balance: '25000000' } } }] };
    return {
      native: onchainNativeDelta(meta, A), iou: onchainIouDeltas(meta, A),
      created: onchainNativeDelta(created, A), untouched: onchainNativeDelta(meta, ISSUER),
    };
  }, { A, ISSUER });
  expect(out.native).toBeCloseTo(-300, 9);
  // The balance is stored from the LOW side (the issuer); A is HIGH, so -10 → -12.5 is +2.5 to A.
  expect(out.iou).toEqual([{ currency: 'EVR', issuer: ISSUER, delta: 2.5 }]);
  expect(out.created).toBe(25);
  expect(out.untouched).toBeNull();
});

test('transaction ids normalise to one key whatever form they arrive in', async () => {
  const out = await window.evaluate(({ h }) => {
    const doubled = [...h].map((c) => c.charCodeAt(0).toString(16)).join('');
    const ctid = 'C0A1B2C3D4E55359';
    const ctidDoubled = [...ctid].map((c) => c.charCodeAt(0).toString(16)).join('');
    return {
      plain: txKeyNormalize(h.toLowerCase()), doubled: txKeyNormalize(doubled),
      ctid: txKeyNormalize(ctid.toLowerCase()), ctidDoubled: txKeyNormalize(ctidDoubled),
      synthetic: txKeyNormalize('20240115112942000000000_rABC'),
      affected: cacheTxKey('AFFECTED:' + h + ':EVR'), affectedCtid: cacheTxKey('AFFECTED:' + ctid + ':native'),
      computed: onchainCtid(0x0A1B2C3, 0xD4E5, 21337),
    };
  }, { h: H('A') });
  expect(out.plain).toBe(H('A'));
  expect(out.doubled).toBe(H('A'));
  expect(out.ctid).toBe('CTID:C0A1B2C3D4E55359');
  expect(out.ctidDoubled).toBe('CTID:C0A1B2C3D4E55359');
  expect(out.synthetic.startsWith('ID:')).toBe(true);
  expect(out.affected).toBe(H('A'));
  expect(out.affectedCtid).toBe('CTID:C0A1B2C3D4E55359');
  expect(out.computed).toBe('C0A1B2C3D4E55359');
});

test('classification separates fees, shortfalls, DEX terms, dust and unbooked types', async () => {
  const out = await window.evaluate(() => ({
    feeOnly: explainClassify({ ledger: -10.00001, fee: 0.00001, app: -10, short: 0, inCache: true, type: 'Payment', ticker: 'XRP' }),
    shortfall: explainClassify({ ledger: -100.00001, fee: 0.00001, app: -40, short: 60, inCache: true, type: 'Payment', ticker: 'XRP' }),
    dex: explainClassify({ ledger: -0.00001, fee: 0.00001, app: -500, short: 0, inCache: true, type: 'OfferCreate', ticker: 'XRP' }),
    dust: explainClassify({ ledger: 0.5, fee: 0, app: 0, short: 0, inCache: true, type: 'Payment', ticker: 'XRP' }),
    unbooked: explainClassify({ ledger: 25, fee: 0, app: 0, short: 0, inCache: true, type: 'AMMWithdraw', ticker: 'XRP' }),
    missing: explainClassify({ ledger: 25, fee: 0, app: 0, short: 0, inCache: false, type: 'Payment', ticker: 'XRP' }),
    match: explainClassify({ ledger: 12, fee: 0, app: 12, short: 0, inCache: true, type: 'Payment', ticker: 'XRP' }),
  }));
  expect(out.feeOnly).toMatchObject({ match: false, category: null, diff: 0 });
  expect(out.feeOnly.fee).toBeCloseTo(0.00001, 9);
  expect(out.shortfall.category).toBe('shortfall');
  expect(out.shortfall.diff).toBeCloseTo(60, 6);
  expect(out.dex.category).toBe('dex_terms');
  expect(out.dex.diff).toBeCloseTo(-500, 6);
  expect(out.dust.category).toBe('dust');
  expect(out.unbooked.category).toBe('type_not_booked');
  expect(out.missing.category).toBeNull();     // caller names it: own vs affected
  expect(out.match.match).toBe(true);
});

// ── The booking journal ────────────────────────────────────────────────────

test('the journal adds up to the holdings, records shortfalls, and survives a snapshot', async () => {
  const out = await window.evaluate(({ A, B, OTHER }) => {
    resetLedgerState();
    journalAll = true; journalConfigChanged();
    const ws = new Set([A, B]);
    const xh = makeXahauPriceHelpers();
    const pay = (hash, ts, from, to, val, cur, xah) => ({ TransactionType: 'Payment', TransactionResult: 'tesSUCCESS', Account: from,
      Destination: to, Timestamp: ts, TransactionHash: hash, Amount_XRP: xah, delivered_amount_XRP: xah,
      Amount_value: val, Amount_currency: cur, delivered_amount_value: val, delivered_amount_currency: cur });
    processOneXahauRow(pay('J1', '2025-01-01 00:00:00', OTHER, A, '10', 'EVR', ''), A, ws, 'in', xh);
    processOneXahauRow(pay('J2', '2025-02-01 00:00:00', A, B, '4', 'EVR', ''), A, ws, 'out', xh);      // internal
    processOneXahauRow(pay('J3', '2025-03-01 00:00:00', B, OTHER, '9', 'EVR', ''), B, ws, 'out', xh);  // 5 short
    const sums = {};
    for (const [jk, m] of bookingJournal) {
      let eff = 0, short = 0;
      for (const e of m.values()) { eff += e.add - e.used; short += e.short; }
      sums[jk] = { eff, short, n: m.size };
    }
    const held = (w) => ((walletLedger[w] || {}).EVR || []).reduce((s, l) => s + l.remaining, 0);
    const snap = snapshotLedgerState();
    resetLedgerState();
    const afterReset = bookingJournal.size;
    restoreLedgerState(snap);
    journalAll = false; journalConfigChanged();
    return { sums, heldA: held(A), heldB: held(B), afterReset, restored: bookingJournal.size };
  }, { A, B, OTHER });
  expect(out.sums[`${A}|EVR`].eff).toBeCloseTo(out.heldA, 9);
  expect(out.sums[`${B}|EVR`].eff).toBeCloseTo(out.heldB, 9);
  expect(out.heldA).toBeCloseTo(6, 9);
  expect(out.heldB).toBeCloseTo(0, 9);
  expect(out.sums[`${B}|EVR`].short).toBeCloseTo(5, 9);
  expect(out.afterReset).toBe(0);
  expect(out.restored).toBe(2);
});

test('only bookings after the cutoff, or for a named wallet, are journaled', async () => {
  const out = await window.evaluate(({ A, B, OTHER }) => {
    resetLedgerState();
    journalWallets.clear(); journalAll = false;
    journalCutoffMs.Xahau = Date.parse('2025-06-01T00:00:00Z'); journalCutoffMs.XRPL = Infinity;
    journalConfigChanged();
    const ws = new Set([A, B]);
    const xh = makeXahauPriceHelpers();
    const pay = (hash, ts, to) => ({ TransactionType: 'Payment', TransactionResult: 'tesSUCCESS', Account: OTHER, Destination: to,
      Timestamp: ts, TransactionHash: hash, Amount_XRP: '', delivered_amount_XRP: '', Amount_value: '3', Amount_currency: 'EVR',
      delivered_amount_value: '3', delivered_amount_currency: 'EVR' });
    processOneXahauRow(pay('G1', '2025-01-01 00:00:00', A), A, ws, 'in', xh);   // before, not named: skipped
    processOneXahauRow(pay('G2', '2025-07-01 00:00:00', A), A, ws, 'in', xh);   // after: kept
    journalWallets.add(B); journalConfigChanged();
    processOneXahauRow(pay('G3', '2025-01-01 00:00:00', B), B, ws, 'in', xh);   // named: kept
    const n = (w) => (bookingJournal.get(w + '|EVR') || new Map()).size;
    const r = { a: n(A), b: n(B) };
    journalWallets.clear(); journalCutoffMs.Xahau = Infinity; journalConfigChanged();
    return r;
  }, { A, B, OTHER });
  expect(out).toEqual({ a: 1, b: 1 });
});

test('the Payment-Claim goes along only when the server is Dhali', async () => {
  const out = await window.evaluate(async () => {
    const saved = chainRpcCall;
    const seen = [];
    chainRpcCall = async (req) => { seen.push(req); return { ledger_index: 1 }; };
    const input = document.getElementById('paymentClaim');
    const before = input.value;
    input.value = 'TEST-CLAIM';
    await onchainRpc('XRPL', 'ledger', {});
    saveOnchainSettings({ xrplEndpoint: 'https://run.api.dhali.io/00000000-0000-0000-0000-000000000000/' });
    await onchainRpc('XRPL', 'ledger', {});
    await onchainRpc('Xahau', 'ledger', {});
    saveOnchainSettings({ xrplEndpoint: '' });
    input.value = before;
    chainRpcCall = saved;
    return seen.map((r) => ({ chain: r.chain, claim: r.claim || null, endpoint: r.endpoint }));
  });
  expect(out[0].claim).toBeNull();
  expect(out[1].claim).toBe('TEST-CLAIM');
  expect(out[2].claim).toBeNull();
});

// ── End to end, against a fake ledger ──────────────────────────────────────

async function setUpScenario(fullJournalFor) {
  return window.evaluate(async ({ A, B, OTHER, ISSUER, h1, h2, h3, h4, full }) => {
    const T0 = Date.parse('2026-01-01T00:00:00Z');
    const closeMs = (i) => T0 + i * 4000;
    const iso = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
    const rippleSec = (ms) => Math.round(ms / 1000) - 946684800;
    // Wallets the app fetches, and when they were synced.
    for (const w of [A, B]) if (!WALLETS.includes(w)) WALLETS.push(w);
    await window.taxDB.upsertSyncState(A, 'XRPL', '2026-01-01 01:00:00');
    await window.taxDB.upsertSyncState(B, 'Xahau', '2026-01-01 01:00:00');
    await window.taxDB.setMeta('onchainFetchStartV1', new Date(closeMs(500) + 10 * 60 * 1000 + 1000).toISOString());
    await window.taxDB.setMeta('onchainCheckV1', '');
    await window.taxDB.setMeta('onchainPinLedgerV1', '{}');
    _onchainResult = null; _onchainExplain = null;

    // The app's books.
    resetLedgerState();
    journalAll = false; journalWallets.clear();
    if (full) journalWallets.add(full);
    await prepareBookingJournal();
    const ws = new Set([A, B]);
    const xr = makeXrplPriceHelpers(), xh = makeXahauPriceHelpers();
    const xrp = (hash, ms, qty) => ({ TransactionType: 'Payment', TransactionResult: 'tesSUCCESS', Account: OTHER, Destination: A,
      Timestamp: iso(ms), TransactionHash: hash, Amount_XRP: String(qty), delivered_amount_XRP: String(qty) });
    processOneXRPLRow(xrp(h1, closeMs(100), 1000), A, ws, 'in', xr);
    processOneXRPLRow(xrp('', closeMs(200), 7), A, ws, 'in', xr);          // H5: no ledger hash
    processOneXRPLRow(xrp(h4, closeMs(900), 50), A, ws, 'in', xr);         // after the comparison point
    processOneXahauRow({ TransactionType: 'Payment', TransactionResult: 'tesSUCCESS', Account: OTHER, Destination: B,
      Timestamp: iso(closeMs(100)), TransactionHash: h1, Amount_XRP: '', delivered_amount_XRP: '', Amount_value: '10',
      Amount_currency: 'EVR', delivered_amount_value: '10', delivered_amount_currency: 'EVR' }, B, ws, 'in', xh);

    // The ledger.
    const node = (acct, prev, fin) => ({ ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: acct, Balance: fin }, PreviousFields: { Balance: prev } } });
    const txs = [
      { ledger_index: 100, tx: { hash: h1, TransactionType: 'Payment', Account: OTHER, Destination: A, Fee: '12', date: rippleSec(closeMs(100)) },
        meta: { TransactionResult: 'tesSUCCESS', TransactionIndex: 0, AffectedNodes: [{ CreatedNode: { LedgerEntryType: 'AccountRoot', NewFields: { Account: A, Balance: '1000000000' } } }] } },
      { ledger_index: 110, tx: { hash: h3, TransactionType: 'OfferCreate', Account: A, Fee: '10', date: rippleSec(closeMs(110)) },
        meta: { TransactionResult: 'tesSUCCESS', TransactionIndex: 0, AffectedNodes: [node(A, '1000000000', '999999990')] } },
      { ledger_index: 120, tx: { hash: h2, TransactionType: 'Payment', Account: OTHER, Destination: ISSUER, Fee: '12', date: rippleSec(closeMs(120)) },
        meta: { TransactionResult: 'tesSUCCESS', TransactionIndex: 3, AffectedNodes: [node(A, '999999990', '699999990')] } },
      { ledger_index: 900, tx: { hash: h4, TransactionType: 'Payment', Account: OTHER, Destination: A, Fee: '12', date: rippleSec(closeMs(900)) },
        meta: { TransactionResult: 'tesSUCCESS', TransactionIndex: 0, AffectedNodes: [node(A, '699999990', '749999990')] } },
    ];
    window.__rpcLog = [];
    chainRpcCall = async (req) => {
      window.__rpcLog.push(req.method);
      const p = req.params || {};
      const idx = p.ledger_index === 'validated' ? 1000 : Number(p.ledger_index);
      if (req.method === 'ledger') {
        if (idx > 1000) return { ledgerNotFound: true };
        return { ledger_index: idx, ledger: { ledger_index: String(idx), close_time: rippleSec(closeMs(idx)) } };
      }
      if (req.method === 'account_info') {
        if (p.account === A && req.chain === 'XRPL') return { account_data: { Balance: idx >= 900 ? '749999990' : '699999990', OwnerCount: 1 } };
        if (p.account === B && req.chain === 'Xahau') return { account_data: { Balance: '5000000', OwnerCount: 1 } };
        return { notFound: true };
      }
      if (req.method === 'account_lines') return { lines: p.account === B ? [{ account: ISSUER, currency: 'EVR', balance: '10' }] : [] };
      if (req.method === 'account_objects') return { account_objects: [] };
      if (req.method === 'account_tx') {
        const max = p.ledger_index_max === -1 ? Infinity : p.ledger_index_max;
        const mine = req.chain === 'XRPL' && p.account === A ? txs.filter((t) => t.ledger_index <= max) : [];
        // two pages, to exercise the marker
        if (!p.marker) return { transactions: mine.slice(0, 2), marker: mine.length > 2 ? 'page2' : undefined };
        return { transactions: mine.slice(2) };
      }
      return { error: 'unexpected' };
    };
    return true;
  }, { A, B, OTHER, ISSUER, h1: H('1'), h2: H('2'), h3: H('3'), h4: H('4'), full: fullJournalFor || null });
}

test('the check compares at the comparison point and grades each difference', async () => {
  await setUpScenario(null);
  const out = await window.evaluate(async () => {
    const r = await runOnchainCheck();
    const stored = JSON.parse(await window.taxDB.getMeta('onchainCheckV1'));
    const calls = window.__rpcLog.length;
    const again = await runOnchainCheck({ reuse: true });
    return { pins: r.pins, rows: r.rows.map((x) => ({ w: x.wallet, t: x.ticker, app: x.app, post: x.appPost, ledger: x.ledger, v: x.variance, st: x.status })),
             storedRows: stored.rows.length, reusedWithoutCalls: window.__rpcLog.length === calls && again.at === r.at,
             quality: onchainQualityHTML() };
  });
  expect(out.pins.XRPL.index).toBe(500);
  expect(out.pins.Xahau.index).toBe(500);
  const a = out.rows.find((x) => x.t === 'XRP');
  expect(a.post).toBeCloseTo(50, 9);           // the post-comparison booking is taken out
  expect(a.app).toBeCloseTo(1007, 9);
  expect(a.ledger).toBeCloseTo(699.99999, 9);
  expect(a.v).toBeCloseTo(307.00001, 6);
  expect(a.st).toBe('material');
  expect(out.rows.find((x) => x.t === 'EVR').st).toBe('match');
  const xah = out.rows.find((x) => x.t === 'XAH');
  expect(xah.v).toBeCloseTo(-5, 9);
  expect(['minor', 'material']).toContain(xah.st);
  expect(out.storedRows).toBe(3);
  expect(out.reusedWithoutCalls).toBe(true);
  expect(out.quality).toContain('differ from the ledger');
});

test('the panel lists the differences with an Explain button for each, and the CSV carries them', async () => {
  const out = await window.evaluate(async () => {
    showTab('holdings');
    await renderOnchainPanel();
    const panel = document.getElementById('onchainPanel');
    let csv = null;
    const saved = downloadCSV;
    downloadCSV = (lines, name) => { csv = { lines, name }; };
    exportOnchainCSV();
    downloadCSV = saved;
    return { text: panel.innerText, explainButtons: panel.querySelectorAll('button').length, csv };
  });
  expect(out.text).toContain('On-chain balance check');
  expect(out.text).toContain('differ by more');
  expect(out.text).toMatch(/Explain/);
  expect(out.csv.name).toMatch(/^Onchain-Check-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(out.csv.lines[0]).toContain('Difference (app - ledger)');
  expect(out.csv.lines.length).toBe(4);
});

test('Explain ties the difference to transactions, and the causes add up to it', async () => {
  await setUpScenario(A);
  const out = await window.evaluate(async ({ A }) => {
    await runOnchainCheck();
    await explainOnchain(A, 'XRPL');
    const x = _onchainExplain;
    const s = x.summary.XRP;
    let csv = null;
    const saved = downloadCSV;
    downloadCSV = (lines, name) => { csv = { lines, name }; };
    exportExplainCSV();
    downloadCSV = saved;
    await renderOnchainPanel();
    return {
      txn: x.txn, appAtPin: s.appAtPin, walk: s.walk, variance: s.variance, residual: s.residual, journalGap: s.journalGap,
      matchN: s.matchN, buckets: Object.fromEntries(Object.entries(s.buckets).map(([k, b]) => [k, { n: b.n, diff: b.diff }])),
      rows: x.rows.map((r) => ({ c: r.category, d: r.diff, hash: r.hash })), csvName: csv.name, csvLines: csv.lines.length,
      panel: document.getElementById('onchainPanel').innerText,
    };
  }, { A });
  expect(out.txn).toBe(3);                     // H4 is after the comparison ledger
  expect(out.appAtPin).toBeCloseTo(1007, 9);
  expect(out.walk).toBeCloseTo(699.99999, 9);
  expect(out.variance).toBeCloseTo(307.00001, 6);
  expect(Math.abs(out.residual)).toBeLessThan(1e-6);
  expect(Math.abs(out.journalGap)).toBeLessThan(1e-6);
  expect(out.matchN).toBe(1);                  // H1 agrees exactly
  expect(out.buckets.not_downloaded_affected.n).toBe(1);
  expect(out.buckets.not_downloaded_affected.diff).toBeCloseTo(300, 9);
  expect(out.buckets.booked_not_on_ledger.diff).toBeCloseTo(7, 9);
  expect(out.buckets.fee.diff).toBeCloseTo(0.00001, 9);
  expect(out.rows[0]).toMatchObject({ c: 'not_downloaded_affected', hash: H('2') });
  expect(out.csvName).toMatch(new RegExp(`^Onchain-Explain-${A.slice(0, 10)}-XRPL-`));
  expect(out.csvLines).toBeGreaterThan(3);
  expect(out.panel).toContain('Explained — the causes add up to the difference');
});

test('the page loads the module before the main script, and the renderer CSP is unchanged', async () => {
  const html = fs.readFileSync(path.join(APP_DIR, 'renderer/index.html'), 'utf8');
  const mod = html.indexOf('<script src="onchain.js"></script>');
  const main = html.indexOf('<script>\n', mod);
  expect(mod).toBeGreaterThan(0);
  expect(main).toBeGreaterThan(mod);
  const mainJs = fs.readFileSync(path.join(APP_DIR, 'main.js'), 'utf8');
  expect(mainJs).toContain(`"connect-src 'self' https://run.api.dhali.io"`);
});
