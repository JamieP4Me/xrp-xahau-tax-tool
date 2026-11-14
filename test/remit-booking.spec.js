// test/remit-booking.spec.js — Remit legs are booked like Payments (1.10.12).
//
// The on-chain check on a real wallet found 22,790 XAH that left by Remit —
// into onexah pools — while the app still counted it as held, because a Remit
// was only listed. A Payment to the same pool was always booked as a sale.
// Now a Remit's XAH and EVR legs go through the exact rules a Payment uses,
// with one deliberate difference: EVR arriving by Remit is not income.
//
// Never put a real address in a test.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_DIR = path.join(__dirname, '..');
const W = 'rTESTremitWallet11111111111111111';
const W2 = 'rTESTremitSecond11111111111111111';
const POOL = 'rTESTremitPool111111111111111111';

let app, window, userDataDir;

test.beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrp-xahau-remit-'));
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

// The wallet first receives 200 XAH and 10 EVR by Payment from outside.
const seed = `
  resetLedgerState();
  var ws = new Set([args.W, args.W2]);
  var xh = makeXahauPriceHelpers();
  var pay = (hash, ts, from, to, xah, val, cur) => ({ TransactionType: 'Payment', TransactionResult: 'tesSUCCESS', Account: from, Destination: to,
    Timestamp: ts, TransactionHash: hash, Amount_XRP: xah, delivered_amount_XRP: xah, Amount_value: val, Amount_currency: cur,
    delivered_amount_value: val, delivered_amount_currency: cur });
  processOneXahauRow(pay('P1', '2026-01-05 00:00:00', args.POOL, args.W, '200', '', ''), args.W, ws, 'in', xh);
  processOneXahauRow(pay('P2', '2026-01-06 00:00:00', args.POOL, args.W, '', '10', 'EVR'), args.W, ws, 'in', xh);
  var incomeBefore = allIncomeRows.length;
  var remit = (hash, ts, from, to, amounts) => ({ TransactionType: 'Remit', TransactionResult: 'tesSUCCESS', Account: from, Destination: to,
    Timestamp: ts, TransactionHash: hash, Amounts: amounts });
  var held = (w, t) => ((walletLedger[w] || {})[t] || []).reduce((s, l) => s + l.remaining, 0);
`;

test('a Remit sent to a pool is a disposal of its XAH and EVR legs, marked (Remit); its other tokens stay listed', async () => {
  const out = await window.evaluate((args) => {
    eval(args.seed);
    processOneXahauRow(remit('R1', '2026-07-01 00:00:00', args.W, args.POOL, [
      { XRP: 100 }, { XRP: 0, token_value: '4', token_currency: 'EVR', token_issuer: args.POOL },
      { XRP: 0, token_value: '50', token_currency: 'XXX', token_issuer: args.POOL }]), args.W, ws, 'out', xh);
    return {
      disposals: allDisposalsHigh.map((d) => ({ t: d.ticker, q: d.qty, desc: d.description })),
      xah: held(args.W, 'XAH'), evr: held(args.W, 'EVR'),
      listed: unvaluedRows.map((r) => ({ type: r.type, legs: r.legs.map((l) => l.currency) })),
      booked: { ...remitBooked }, newIncome: allIncomeRows.length - incomeBefore,
    };
  }, { W, W2, POOL, seed });
  const xahSold = out.disposals.filter((d) => d.t === 'XAH').reduce((s, d) => s + d.q, 0);
  const evrSold = out.disposals.filter((d) => d.t === 'EVR').reduce((s, d) => s + d.q, 0);
  expect(xahSold).toBeCloseTo(100, 9);
  expect(evrSold).toBeCloseTo(4, 9);
  expect(out.disposals.every((d) => d.desc.includes('(Remit)'))).toBe(true);
  expect(out.xah).toBeCloseTo(100, 9);
  expect(out.evr).toBeCloseTo(6, 9);
  expect(out.listed).toEqual([{ type: 'Remit', legs: ['XXX'] }]);   // EVR booked, so not listed
  expect(out.booked).toMatchObject({ legs: 2, xahOut: 100, evrOut: 4 });
  expect(out.newIncome).toBe(0);
});

test('XAH and EVR received by Remit are acquisitions at market value, and the EVR is not income', async () => {
  const out = await window.evaluate((args) => {
    eval(args.seed);
    processOneXahauRow(remit('R2', '2026-08-01 00:00:00', args.POOL, args.W, [
      { XRP: 50 }, { XRP: 0, token_value: '2', token_currency: '4556520000000000000000000000000000000000', token_issuer: args.POOL }]), args.W, ws, 'in', xh);
    const lots = (t) => (walletLedger[args.W][t] || []).filter((l) => l.source === 'remit_received').map((l) => [l.qty, l.date]);
    return { xahLots: lots('XAH'), evrLots: lots('EVR'), newIncome: allIncomeRows.length - incomeBefore, booked: { ...remitBooked } };
  }, { W, W2, POOL, seed });
  expect(out.xahLots).toEqual([[50, '2026-08-01']]);
  expect(out.evrLots).toEqual([[2, '2026-08-01']]);       // the 40-hex spelling of EVR is EVR
  expect(out.newIncome).toBe(0);
  expect(out.booked).toMatchObject({ legs: 2, xahIn: 50, evrIn: 2 });
});

test('a Remit to your own wallet is a transfer that carries basis and dates, not a sale', async () => {
  const out = await window.evaluate((args) => {
    eval(args.seed);
    processOneXahauRow(remit('R3', '2026-07-02 00:00:00', args.W, args.W2, [{ XRP: 30 }]), args.W, ws, 'out', xh);
    return { disposals: allDisposalsHigh.length, w2: (walletLedger[args.W2].XAH || []).map((l) => [l.qty, l.date, l.source]), w: held(args.W, 'XAH') };
  }, { W, W2, POOL, seed });
  expect(out.disposals).toBe(0);
  expect(out.w2).toEqual([[30, '2026-01-05', 'transfer_in']]);   // the original acquisition date travels with it
  expect(out.w).toBeCloseTo(170, 9);
});

test('a Payment is booked exactly as before, EVR from outside still being income', async () => {
  const out = await window.evaluate((args) => {
    eval(args.seed);
    return { income: allIncomeRows.map((r) => [r.qty, r.description]), xah: held(args.W, 'XAH'), evr: held(args.W, 'EVR'), booked: remitBooked.legs };
  }, { W, W2, POOL, seed });
  expect(out.income).toEqual([[10, '10.0000 EVR reward']]);
  expect(out.xah).toBe(200);
  expect(out.evr).toBe(10);
  expect(out.booked).toBe(0);
});

test('the 8949 tab says what the Remit legs did, and the counts survive a snapshot', async () => {
  const out = await window.evaluate((args) => {
    eval(args.seed);
    processOneXahauRow(remit('R4', '2026-07-03 00:00:00', args.W, args.POOL, [{ XRP: 25 }]), args.W, ws, 'out', xh);
    const html = dataQualityHTML();
    const snap = snapshotLedgerState();
    resetLedgerState();
    const zeroed = remitBooked.legs;
    restoreLedgerState(snap);
    return { says: html.includes('Remit leg(s) booked like Payments') && html.includes('not</b> as income'), zeroed, restored: remitBooked.legs };
  }, { W, W2, POOL, seed });
  expect(out.says).toBe(true);
  expect(out.zeroed).toBe(0);
  expect(out.restored).toBe(1);
});
