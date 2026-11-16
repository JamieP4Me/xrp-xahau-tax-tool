// test/bridge-amm.spec.js — what the first live read of XRPL trades showed
// was missing (1.10.15).
//
//   Bridge   coins sent to a bridge on one chain and arriving on the other
//            are the same coins: no sale, no income, cost and dates kept, in
//            BOTH directions. That needs the two chains processed in one
//            chronological order, which is also tested here.
//   AMM      under Treatment A, a wallet read from the ledger has both
//            assets of every deposit and withdrawal booked, with LP tokens
//            tracked so the gain on the pool position is reported.
//   Gifts    a gift of a token is in the Gift Log, with a value the donor
//            enters.
//
// Never put a real address in a test.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_DIR = path.join(__dirname, '..');
const W = 'rTESTbridgeMain11111111111111111';
const W2 = 'rTESTbridgeSecond111111111111111';
const BRIDGE = 'rTESTbridgeTeLeport11111111111111';
const MINTER = 'rTESTwrappedMinter11111111111111';
const POOL = 'rTESTammPoo1Account1111111111111';
const OTHER = 'rTESTbridgeStranger11111111111111';
const KID = 'rTESTgiftDaughter1111111111111111';
const H = (c) => c.repeat(64);
const LP = '03' + 'CD'.repeat(19);

let app, window, userDataDir;

test.beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrp-xahau-bridge-'));
  app = await electron.launch({
    args: [APP_DIR, '--user-data-dir=' + path.join(userDataDir, 'electron-profile')],
    cwd: APP_DIR,
    env: { ...process.env, HOME: userDataDir },
  });
  window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.waitForFunction(() => typeof _ledgerBuildInFlight !== 'undefined' && _ledgerBuildInFlight === null && !_ledgerLockHeld,
    null, { timeout: 30000 });
  await window.evaluate(({ W, MINTER }) => {
    // A stored ledger row, as renderer/ledger-trades.js writes them.
    window.lrow = ({ hash, ts, type = 'Payment', role = 'sent', xrp = 0, tokens = [], account, dest = '' }) => ({
      _ledger: 1, TransactionType: 'LedgerChange', TransactionResult: 'tesSUCCESS', Timestamp: ts, LedgerHash: hash,
      LedgerType: type, Account: account || W, Destination: dest, Role: role, XRP: xrp, Tokens: tokens });
    window.tok = (c, d, i) => ({ c, i: i || MINTER, d });
    // A Xahau Payment as the download stores it.
    window.xpay = (hash, ts, from, to, asset, qty) => ({ TransactionType: 'Payment', TransactionResult: 'tesSUCCESS', Account: from, Destination: to,
      Timestamp: ts, TransactionHash: hash,
      Amount_XRP: asset === 'XAH' ? String(qty) : '', delivered_amount_XRP: asset === 'XAH' ? String(qty) : '',
      Amount_value: asset === 'EVR' ? String(qty) : '', Amount_currency: asset === 'EVR' ? 'EVR' : '',
      delivered_amount_value: asset === 'EVR' ? String(qty) : '', delivered_amount_currency: asset === 'EVR' ? 'EVR' : '' });
    window.fresh = (wallets, opts = {}) => {
      resetLedgerState();
      WALLETS.length = 0; WALLETS.push(...wallets);
      ledgerTradeIndex.keys.clear(); ledgerTradeIndex.through.clear();
      bridgeConfig.addresses = opts.bridge || []; bridgeConfig.tokens = opts.tokens || {};
      giftAddresses.length = 0; for (const g of (opts.gifts || [])) giftAddresses.push(g);
      for (const k of Object.keys(giftValues)) delete giftValues[k];
      ammTreatment = opts.treatment || 'none';
      return { ws: new Set(wallets), xh: makeXahauPriceHelpers(), xr: makeXrplPriceHelpers() };
    };
    window.sumLots = (w, t) => ((walletLedger[w] || {})[t] || []).reduce((s, l) => s + l.remaining, 0);
    window.basisLots = (w, t) => ((walletLedger[w] || {})[t] || []).reduce((s, l) => s + l.remaining * l.unitCost, 0);
  }, { W, MINTER });
});

test.afterAll(async () => {
  if (app) await app.close();
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

// ── Bridge ─────────────────────────────────────────────────────────────

test('Xahau to XRPL: sending to a bridge is not a sale, and the coins arrive with their cost and dates (fee included)', async () => {
  const out = await window.evaluate(({ W, BRIDGE, OTHER, MINTER, h }) => {
    const tk = 'EVR.' + MINTER;
    const { ws, xh, xr } = fresh([W], { bridge: [BRIDGE], tokens: { [tk]: 'EVR' } });
    ledgerAdd(W, 'EVR', '2024-03-03', 1500, 0.30, 'reward');
    ledgerAdd(W, 'EVR', '2024-08-01', 1500, 0.10, 'reward');
    // 2,500 EVR leave Xahau; 2,495.01 arrive on XRPL (the bridge keeps 0.2%).
    processOneXahauRow(xpay(h[0], '2025-06-23 10:00:00', W, BRIDGE, 'EVR', 2500), W, ws, 'out', xh);
    const mid = { disposals: allDisposalsHigh.length, transit: sumLots(BRIDGE_TRANSIT, 'EVR'), left: sumLots(W, 'EVR') };
    processOneXRPLRow(lrow({ hash: h[1], ts: '2025-06-23 10:01:00', role: 'received', account: BRIDGE, dest: W, tokens: [tok('EVR', 2495.00998)] }), W, ws, 'out', xr);
    const lots = walletLedger[W][tk].map((l) => ({ qty: l.qty, date: l.date, basis: l.qty * l.unitCost, source: l.source }));
    // Then sold on XRPL for XRP: a real sale, against the carried cost.
    processOneXRPLRow(lrow({ hash: h[2], ts: '2025-09-24 10:00:00', type: 'OfferCreate', xrp: 173.063557, tokens: [tok('EVR', -1948.658851)] }), W, ws, 'out', xr);
    const sale = allDisposalsHigh[0];
    return { mid, lots, transitAfter: sumLots(BRIDGE_TRANSIT, 'EVR'), income: allIncomeRows.length,
             sale: { ticker: sale.ticker, basis: sale.basis, term: sale.term, proceeds: sale.proceeds }, rows: allDisposalsHigh.length,
             kinds: ledgerTradeLog.map((l) => l.chain + ':' + l.kind), stats: { o: ledgerTradeStats.bridgeOut, i: ledgerTradeStats.bridgeIn, u: ledgerTradeStats.bridgeUnmatched },
             price: latestPriceFor(tk).price, evrPrice: latestPriceFor('EVR').price };
  }, { W, BRIDGE, OTHER, MINTER, h: [H('1'), H('2'), H('3')] });
  expect(out.mid).toEqual({ disposals: 0, transit: 2500, left: 500 });      // not sold; waiting in transit
  expect(out.lots).toHaveLength(2);
  expect(out.lots[0].date).toBe('2024-03-03');
  expect(out.lots[0].source).toBe('bridge');
  expect(out.lots[0].basis).toBeCloseTo(1500 * 0.30, 6);                     // the whole cost rides on what arrived
  expect(out.lots[1].basis).toBeCloseTo(1000 * 0.10, 6);
  expect(out.lots[0].qty + out.lots[1].qty).toBeCloseTo(2495.00998, 6);
  expect(out.transitAfter).toBeCloseTo(0, 9);                                // no stub left behind
  expect(out.income).toBe(0);
  expect(out.rows).toBe(1);
  expect(out.sale.ticker).toBe('EVR.' + MINTER);
  expect(out.sale.term).toBe('LT');                                          // 2024-03-03 lots, sold 2025-09-24
  expect(out.sale.basis).toBeGreaterThan(400);                               // not $0
  expect(out.kinds).toEqual(['Xahau:bridge_out', 'XRPL:bridge_in', 'XRPL:sell']);
  expect(out.stats).toEqual({ o: 1, i: 1, u: 0 });
  expect(out.price).toBe(out.evrPrice);                                      // a bridged token is priced as the coin it is
});

test('XRPL to Xahau: coins sent to a bridge arrive on Xahau with their cost, and EVR from a bridge is never income', async () => {
  const out = await window.evaluate(({ W, BRIDGE, MINTER, h }) => {
    const xahTk = 'XAH.' + MINTER, evrTk = 'EVR.' + MINTER;
    const { ws, xh, xr } = fresh([W], { bridge: [BRIDGE], tokens: { [xahTk]: 'XAH', [evrTk]: 'EVR' } });
    ledgerAdd(W, xahTk, '2025-08-27', 20000, 0.04, 'amm_withdrawal');
    ledgerAdd(W, evrTk, '2025-01-05', 100, 0.25, 'dex_buy');
    processOneXRPLRow(lrow({ hash: h[0], ts: '2025-08-27 12:00:00', dest: BRIDGE, tokens: [tok('XAH', -20000)] }), W, ws, 'out', xr);
    processOneXahauRow(xpay(h[1], '2025-08-27 12:02:00', BRIDGE, W, 'XAH', 20000), W, ws, 'out', xh);
    processOneXRPLRow(lrow({ hash: h[2], ts: '2025-08-28 12:00:00', dest: BRIDGE, tokens: [tok('EVR', -100)] }), W, ws, 'out', xr);
    processOneXahauRow(xpay(h[3], '2025-08-28 12:02:00', BRIDGE, W, 'EVR', 100), W, ws, 'out', xh);
    return { xah: walletLedger[W].XAH.map((l) => ({ qty: l.qty, date: l.date, unitCost: l.unitCost, source: l.source })),
             evr: walletLedger[W].EVR.map((l) => ({ qty: l.qty, date: l.date, unitCost: l.unitCost })),
             income: allIncomeRows.length, disposals: allDisposalsHigh.length, leftOnXrpl: sumLots(W, xahTk) + sumLots(W, evrTk) };
  }, { W, BRIDGE, MINTER, h: [H('4'), H('5'), H('6'), H('7')] });
  expect(out.xah).toEqual([{ qty: 20000, date: '2025-08-27', unitCost: 0.04, source: 'bridge' }]);
  expect(out.evr).toEqual([{ qty: 100, date: '2025-01-05', unitCost: 0.25 }]);
  expect(out.income).toBe(0);            // before, EVR from any outside address was booked as a reward
  expect(out.disposals).toBe(0);
  expect(out.leftOnXrpl).toBe(0);
});

test('an arrival with nothing recorded as sent is booked at that day\'s price, counted, and still not income', async () => {
  const out = await window.evaluate(({ W, BRIDGE, MINTER, h }) => {
    const { ws, xh } = fresh([W], { bridge: [BRIDGE] });
    processOneXahauRow(xpay(h, '2025-08-28 12:02:00', BRIDGE, W, 'EVR', 100), W, ws, 'out', xh);
    const price = lookupPrice(EVR_PRICES, 'EVR', '2025-08-28', 'high');
    return { lot: walletLedger[W].EVR.map((l) => ({ qty: l.qty, unitCost: l.unitCost, source: l.source })), price, income: allIncomeRows.length,
             unmatched: ledgerTradeStats.bridgeUnmatched, kind: ledgerTradeLog[0].kind, html: ledgerTradesDisclosureHTML() };
  }, { W, BRIDGE, MINTER, h: H('8') });
  expect(out.lot).toEqual([{ qty: 100, unitCost: out.price, source: 'bridge_unmatched' }]);
  expect(out.income).toBe(0);
  expect(out.unmatched).toBe(1);
  expect(out.kind).toBe('bridge_in_unmatched');
  expect(out.html).toContain('nothing recorded as sent on the other chain');
});

test('unmarked, nothing changes: the same payments are a sale and a reward, as before', async () => {
  const out = await window.evaluate(({ W, BRIDGE, h }) => {
    const { ws, xh } = fresh([W]);
    ledgerAdd(W, 'EVR', '2024-03-03', 3000, 0.30, 'reward');
    processOneXahauRow(xpay(h[0], '2025-06-23 10:00:00', W, BRIDGE, 'EVR', 2500), W, ws, 'out', xh);
    processOneXahauRow(xpay(h[1], '2025-06-24 10:00:00', BRIDGE, W, 'EVR', 100), W, ws, 'out', xh);
    return { disposals: allDisposalsHigh.length, income: allIncomeRows.length, bridge: ledgerTradeStats.bridgeOut + ledgerTradeStats.bridgeIn };
  }, { W, BRIDGE, h: [H('9'), H('A')] });
  expect(out).toEqual({ disposals: 1, income: 1, bridge: 0 });
});

test('a bridge address cannot also be one of your own, a gift or a lost wallet, and marking one invalidates a saved report', async () => {
  const out = await window.evaluate(({ W, W2, BRIDGE, KID }) => {
    fresh([W], { gifts: [{ addr: KID, recipient: 'Recipient One' }] });
    const before = buildSettingsFingerprint();
    const r = { own: bridgeAddressConflict(W), gift: bridgeAddressConflict(KID), bad: bridgeAddressConflict('not an address'), ok: bridgeAddressConflict(BRIDGE),
                addOwn: addBridgeAddress(W), add: addBridgeAddress(BRIDGE), is: isBridgeAddress(BRIDGE) };
    r.changed = buildSettingsFingerprint() !== before;
    removeBridgeAddress(BRIDGE);
    r.back = buildSettingsFingerprint() === before;
    return r;
  }, { W, W2, BRIDGE, KID });
  expect(out.own).toMatch(/own wallets/);
  expect(out.gift).toMatch(/gift/);
  expect(out.bad).toMatch(/not a valid/);
  expect(out.ok).toBe('');
  expect(out.addOwn).toBe(false);
  expect(out.add).toBe(true);
  expect(out.is).toBe(true);
  expect(out.changed).toBe(true);
  expect(out.back).toBe(true);
});

test('the panel suggests a bridge from what the ledger read found, and never from dust', async () => {
  const out = await window.evaluate(({ W, BRIDGE, OTHER, MINTER, h }) => {
    const { ws, xr } = fresh([W]);
    processOneXRPLRow(lrow({ hash: h[0], ts: '2024-06-23 10:00:00', role: 'received', account: BRIDGE, dest: W, tokens: [tok('XAH', 2500)] }), W, ws, 'out', xr);
    processOneXRPLRow(lrow({ hash: h[1], ts: '2025-08-27 10:00:00', dest: BRIDGE, tokens: [tok('XAH', -2000)] }), W, ws, 'out', xr);
    processOneXRPLRow(lrow({ hash: h[2], ts: '2025-08-27 11:00:00', role: 'received', account: OTHER, dest: W, tokens: [tok('EVR', 0.000001)] }), W, ws, 'out', xr);   // spam
    processOneXRPLRow(lrow({ hash: h[3], ts: '2025-08-27 12:00:00', role: 'received', account: OTHER, dest: W, tokens: [tok('ABC', 5000)] }), W, ws, 'out', xr);     // not XAH/EVR
    const sug = bridgeSuggestions().map((e) => ({ addr: e.addr, tokens: [...e.tokens.values()].map((t) => [t.ticker, t.native, t.inQty, t.outQty]) }));
    addBridgeAddress(BRIDGE); setBridgedToken('XAH.' + MINTER, 'XAH');
    return { sug, after: bridgeSuggestions().length };
  }, { W, BRIDGE, OTHER, MINTER, h: [H('B'), H('C'), H('D'), H('E')] });
  expect(out.sug).toEqual([{ addr: BRIDGE, tokens: [['XAH.' + MINTER, 'XAH', 2500, 2000]] }]);
  expect(out.after).toBe(0);
});

test('when the bridge uses a different address on Xahau, the build points at it', async () => {
  const out = await window.evaluate(({ W, BRIDGE, OTHER, MINTER, h }) => {
    const tk = 'EVR.' + MINTER, xahTk = 'XAH.' + MINTER;
    const XSIDE = 'rTESTbridgeXahauSide1111111111111';
    // Only the XRPL-side address is marked.
    const { ws, xh, xr } = fresh([W], { bridge: [BRIDGE], tokens: { [tk]: 'EVR', [xahTk]: 'XAH' } });
    ledgerAdd(W, 'EVR', '2024-03-03', 5000, 0.30, 'reward');
    ledgerAdd(W, xahTk, '2025-08-01', 3000, 0.04, 'dex_buy');
    processOneXahauRow(xpay(h[0], '2025-06-23 09:00:00', W, OTHER, 'EVR', 40), W, ws, 'out', xh);          // an ordinary sale
    processOneXahauRow(xpay(h[1], '2025-06-23 10:00:00', W, XSIDE, 'EVR', 2500), W, ws, 'out', xh);        // really the bridge
    processOneXRPLRow(lrow({ hash: h[2], ts: '2025-06-23 10:01:00', role: 'received', account: BRIDGE, dest: W, tokens: [tok('EVR', 2495.00998)] }), W, ws, 'out', xr);
    processOneXRPLRow(lrow({ hash: h[3], ts: '2025-08-27 12:00:00', dest: BRIDGE, tokens: [tok('XAH', -3000)] }), W, ws, 'out', xr);
    processOneXahauRow(xpay(h[4], '2025-08-27 12:03:00', XSIDE, W, 'XAH', 2994), W, ws, 'out', xh);         // comes back from it
    processOneXahauRow(xpay(h[5], '2025-08-29 12:03:00', OTHER, W, 'XAH', 2994), W, ws, 'out', xh);         // two days later: unrelated
    const hints = JSON.parse(JSON.stringify(bridgeScan.hints));
    const snap = snapshotLedgerState(); restoreLedgerState(snap);
    return { hints, kept: Object.keys(bridgeScan.hints), unmatched: ledgerTradeStats.bridgeUnmatched, XSIDE, OTHER };
  }, { W, BRIDGE, OTHER, MINTER, h: [H('1'), H('2'), H('3'), H('4'), H('5'), H('6')] });
  expect(Object.keys(out.hints)).toEqual([out.XSIDE]);
  expect(out.hints[out.XSIDE]).toMatchObject({ n: 2 });
  expect(out.kept).toEqual([out.XSIDE]);         // survives a saved report
  expect(out.unmatched).toBe(1);
});

// ── AMM pools under Treatment A ────────────────────────────────────────

test('Treatment A from the ledger: both assets sold on deposit, LP tokens tracked, and the pool gain reported on withdrawal', async () => {
  const out = await window.evaluate(({ W, MINTER, POOL, LP, h }) => {
    const tk = 'ABC.' + MINTER, lpTk = LP + '.' + POOL;
    const { ws, xr } = fresh([W], { treatment: 'A' });
    ledgerAdd(W, 'XRP', '2023-01-10', 5000, 0.40, 'received');
    ledgerAdd(W, tk, '2024-05-20', 2000, 0.25, 'dex_buy');
    // Deposit 1,000 XRP + 2,000 ABC for 100 LP tokens.
    processOneXRPLRow(lrow({ hash: h[0], ts: '2024-05-24 10:00:00', type: 'AMMDeposit', xrp: -1000, tokens: [tok('ABC', -2000), tok(LP, 100, POOL)] }), W, ws, 'out', xr);
    const pIn = lookupPrice(XRP_PRICES, 'XRP', '2024-05-24', 'high');
    const dep = allDisposalsHigh.map((r) => ({ ticker: r.ticker, qty: r.qty, proceeds: r.proceeds, basis: r.basis, desc: r.description }));
    const lpLot = walletLedger[W][lpTk].map((l) => ({ qty: l.qty, basis: l.qty * l.unitCost, date: l.date, source: l.source }));
    // Withdraw with 60 LP tokens: 900 XRP + 1,100 ABC come out.
    processOneXRPLRow(lrow({ hash: h[1], ts: '2025-08-27 10:00:00', type: 'AMMWithdraw', xrp: 900, tokens: [tok('ABC', 1100), tok(LP, -60, POOL)] }), W, ws, 'out', xr);
    const pOut = lookupPrice(XRP_PRICES, 'XRP', '2025-08-27', 'high');
    const wd = allDisposalsHigh[2];
    // Then the rest with 40 LP tokens, XRP only.
    processOneXRPLRow(lrow({ hash: h[2], ts: '2025-09-01 10:00:00', type: 'AMMWithdraw', xrp: 700, tokens: [tok(LP, -40, POOL)] }), W, ws, 'out', xr);
    const pOut2 = lookupPrice(XRP_PRICES, 'XRP', '2025-09-01', 'high');
    const wd2 = allDisposalsHigh[3];
    return { pIn, pOut, pOut2, dep, lpLot,
      wd: { ticker: wd.ticker, qty: wd.qty, proceeds: wd.proceeds, basis: wd.basis, gain: wd.gain, term: wd.term, desc: wd.description },
      wd2: { proceeds: wd2.proceeds, basis: wd2.basis },
      xrpNew: walletLedger[W].XRP.filter((l) => l.source === 'amm_withdrawal').map((l) => ({ qty: l.qty, unitCost: l.unitCost, date: l.date })),
      abcNew: walletLedger[W][tk].filter((l) => l.source === 'amm_withdrawal').map((l) => ({ qty: l.qty, basis: l.qty * l.unitCost })),
      lpLeft: sumLots(W, lpTk), stats: { d: ledgerTradeStats.ammDeposits, w: ledgerTradeStats.ammWithdrawals, old: [ammBookedDeposits, ammBookedWithdrawals] },
      lp: lpGainByYear(), html: ledgerTradesDisclosureHTML() };
  }, { W, MINTER, POOL, LP, h: [H('1'), H('2'), H('3')] });
  // Deposit: the XRP at its price, the token at the same value (the pool's two sides are equal in value).
  expect(out.dep).toHaveLength(2);
  expect(out.dep[0].ticker).toBe('XRP');
  expect(out.dep[0].proceeds).toBeCloseTo(1000 * out.pIn, 2);
  expect(out.dep[0].basis).toBeCloseTo(400, 2);
  expect(out.dep[0].desc).toContain('deposited to AMM pool');
  expect(out.dep[1].ticker).toBe('ABC.' + MINTER);
  expect(out.dep[1].proceeds).toBeCloseTo(1000 * out.pIn, 2);
  expect(out.dep[1].basis).toBeCloseTo(500, 2);
  expect(out.lpLot).toHaveLength(1);
  expect(out.lpLot[0]).toMatchObject({ qty: 100, date: '2024-05-24', source: 'amm_deposit' });
  expect(out.lpLot[0].basis).toBeCloseTo(2000 * out.pIn, 4);                 // what was put in, at value
  // Withdrawal: 60 of 100 LP tokens sold for what came out.
  expect(out.wd.ticker).toBe(LP + '.' + POOL);
  expect(out.wd.qty).toBe(60);
  expect(out.wd.proceeds).toBeCloseTo(2 * 900 * out.pOut, 2);
  expect(out.wd.basis).toBeCloseTo(0.6 * 2000 * out.pIn, 2);
  expect(out.wd.gain).toBeCloseTo(out.wd.proceeds - out.wd.basis, 2);
  expect(out.wd.term).toBe('LT');
  expect(out.wd.desc).toContain('withdrawn from AMM pool');
  expect(out.wd2.proceeds).toBeCloseTo(700 * out.pOut2, 2);                  // XRP only: worth what the XRP was
  expect(out.wd2.basis).toBeCloseTo(0.4 * 2000 * out.pIn, 2);
  expect(out.xrpNew).toEqual([{ qty: 900, unitCost: out.pOut, date: '2025-08-27' }, { qty: 700, unitCost: out.pOut2, date: '2025-09-01' }]);
  expect(out.abcNew).toHaveLength(1);
  expect(out.abcNew[0].qty).toBe(1100);
  expect(out.abcNew[0].basis).toBeCloseTo(900 * out.pOut, 4);
  expect(out.lpLeft).toBeCloseTo(0, 9);
  expect(out.stats).toEqual({ d: 1, w: 2, old: [1, 2] });
  expect(out.lp[2025].rows).toBe(2);
  expect(out.lp[2025].gain).toBeCloseTo(out.wd.gain + (out.wd2.proceeds - out.wd2.basis), 1);
  expect(out.html).toContain('Gain or loss on LP tokens');
});

test('a bridged token is valued at its own price in a pool, and an unpriced token alone has its cost carried across', async () => {
  const out = await window.evaluate(({ W, MINTER, POOL, LP, h }) => {
    const xahTk = 'XAH.' + MINTER, abc = 'ABC.' + MINTER, lpTk = LP + '.' + POOL, lp2 = '03' + 'EF'.repeat(19), lp2Tk = lp2 + '.' + POOL;
    const { ws, xr } = fresh([W], { treatment: 'A', tokens: { [xahTk]: 'XAH' } });
    ledgerAdd(W, lpTk, '2024-05-24', 100, 10, 'amm_deposit');                // cost $1,000
    ledgerAdd(W, lp2Tk, '2024-05-24', 50, 4, 'amm_deposit');                 // cost $200
    // All 100 LP tokens for wrapped XAH only.
    processOneXRPLRow(lrow({ hash: h[0], ts: '2025-08-27 10:00:00', type: 'AMMWithdraw', xrp: 0, tokens: [tok('XAH', 20000), tok(LP, -100, POOL)] }), W, ws, 'out', xr);
    const xahPrice = lookupPrice(XAH_PRICES, 'XAH', '2025-08-27', 'high');
    const wd = allDisposalsHigh[0];
    // 50 of the other LP token for an unpriced token only: nothing to value it with.
    processOneXRPLRow(lrow({ hash: h[1], ts: '2025-08-28 10:00:00', type: 'AMMWithdraw', xrp: 0, tokens: [tok('ABC', 777), tok(lp2, -50, POOL)] }), W, ws, 'out', xr);
    return { xahPrice, wd: { proceeds: wd.proceeds, basis: wd.basis }, xahLot: walletLedger[W][xahTk].map((l) => ({ qty: l.qty, unitCost: l.unitCost })),
             rows: allDisposalsHigh.length, abcBasis: basisLots(W, abc), carried: ledgerTradeStats.ammCarried, kinds: ledgerTradeLog.map((l) => l.kind) };
  }, { W, MINTER, POOL, LP, h: [H('4'), H('5')] });
  expect(out.wd.proceeds).toBeCloseTo(20000 * out.xahPrice, 2);
  expect(out.wd.basis).toBeCloseTo(1000, 2);
  expect(out.xahLot).toEqual([{ qty: 20000, unitCost: out.xahPrice }]);
  expect(out.rows).toBe(1);                                                   // the unpriced one reports no sale
  expect(out.abcBasis).toBeCloseTo(200, 6);                                   // its cost went with it
  expect(out.carried).toBe(1);
  expect(out.kinds).toEqual(['amm_withdraw', 'amm_carried']);
});

test('under Standard nothing about AMM is booked; under A the download\'s AMM row is replaced only inside the range read', async () => {
  const out = await window.evaluate(({ W, MINTER, POOL, LP, h }) => {
    const ammRow = (ts) => ({ TransactionType: 'AMMDeposit', TransactionResult: 'tesSUCCESS', Account: W, Destination: '', Timestamp: ts,
                              TransactionHash: String.fromCharCode(0).repeat(64), Amount_XRP: '1000' });
    const led = lrow({ hash: h, ts: '2024-05-24 10:00:00', type: 'AMMDeposit', xrp: -1000, tokens: [tok('ABC', -2000), tok(LP, 100, POOL)] });
    const run = (treatment, through) => {
      const { ws, xr } = fresh([W], { treatment });
      ledgerAdd(W, 'XRP', '2023-01-10', 5000, 0.40, 'received');
      if (through) ledgerTradeIndex.through.set(W, parseWinDbTs(through));
      processOneXRPLRow(ammRow('2024-05-24 10:00:00'), W, ws, 'out', xr);     // the download's view
      processOneXRPLRow(led, W, ws, 'out', xr);                               // the ledger's view
      processOneXRPLRow(ammRow('2024-07-01 10:00:00'), W, ws, 'out', xr);     // a later one, after the range
      return { rows: allDisposalsHigh.map((r) => r.ticker.split('.')[0]), replaced: ledgerTradeStats.ammReplaced, unvalued: unvaluedRows.length, noted: ledgerTradeStats.amm };
    };
    return { standard: run('none', '2024-06-01 00:00:00'), a: run('A', '2024-06-01 00:00:00') };
  }, { W, MINTER, POOL, LP, h: H('6') });
  expect(out.standard.rows).toEqual([]);                                      // disclosed, not booked
  expect(out.standard.replaced).toBe(0);
  expect(out.standard.unvalued).toBe(2);                                      // both download rows still listed
  expect(out.standard.noted).toBe(1);
  expect(out.a.rows).toEqual(['XRP', 'ABC']);                                 // booked once, from the ledger: no second XRP row
  expect(out.a.replaced).toBe(1);
});

test('one token traded for another is valued when either is a bridged coin', async () => {
  const out = await window.evaluate(({ W, MINTER, h }) => {
    const evrTk = 'EVR.' + MINTER, xahTk = 'XAH.' + MINTER;
    const { ws, xr } = fresh([W], { tokens: { [evrTk]: 'EVR', [xahTk]: 'XAH' } });
    ledgerAdd(W, evrTk, '2024-03-03', 1000, 0.30, 'bridge');
    processOneXRPLRow(lrow({ hash: h, ts: '2025-06-23 10:00:00', type: 'OfferCreate', tokens: [tok('EVR', -546.35), tok('XAH', 2115.97)] }), W, ws, 'out', xr);
    const xahPrice = lookupPrice(XAH_PRICES, 'XAH', '2025-06-23', 'high');
    const d = allDisposalsHigh[0];
    return { xahPrice, d: { ticker: d.ticker, qty: d.qty, proceeds: d.proceeds, basis: d.basis }, lot: walletLedger[W][xahTk].map((l) => ({ qty: l.qty, basis: l.qty * l.unitCost })),
             valued: ledgerTradeStats.swapsValued, unvalued: ledgerTradeStats.swaps };
  }, { W, MINTER, h: H('7') });
  expect(out.d.ticker).toBe('EVR.' + MINTER);
  expect(out.d.proceeds).toBeCloseTo(2115.97 * out.xahPrice, 2);              // what was received was worth
  expect(out.d.basis).toBeCloseTo(546.35 * 0.30, 2);
  expect(out.lot[0].basis).toBeCloseTo(2115.97 * out.xahPrice, 4);
  expect(out.valued).toBe(1);
  expect(out.unvalued).toBe(0);
});

// ── Gifts of tokens ────────────────────────────────────────────────────

test('a gift of a token is in the Gift Log with its lots, needs a value until one is entered, and keeps it across a reload', async () => {
  const out = await window.evaluate(async ({ W, KID, MINTER, h }) => {
    const tk = 'SOL.' + MINTER;
    const { ws, xr } = fresh([W], { gifts: [{ addr: KID, recipient: 'Recipient One' }] });
    ledgerAdd(W, tk, '2021-11-07', 6000, 1.10, 'dex_buy');
    ledgerAdd(W, tk, '2025-09-01', 6000, 0.10, 'dex_buy');
    processOneXRPLRow(lrow({ hash: h, ts: '2025-12-19 10:00:00', dest: KID, tokens: [tok('SOL', -10000)] }), W, ws, 'out', xr);
    const g = allGiftRows[0];
    const before = { n: allGiftRows.length, disposals: allDisposalsHigh.length, unpriced: g.unpriced, basis: g.basis, fmv: g.fmv, lots: g.lots.length, term: g.term,
                     form: giftValueFormHTML(), year: giftsByRecipientYear()[0], left: sumLots(W, tk) };
    let csvBefore = null; const real = downloadCSV;
    downloadCSV = (lines) => { csvBefore = lines[1]; };
    try { exportGiftsCSV(); } finally { downloadCSV = real; }
    // The donor enters $2,000 for the transfer.
    giftValues[g.valueKey] = 2000; applyGiftValues();
    const after = { unpriced: g.unpriced, fmv: g.fmv, price: g.price, lossBasis: g.lossBasis, dual: g.dualBasis,
                    lots: g.lots.map((l) => ({ qty: l.qty, basis: l.basis, fmv: l.fmv, lossBasis: l.lossBasis, dual: l.dual })), year: giftsByRecipientYear()[0] };
    // A saved report made before the value was entered still shows it after loading.
    const snap = snapshotLedgerState();
    snap.allGiftRows[0].unpriced = true; snap.allGiftRows[0].fmv = 0;
    restoreLedgerState(snap);
    const reloaded = { unpriced: allGiftRows[0].unpriced, fmv: allGiftRows[0].fmv };
    const pdf = buildGiftStatementDoc('Recipient One').output();
    return { before, csvBefore, after, reloaded, pdfHasToken: pdf.includes('SOL ') && pdf.includes('rTESTwr'), key: g.valueKey };
  }, { W, KID, MINTER, h: H('8') });
  expect(out.before.n).toBe(1);
  expect(out.before.disposals).toBe(0);                                       // a gift is not a sale
  expect(out.before.unpriced).toBe(true);
  expect(out.before.basis).toBeCloseTo(6000 * 1.10 + 4000 * 0.10, 6);
  expect(out.before.lots).toBe(2);
  expect(out.before.term).toBe('VARIOUS');
  expect(out.before.left).toBeCloseTo(2000, 9);
  expect(out.before.form).toContain('still needs one');
  expect(out.before.form).toContain('giftVal_0');
  expect(out.before.year.unpriced).toBe(1);
  expect(out.csvBefore).toContain('not entered');
  expect(out.key).toBe(H('8') + ':SOL.' + MINTER);
  expect(out.after.unpriced).toBe(false);
  expect(out.after.fmv).toBe(2000);
  expect(out.after.price).toBeCloseTo(0.2, 9);
  // Lot 1 cost $6,600, worth $1,200 that day: loss basis $1,200 (dual). Lot 2 cost $400, worth $800: loss basis $400.
  expect(out.after.lots[0].lossBasis).toBeCloseTo(1200, 6);
  expect(out.after.lots[0].dual).toBe(true);
  expect(out.after.lots[1].lossBasis).toBeCloseTo(400, 6);
  expect(out.after.lots[1].dual).toBe(false);
  expect(out.after.lossBasis).toBeCloseTo(1600, 6);
  expect(out.after.dual).toBe(true);
  expect(out.after.year.unpriced).toBe(0);
  expect(out.after.year.fmv).toBe(2000);
  expect(out.reloaded).toEqual({ unpriced: false, fmv: 2000 });
  expect(out.pdfHasToken).toBe(true);
});

// ── Both chains in one order, end to end ───────────────────────────────

test('a build reads both chains in one chronological order, so a round trip across the bridge keeps its cost both ways', async () => {
  const out = await window.evaluate(async ({ W, BRIDGE, OTHER, MINTER, h }) => {
    const tk = 'XAH.' + MINTER;
    await window.taxDB.clearAll();
    fresh([W], { bridge: [BRIDGE], tokens: { [tk]: 'XAH' } });
    const xa = (hash, ts, row) => ({ tx_hash: hash, timestamp: ts, raw_json: JSON.stringify(row) });
    const lr = (hash, ts, row) => ({ tx_hash: 'LEDGER:' + hash, timestamp: ts, raw_json: JSON.stringify(row) });
    await window.taxDB.insertRows(W, 'Xahau', [
      xa(h[0], '2024-01-10 10:00:00', xpay(h[0], '2024-01-10 10:00:00', OTHER, W, 'XAH', 5000)),       // acquired on Xahau
      xa(h[1], '2024-06-23 10:00:00', xpay(h[1], '2024-06-23 10:00:00', W, BRIDGE, 'XAH', 2500)),      // out to XRPL
      xa(h[4], '2025-08-27 12:02:00', xpay(h[4], '2025-08-27 12:02:00', BRIDGE, W, 'XAH', 2500)),      // back again
    ]);
    await window.taxDB.insertRows(W, 'XRPL', [
      lr(h[2], '2024-06-23 10:01:00', lrow({ hash: h[2], ts: '2024-06-23 10:01:00', role: 'received', account: BRIDGE, dest: W, tokens: [tok('XAH', 2500)] })),
      lr(h[3], '2025-08-27 12:00:00', lrow({ hash: h[3], ts: '2025-08-27 12:00:00', dest: BRIDGE, tokens: [tok('XAH', -2500)] })),
    ]);
    await window.taxDB.setLedgerSweep({ wallet: W, chain: 'XRPL', through_ledger: 95000000, through_ts: '2025-12-31 00:00:00', txs: 2, stored: 2 });
    await buildReportFromCache({ silent: true });
    const p = lookupPrice(XAH_PRICES, 'XAH', '2024-01-10', 'high');
    return { p, xah: walletLedger[W].XAH.filter((l) => l.remaining > 0).map((l) => ({ qty: l.remaining, date: l.date, unitCost: l.unitCost })),
             onXrpl: sumLots(W, tk), transit: sumLots(BRIDGE_TRANSIT, 'XAH'), disposals: allDisposalsHigh.length, income: allIncomeRows.length,
             stats: { o: ledgerTradeStats.bridgeOut, i: ledgerTradeStats.bridgeIn, u: ledgerTradeStats.bridgeUnmatched },
             mismatch: ledgerCountMismatch, streamed: rowsStreamedThisBuild, order: ledgerTradeLog.map((l) => l.chain[0] + ':' + l.kind) };
  }, { W, BRIDGE, OTHER, MINTER, h: [H('1'), H('2'), H('3'), H('4'), H('5')] });
  // All 5,000 XAH are back on Xahau at their January 2024 cost and date. Nothing sold, nothing earned, nothing stranded.
  expect(out.xah.reduce((s, l) => s + l.qty, 0)).toBeCloseTo(5000, 6);
  for (const l of out.xah) { expect(l.date).toBe('2024-01-10'); expect(l.unitCost).toBeCloseTo(out.p, 9); }
  expect(out.onXrpl).toBe(0);
  expect(out.transit).toBe(0);
  expect(out.disposals).toBe(0);
  expect(out.income).toBe(0);
  expect(out.stats).toEqual({ o: 2, i: 2, u: 0 });
  expect(out.order).toEqual(['X:bridge_out', 'X:bridge_in', 'X:bridge_out', 'X:bridge_in']);
  expect(out.mismatch).toBeNull();
  expect(out.streamed).toBe(5);
});

test('the Holdings CSV says which chain each row is on', async () => {
  const out = await window.evaluate(({ W, MINTER }) => {
    fresh([W]);
    ledgerAdd(W, 'XRP', '2024-01-01', 10, 0.5, 'received');
    ledgerAdd(W, 'EVR', '2024-03-03', 5, 0.3, 'reward');
    ledgerAdd(W, 'EVR.' + MINTER, '2024-03-03', 7, 0, 'token_received');
    ledgerAdd(BRIDGE_TRANSIT, 'XAH', '2024-03-03', 3, 0.1, 'bridge');
    const real = downloadCSV; let lines = null;
    downloadCSV = (l) => { lines = l; };
    try { exportHoldingsCSV(); } finally { downloadCSV = real; }
    const head = lines[0].split(',');
    return { last: head[head.length - 1], rows: lines.slice(1).map((l) => { const f = l.split(','); return [f[3].split('.')[0], f[f.length - 1]]; }).sort() };
  }, { W, MINTER });
  expect(out.last).toBe('Chain');
  expect(out.rows).toEqual([['EVR', 'XRPL'], ['EVR', 'Xahau'], ['XAH', 'in transit'], ['XRP', 'XRPL']]);
});
