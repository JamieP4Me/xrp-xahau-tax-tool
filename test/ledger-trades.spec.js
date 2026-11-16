// test/ledger-trades.spec.js — XRPL trades booked from the ledger (1.10.14).
//
// The download holds what a transaction asked for; the ledger holds what
// moved. What must hold:
//   - one transaction's balance changes are read correctly from metadata
//     (fee taken out, both sides of a trust line, failed transactions ignored);
//   - XRP-for-token and token-for-XRP are booked as trades at what moved, and
//     the basis of what was bought is the value of what was given;
//   - a transaction with a ledger row is booked ONCE, from the ledger row;
//   - an offer inside the range read that did not trade is not booked as a
//     sale; outside the range the old booking still applies;
//   - a token with no XRP side changes quantities only and is never on 8949;
//   - a token code cannot carry markup into the page;
//   - the sweep stores rows, records how far it read, resumes from there, and
//     refuses a server without full history.
//
// Never put a real address in a test.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_DIR = path.join(__dirname, '..');
const W = 'rTESTtradeMain1111111111111111111';
const W2 = 'rTESTtradeSecond11111111111111111';
const MINTER = 'rTESTtokenMinter1111111111111111';
const OTHER = 'rTESTtradeStranger111111111111111';
const H = (c) => c.repeat(64);

let app, window, userDataDir;

test.beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrp-xahau-trades-'));
  app = await electron.launch({
    args: [APP_DIR, '--user-data-dir=' + path.join(userDataDir, 'electron-profile')],
    cwd: APP_DIR,
    env: { ...process.env, HOME: userDataDir },
  });
  window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.waitForFunction(() => typeof _ledgerBuildInFlight !== 'undefined' && _ledgerBuildInFlight === null && !_ledgerLockHeld,
    null, { timeout: 30000 });
  // Shared builders, defined once in the page.
  await window.evaluate(({ W, MINTER }) => {
    // One account_tx entry. xrp: [before, after] in XRP for `acct`; lines: [{cur, before, after, peer}]
    // with `acct` on the LOW side (balance is from its side).
    window.mkEntry = ({ hash, iso, type, account, dest, fee = 12, acct = W, xrp, lines = [], result = 'tesSUCCESS' }) => {
      const nodes = [];
      if (xrp) nodes.push({ ModifiedNode: { LedgerEntryType: 'AccountRoot',
        FinalFields: { Account: acct, Balance: String(Math.round(xrp[1] * 1e6)) }, PreviousFields: { Balance: String(Math.round(xrp[0] * 1e6)) } } });
      for (const l of lines) nodes.push({ ModifiedNode: { LedgerEntryType: 'RippleState',
        FinalFields: { Balance: { currency: l.cur, value: String(l.after) }, LowLimit: { issuer: acct }, HighLimit: { issuer: l.peer || MINTER } },
        PreviousFields: { Balance: { currency: l.cur, value: String(l.before) } } } });
      return { hash, ledger_index: 90000000, validated: true,
        tx: { TransactionType: type, Account: account, Destination: dest, Fee: String(fee), date: Math.floor(Date.parse(iso) / 1000) - 946684800, hash },
        meta: { TransactionResult: result, TransactionIndex: 3, AffectedNodes: nodes } };
    };
    window.ledgerRow = (entry, wallet) => JSON.parse(ltCacheRow(ltChangesFromTx(entry, wallet || W)).raw_json);
    window.freshEngine = (wallets) => {
      resetLedgerState();
      WALLETS.length = 0; WALLETS.push(...wallets);
      ledgerTradeIndex.keys.clear(); ledgerTradeIndex.through.clear();
      return { ws: new Set(wallets), helpers: makeXrplPriceHelpers() };
    };
  }, { W, MINTER });
});

test.afterAll(async () => {
  if (app) await app.close();
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

// ── Pure pieces ────────────────────────────────────────────────────────

test('a token name is reduced to letters and digits, so it cannot carry markup', async () => {
  const out = await window.evaluate(({ MINTER }) => {
    const hex = (s) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').padEnd(40, '0').toUpperCase();
    const evil = hex('<img src=x>');
    return {
      plain: ltCurrencyCode('USD'), mixed: ltCurrencyCode(hex('mXRP')), evil: ltCurrencyCode(evil), evilHex: evil,
      symbol: ltCurrencyCode('U$D'), lp: ltCurrencyCode('03' + 'AB'.repeat(19)),
      ticker: ltTicker(hex('mXRP'), MINTER), badIssuer: ltTicker('USD', 'not-an-address'),
      label: ltTokenLabel(ltTicker(hex('mXRP'), MINTER)), lpLabel: ltTokenLabel(ltTicker('03' + 'AB'.repeat(19), MINTER)),
      xrpLabel: ltTokenLabel('XRP'), isTok: [ltIsToken('XRP'), ltIsToken('EVR'), ltIsToken('USD.' + MINTER)],
      everything: [ltTicker(evil, MINTER), ltTicker('U$D', MINTER), ltTokenLabel(ltTicker(evil, MINTER))],
    };
  }, { MINTER });
  expect(out.plain).toBe('USD');
  expect(out.mixed).toBe('mXRP');                 // case kept
  expect(out.evil).toBe(out.evilHex);             // not plain text: stays hex
  expect(out.symbol).toMatch(/^X[0-9A-F]+$/);
  expect(out.lp).toMatch(/^03[0-9A-F]{38}$/);
  expect(out.ticker).toBe('mXRP.' + MINTER);
  expect(out.badIssuer).toBeNull();
  expect(out.label).toBe('mXRP (rTESTto…)');
  expect(out.lpLabel).toMatch(/^LP token /);
  expect(out.xrpLabel).toBe('XRP');
  expect(out.isTok).toEqual([false, false, true]);
  for (const s of out.everything) expect(s).toMatch(/^[A-Za-z0-9. ()…]+$/);
});

test('one transaction: fee taken out of the XRP change, token change read from either side, failures ignored', async () => {
  const out = await window.evaluate(({ W, MINTER, OTHER, h }) => {
    const buy = mkEntry({ hash: h, iso: '2025-03-02T10:00:00Z', type: 'OfferCreate', account: W, xrp: [1000, 899.999988], lines: [{ cur: 'ABC', before: 0, after: 250 }] });
    const c = ltChangesFromTx(buy, W);
    // The same trust line seen from the HIGH side: the stored balance is negative for the holder.
    const high = { hash: h, tx: { TransactionType: 'Payment', Account: OTHER, Destination: W, Fee: '12', date: 800000000 },
      meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [{ ModifiedNode: { LedgerEntryType: 'RippleState',
        FinalFields: { Balance: { currency: 'ABC', value: '-40' }, HighLimit: { issuer: W }, LowLimit: { issuer: MINTER } },
        PreviousFields: { Balance: { currency: 'ABC', value: '-10' } } } }] } };
    const failed = mkEntry({ hash: h, iso: '2025-03-02T10:00:00Z', type: 'OfferCreate', account: W, xrp: [1000, 999.999988], result: 'tecUNFUNDED_OFFER' });
    const xrpOnly = mkEntry({ hash: h, iso: '2025-03-02T10:00:00Z', type: 'Payment', account: W, dest: OTHER, xrp: [1000, 899.999988] });
    const amm = mkEntry({ hash: h, iso: '2025-03-02T10:00:00Z', type: 'AMMDeposit', account: W, xrp: [1000, 900], lines: [{ cur: '03' + 'AB'.repeat(19), before: 0, after: 5 }] });
    const row = ltCacheRow(c);
    return { c, high: ltChangesFromTx(high, W), failed: ltChangesFromTx(failed, W), xrpOnlyRow: ltCacheRow(ltChangesFromTx(xrpOnly, W)),
             key: row.tx_hash, ts: row.timestamp, type: JSON.parse(row.raw_json).TransactionType, ammKey: ltCacheRow(ltChangesFromTx(amm, W)).tx_hash };
  }, { W, MINTER, OTHER, h: H('A') });
  expect(out.c.xrp).toBeCloseTo(-100, 6);          // 100.000012 left the account, 0.000012 of it the fee
  expect(out.c.fee).toBeCloseTo(0.000012, 9);
  expect(out.c.role).toBe('sent');
  expect(out.c.tokens).toEqual([{ c: 'ABC', i: MINTER, d: 250 }]);
  expect(out.high.tokens).toEqual([{ c: 'ABC', i: MINTER, d: 30 }]);
  expect(out.high.role).toBe('received');
  expect(out.high.xrp).toBe(0);
  expect(out.failed).toBeNull();
  expect(out.xrpOnlyRow).toBeNull();               // no token moved: left to the download
  expect(out.key).toBe('LEDGER:' + H('A'));
  expect(out.ts).toBe('2025-03-02 10:00:00');
  expect(out.type).toBe('LedgerChange');
  expect(out.ammKey).toBe('LEDGERAMM:' + H('A'));
});

test('each stored row is one kind of event', async () => {
  const out = await window.evaluate(({ MINTER }) => {
    const t = (d, c = 'ABC') => ({ c, i: MINTER, d });
    const k = (XRP, Tokens, LedgerType = 'OfferCreate') => ltShape({ XRP, Tokens, LedgerType }).kind;
    return [k(-10, [t(5)]), k(10, [t(-5)]), k(0, [t(5)]), k(0, [t(-5)]), k(0, [t(5), t(-3, 'DEF')]), k(-10, [t(-5)]),
            k(-10, [t(5), t(2, 'DEF')]), k(-10, [t(5)], 'AMMDeposit'), k(-10, []), k(0.0000001, [t(5)])];
  }, { MINTER });
  expect(out).toEqual(['buy', 'sell', 'token_in', 'token_out', 'token_swap', 'complex', 'complex', 'amm', 'none', 'token_in']);
});

// ── Booking ────────────────────────────────────────────────────────────

test('buying a token with XRP sells the XRP, and its value becomes the token\'s basis', async () => {
  const out = await window.evaluate(({ W, MINTER, h }) => {
    const { ws, helpers } = freshEngine([W]);
    ledgerAdd(W, 'XRP', '2023-01-10', 1000, 0.40, 'received');
    const row = ledgerRow(mkEntry({ hash: h, iso: '2025-03-02T10:00:00Z', type: 'OfferCreate', account: W, xrp: [1000, 899.999988], lines: [{ cur: 'ABC', before: 0, after: 250 }] }));
    processOneXRPLRow(row, W, ws, 'out', helpers);
    const price = lookupPrice(XRP_PRICES, 'XRP', '2025-03-02', 'high');
    const tk = 'ABC.' + MINTER;
    return { price, d: allDisposalsHigh.map((r) => ({ ticker: r.ticker, qty: r.qty, proceeds: r.proceeds, basis: r.basis, term: r.term, desc: r.description, hash: r.txHash, chain: r.chain })),
             lot: walletLedger[W][tk], xrpLeft: walletLedger[W].XRP.reduce((s, l) => s + l.remaining, 0), stats: { ...ledgerTradeStats }, log: ledgerTradeLog.map((l) => l.kind) };
  }, { W, MINTER, h: H('B') });
  expect(out.d).toHaveLength(1);
  expect(out.d[0].ticker).toBe('XRP');
  expect(out.d[0].qty).toBeCloseTo(100, 6);
  expect(out.d[0].proceeds).toBeCloseTo(100 * out.price, 2);
  expect(out.d[0].basis).toBeCloseTo(40, 2);
  expect(out.d[0].term).toBe('LT');
  expect(out.d[0].desc).toContain('(DEX)');
  expect(out.d[0].hash).toBe(H('B'));
  expect(out.lot).toHaveLength(1);
  expect(out.lot[0].qty).toBe(250);
  expect(out.lot[0].unitCost * 250).toBeCloseTo(100 * out.price, 6);   // basis = what the XRP was worth
  expect(out.lot[0].date).toBe('2025-03-02');
  expect(out.xrpLeft).toBeCloseTo(900, 6);
  expect(out.stats.buys).toBe(1);
  expect(out.log).toEqual(['buy']);
});

test('selling a token for XRP is a sale of the token, with the holding period from when it was bought', async () => {
  const out = await window.evaluate(({ W, MINTER, hb, hs }) => {
    const { ws, helpers } = freshEngine([W]);
    ledgerAdd(W, 'XRP', '2023-01-10', 1000, 0.40, 'received');
    const run = (e) => processOneXRPLRow(ledgerRow(e), W, ws, 'out', helpers);
    run(mkEntry({ hash: hb, iso: '2024-01-15T10:00:00Z', type: 'OfferCreate', account: W, xrp: [1000, 899.999988], lines: [{ cur: 'ABC', before: 0, after: 250 }] }));
    // Filled by someone else's transaction: this wallet did not sign it and paid no fee.
    run(mkEntry({ hash: hs, iso: '2025-03-02T10:00:00Z', type: 'OfferCreate', account: 'rTESTtradeStranger111111111111111', xrp: [899.999988, 1049.999988], lines: [{ cur: 'ABC', before: 250, after: 50 }] }));
    const buyPrice = lookupPrice(XRP_PRICES, 'XRP', '2024-01-15', 'high'), sellPrice = lookupPrice(XRP_PRICES, 'XRP', '2025-03-02', 'high');
    const tk = 'ABC.' + MINTER;
    const sale = allDisposalsHigh.find((r) => r.ticker === tk);
    return { buyPrice, sellPrice, sale: { qty: sale.qty, proceeds: sale.proceeds, basis: sale.basis, gain: sale.gain, term: sale.term, desc: sale.description, chain: sale.chain },
             tokenLeft: walletLedger[W][tk].reduce((s, l) => s + l.remaining, 0),
             xrpLots: walletLedger[W].XRP.filter((l) => l.source === 'dex_buy').map((l) => ({ qty: l.qty, unitCost: l.unitCost, date: l.date })),
             role: ledgerTradeLog[1].role, rows: allDisposalsHigh.length };
  }, { W, MINTER, hb: H('C'), hs: H('D') });
  expect(out.sale.qty).toBeCloseTo(200, 9);
  expect(out.sale.proceeds).toBeCloseTo(150 * out.sellPrice, 2);          // what the XRP received was worth
  expect(out.sale.basis).toBeCloseTo(100 * out.buyPrice * (200 / 250), 2); // 200 of the 250 bought
  expect(out.sale.gain).toBeCloseTo(out.sale.proceeds - out.sale.basis, 2);
  expect(out.sale.term).toBe('LT');                                        // bought 2024-01-15, sold 2025-03-02
  expect(out.sale.desc).toBe('200.0000 ABC (rTESTto…) (DEX)');
  expect(out.sale.chain).toBe('XRPL');
  expect(out.tokenLeft).toBeCloseTo(50, 9);
  expect(out.xrpLots).toEqual([{ qty: 150, unitCost: out.sellPrice, date: '2025-03-02' }]);
  expect(out.role).toBe('affected');
  expect(out.rows).toBe(2);                                                // the XRP sold to buy, and the token sold
});

test('a transaction with a ledger row is booked once, from the ledger row', async () => {
  const out = await window.evaluate(({ W, h }) => {
    const { ws, helpers } = freshEngine([W]);
    ledgerAdd(W, 'XRP', '2023-01-10', 1000, 0.40, 'received');
    // The download's view: an offer to sell 500 XRP. The ledger's view: 100 XRP actually traded.
    const cacheRow = { TransactionType: 'OfferCreate', TransactionResult: 'tesSUCCESS', Account: W, Destination: '', Timestamp: '2025-03-02 10:00:00',
                       TransactionHash: h, TakerGets_XRP: '500', Amount_XRP: '', delivered_amount_XRP: '' };
    ledgerTradeIndex.keys.set(W, new Set([h]));
    ledgerTradeIndex.through.set(W, parseWinDbTs('2025-06-01 00:00:00'));
    processOneXRPLRow(cacheRow, W, ws, 'out', helpers);
    const afterCache = allDisposalsHigh.length;
    processOneXRPLRow(ledgerRow(mkEntry({ hash: h, iso: '2025-03-02T10:00:00Z', type: 'OfferCreate', account: W, xrp: [1000, 899.999988], lines: [{ cur: 'ABC', before: 0, after: 250 }] })), W, ws, 'out', helpers);
    return { afterCache, qty: allDisposalsHigh.map((r) => r.qty), replaced: ledgerTradeStats.replaced };
  }, { W, h: H('E') });
  expect(out.afterCache).toBe(0);
  expect(out.qty).toHaveLength(1);
  expect(out.qty[0]).toBeCloseTo(100, 6);
  expect(out.replaced).toBe(1);
});

test('an offer that did not trade is not a sale inside the range read, and is booked as before outside it', async () => {
  const out = await window.evaluate(({ W, h1, h2 }) => {
    const { ws, helpers } = freshEngine([W]);
    ledgerAdd(W, 'XRP', '2023-01-10', 5000, 0.40, 'received');
    const offer = (hash, ts) => ({ TransactionType: 'OfferCreate', TransactionResult: 'tesSUCCESS', Account: W, Destination: '', Timestamp: ts,
                                   TransactionHash: hash, TakerGets_XRP: '500', Amount_XRP: '', delivered_amount_XRP: '' });
    ledgerTradeIndex.through.set(W, parseWinDbTs('2025-06-01 00:00:00'));
    processOneXRPLRow(offer(h1, '2025-03-02 10:00:00'), W, ws, 'out', helpers);   // inside: rested, never traded
    const inside = allDisposalsHigh.length;
    processOneXRPLRow(offer(h2, '2025-07-02 10:00:00'), W, ws, 'out', helpers);   // after the range: not read yet
    return { inside, after: allDisposalsHigh.map((r) => r.qty), notFilled: ledgerTradeStats.offersNotFilled, xrp: ledgerTradeStats.offersNotFilledXrp };
  }, { W, h1: H('1'), h2: H('2') });
  expect(out.inside).toBe(0);
  expect(out.after).toEqual([500]);
  expect(out.notFilled).toBe(1);
  expect(out.xrp).toBe(500);
});

test('a token with no XRP side changes quantities only: never on Form 8949, basis and dates kept between own wallets', async () => {
  const out = await window.evaluate(({ W, W2, MINTER, OTHER, h }) => {
    const { ws, helpers } = freshEngine([W, W2]);
    const tk = 'ABC.' + MINTER;
    const send = (hash, dest, before, after) => mkEntry({ hash, iso: '2025-03-02T10:00:00Z', type: 'Payment', account: W, dest, xrp: [50, 49.999988], lines: [{ cur: 'ABC', before, after }] });
    // 1. arrives from a stranger: a dated lot at $0
    processOneXRPLRow(ledgerRow(mkEntry({ hash: h[0], iso: '2024-01-15T10:00:00Z', type: 'Payment', account: OTHER, dest: W, lines: [{ cur: 'ABC', before: 0, after: 1000 }] })), W, ws, 'out', helpers);
    const arrived = walletLedger[W][tk].map((l) => ({ qty: l.qty, unitCost: l.unitCost, date: l.date, source: l.source }));
    // 2. moved to the other own wallet: lots go across; the receiving side's row does not add them again
    const move = send(h[1], W2, 1000, 600);
    ledgerTradeIndex.keys.set(W, new Set([h[1]]));
    processOneXRPLRow(ledgerRow(move), W, ws, 'out', helpers);
    const recv = { ...move, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [{ ModifiedNode: { LedgerEntryType: 'RippleState',
      FinalFields: { Balance: { currency: 'ABC', value: '400' }, LowLimit: { issuer: W2 }, HighLimit: { issuer: MINTER } }, PreviousFields: { Balance: { currency: 'ABC', value: '0' } } } }] } };
    processOneXRPLRow(ledgerRow(recv, W2), W2, ws, 'out', helpers);
    const atW2 = walletLedger[W2][tk].map((l) => ({ qty: l.qty, date: l.date, source: l.source }));
    // 3. sent back to the issuer, 4. sent to a stranger
    processOneXRPLRow(ledgerRow(send(h[2], MINTER, 600, 500)), W, ws, 'out', helpers);
    processOneXRPLRow(ledgerRow(send(h[3], OTHER, 500, 450)), W, ws, 'out', helpers);
    return { arrived, atW2, leftW: walletLedger[W][tk].reduce((s, l) => s + l.remaining, 0), disposals: allDisposalsHigh.length, income: allIncomeRows.length,
             kinds: ledgerTradeLog.map((l) => l.kind), stats: { tokenIn: ledgerTradeStats.tokenIn, tokenOut: ledgerTradeStats.tokenOut, transfers: ledgerTradeStats.transfers } };
  }, { W, W2, MINTER, OTHER, h: [H('3'), H('4'), H('5'), H('6')] });
  expect(out.arrived).toEqual([{ qty: 1000, unitCost: 0, date: '2024-01-15', source: 'token_received' }]);
  expect(out.atW2).toEqual([{ qty: 400, date: '2024-01-15', source: 'transfer_in' }]);   // original date carried, counted once
  expect(out.leftW).toBeCloseTo(450, 9);
  expect(out.disposals).toBe(0);
  expect(out.income).toBe(0);
  expect(out.kinds).toEqual(['token_in', 'transfer_out', 'transfer_in', 'to_issuer', 'sent_unvalued']);
  expect(out.stats).toEqual({ tokenIn: 1, tokenOut: 2, transfers: 1 });
});

test('AMM records are stored but not booked, and a token has no made-up price', async () => {
  const out = await window.evaluate(({ W, MINTER, h }) => {
    const { ws, helpers } = freshEngine([W]);
    ledgerAdd(W, 'XRP', '2023-01-10', 1000, 0.40, 'received');
    processOneXRPLRow(ledgerRow(mkEntry({ hash: h, iso: '2025-03-02T10:00:00Z', type: 'AMMDeposit', account: W, xrp: [1000, 900], lines: [{ cur: '03' + 'AB'.repeat(19), before: 0, after: 5 }] })), W, ws, 'out', helpers);
    ledgerAdd(W, 'ABC.' + MINTER, '2025-01-01', 10, 0, 'token_received');
    const hold = computeHoldings().find((x) => x.ticker === 'ABC.' + MINTER);
    return { disposals: allDisposalsHigh.length, amm: ledgerTradeStats.amm, xrp: walletLedger[W].XRP[0].remaining, price: latestPriceFor('ABC.' + MINTER), value: hold.value,
             html: ledgerTradesDisclosureHTML() };
  }, { W, MINTER, h: H('7') });
  expect(out.disposals).toBe(0);
  expect(out.amm).toBe(1);
  expect(out.xrp).toBe(1000);
  expect(out.price).toEqual({ price: 0, asOf: null });
  expect(out.value).toBe(0);
  expect(out.html).toContain('stored but not booked (Standard treatment)');
});

// ── The sweep, end to end ──────────────────────────────────────────────

test('the sweep stores what moved, records how far it read, and the rebuilt report books the trade once', async () => {
  const out = await window.evaluate(async ({ W, W2, MINTER, OTHER, hOffer, hFill, hRest }) => {
    await window.taxDB.clearAll();
    WALLETS.length = 0; WALLETS.push(W, W2);
    const text = (hash) => hash;   // the download stores the hash as text
    await window.taxDB.insertRows(W, 'XRPL', [
      { tx_hash: 'IN1', timestamp: '2023-01-10 10:00:00', raw_json: JSON.stringify({ TransactionType: 'Payment', TransactionResult: 'tesSUCCESS', Account: OTHER, Destination: W,
          Timestamp: '2023-01-10 10:00:00', TransactionHash: 'F'.repeat(64), Amount_XRP: '5000', delivered_amount_XRP: '5000' }) },
      // Offered 500 XRP; the ledger shows 100 traded.
      { tx_hash: makeTxHash({ TransactionHash: text(hOffer) }, '', W), timestamp: '2025-03-02 10:00:00', raw_json: JSON.stringify({ TransactionType: 'OfferCreate', TransactionResult: 'tesSUCCESS',
          Account: W, Destination: '', Timestamp: '2025-03-02 10:00:00', TransactionHash: text(hOffer), TakerGets_XRP: '500' }) },
      // Offered 300 XRP; never traded.
      { tx_hash: makeTxHash({ TransactionHash: text(hRest) }, '', W), timestamp: '2025-03-05 10:00:00', raw_json: JSON.stringify({ TransactionType: 'OfferCreate', TransactionResult: 'tesSUCCESS',
          Account: W, Destination: '', Timestamp: '2025-03-05 10:00:00', TransactionHash: text(hRest), TakerGets_XRP: '300' }) },
    ]);
    const txs = [
      mkEntry({ hash: 'F'.repeat(64), iso: '2023-01-10T10:00:00Z', type: 'Payment', account: OTHER, dest: W, xrp: [0, 5000] }),
      mkEntry({ hash: hOffer, iso: '2025-03-02T10:00:00Z', type: 'OfferCreate', account: W, xrp: [5000, 4899.999988], lines: [{ cur: 'ABC', before: 0, after: 250 }] }),
      mkEntry({ hash: hRest, iso: '2025-03-05T10:00:00Z', type: 'OfferCreate', account: W, xrp: [4899.999988, 4899.999976] }),
      mkEntry({ hash: hFill, iso: '2025-04-01T10:00:00Z', type: 'OfferCreate', account: OTHER, xrp: [4899.999976, 5049.999976], lines: [{ cur: 'ABC', before: 250, after: 50 }] }),
    ];
    const calls = [];
    let validated = 95000000;
    const saved = chainRpcCall;
    chainRpcCall = async (req) => {
      calls.push({ method: req.method, account: req.params.account, min: req.params.ledger_index_min, max: req.params.ledger_index_max, marker: req.params.marker || null, claim: req.claim || null });
      if (req.method === 'ledger') return { ledger_index: validated, ledger: { ledger_index: String(validated), close_time: Math.floor(Date.parse('2025-06-01T00:00:00Z') / 1000) - 946684800 } };
      if (req.method === 'account_tx') {
        if (req.params.account === W2) return { notFound: true };
        if (req.params.ledger_index_min !== -1) return { ledger_index_min: req.params.ledger_index_min, ledger_index_max: req.params.ledger_index_max, transactions: [] };
        // two pages, to exercise the marker
        return req.params.marker ? { ledger_index_min: 32570, ledger_index_max: validated, transactions: txs.slice(2) }
                                 : { ledger_index_min: 32570, ledger_index_max: validated, transactions: txs.slice(0, 2), marker: { ledger: 1, seq: 2 } };
      }
      return { error: 'unexpected' };
    };
    try {
      const first = await sweepLedgerTrades();
      const sweeps = await window.taxDB.getLedgerSweeps();
      const keys = (await window.taxDB.getLedgerTradeKeys('XRPL')).map((k) => k.tx_hash).sort();
      const tk = 'ABC.' + MINTER;
      const report = {
        disposals: allDisposalsHigh.map((r) => ({ ticker: r.ticker, qty: r.qty, year: r.year })),
        tokenLeft: walletLedger[W][tk].reduce((s, l) => s + l.remaining, 0),
        xrpLeft: walletLedger[W].XRP.reduce((s, l) => s + l.remaining, 0),
        stats: { ...ledgerTradeStats }, mismatch: ledgerCountMismatch, streamed: rowsStreamedThisBuild,
        panel: document.getElementById('ledgerTradesStats').innerText,
      };
      const firstCalls = calls.length;
      validated = 95000500;
      const second = await sweepLedgerTrades();
      const secondCall = calls.slice(firstCalls).find((c) => c.method === 'account_tx');
      const sweeps2 = await window.taxDB.getLedgerSweeps();
      return { first, sweeps, keys, report, second, secondCall, sweeps2, claims: calls.filter((c) => c.claim).length, firstAccountTx: calls.filter((c) => c.method === 'account_tx').slice(0, 2) };
    } finally { chainRpcCall = saved; }
  }, { W, W2, MINTER, OTHER, hOffer: H('8'), hFill: H('9'), hRest: H('A') });

  expect(out.first.failed).toEqual([]);
  expect(out.first.wallets).toBe(1);
  expect(out.first.notOnXrpl).toBe(1);
  expect(out.first.txs).toBe(4);
  expect(out.first.stored).toBe(2);
  expect(out.keys).toEqual(['LEDGER:' + H('8'), 'LEDGER:' + H('9')]);
  expect(out.sweeps).toHaveLength(1);
  expect(out.sweeps[0]).toMatchObject({ wallet: W, chain: 'XRPL', through_ledger: 95000000, through_ts: '2025-06-01 00:00:00', txs: 4, stored: 2 });
  expect(out.firstAccountTx[0]).toMatchObject({ min: -1, max: 95000000, marker: null });
  expect(out.firstAccountTx[1].marker).toEqual({ ledger: 1, seq: 2 });
  // The report: 100 XRP sold to buy (not 500), the 300 XRP offer not a sale, 200 ABC sold for 150 XRP.
  expect(out.report.disposals).toHaveLength(2);
  expect(out.report.disposals[0].ticker).toBe('XRP');
  expect(out.report.disposals[0].qty).toBeCloseTo(100, 6);
  expect(out.report.disposals[1]).toMatchObject({ ticker: 'ABC.' + MINTER, year: 2025 });
  expect(out.report.disposals[1].qty).toBeCloseTo(200, 9);
  expect(out.report.tokenLeft).toBeCloseTo(50, 9);
  expect(out.report.xrpLeft).toBeCloseTo(5050, 6);          // 5000 - 100 + 150: matches the ledger less fees
  expect(out.report.stats).toMatchObject({ rows: 2, buys: 1, sells: 1, replaced: 1, offersNotFilled: 1, offersNotFilledXrp: 300 });
  expect(out.report.mismatch).toBeNull();
  expect(out.report.streamed).toBe(5);                      // 3 from the download + 2 from the ledger
  expect(out.report.panel).toContain('1 wallet(s) read through 2025-06-01 00:00:00 UTC');
  expect(out.report.panel).toContain('1 purchase(s), 1 sale(s), 1 offer(s) that did not trade');
  // A second read starts just after the first one ended.
  expect(out.secondCall).toMatchObject({ account: W, min: 95000001, max: 95000500 });
  expect(out.sweeps2[0]).toMatchObject({ through_ledger: 95000500, txs: 4, stored: 2 });
  expect(out.claims).toBe(0);                               // public server: no Payment-Claim attached
});

test('a server without full history is refused, and nothing is recorded as read', async () => {
  const out = await window.evaluate(async ({ W }) => {
    await window.taxDB.clearAll();
    WALLETS.length = 0; WALLETS.push(W);
    const saved = chainRpcCall;
    chainRpcCall = async (req) => req.method === 'ledger'
      ? { ledger_index: 95000000, ledger: { close_time: 800000000 } }
      : { ledger_index_min: 80000000, ledger_index_max: 95000000, transactions: [] };
    try {
      const r = await sweepLedgerTrades();
      return { failed: r.failed, sweeps: await window.taxDB.getLedgerSweeps(), changed: r.changed };
    } finally { chainRpcCall = saved; }
  }, { W });
  expect(out.failed).toHaveLength(1);
  expect(out.failed[0].error).toMatch(/full history/);
  expect(out.sweeps).toEqual([]);
  expect(out.changed).toBe(false);
});

test('a read that fails part-way resumes from the ledger it reached, and claims nothing until it finishes', async () => {
  const out = await window.evaluate(async ({ W, OTHER, h }) => {
    await window.taxDB.clearAll();
    await window.taxDB.setMeta('ledgerTradesPartial', '');
    WALLETS.length = 0; WALLETS.push(W);
    const tok = (hash, iso, ledger, before, after) => { const e = mkEntry({ hash, iso, type: 'Payment', account: OTHER, dest: W, lines: [{ cur: 'ABC', before, after }] }); e.ledger_index = ledger; return e; };
    const pages = [[tok(h[0], '2024-01-01T00:00:00Z', 70000001, 0, 10), tok(h[1], '2024-01-02T00:00:00Z', 70000002, 10, 20)],
                   [tok(h[1], '2024-01-02T00:00:00Z', 70000002, 10, 20), tok(h[2], '2024-01-03T00:00:00Z', 70000003, 20, 30)]];
    let failSecond = true;
    const calls = [];
    const saved = chainRpcCall;
    chainRpcCall = async (req) => {
      if (req.method === 'ledger') return { ledger_index: 95000000, ledger: { close_time: Math.floor(Date.parse('2025-06-01T00:00:00Z') / 1000) - 946684800 } };
      calls.push({ min: req.params.ledger_index_min, marker: !!req.params.marker });
      if (req.params.marker) { if (failSecond) return { error: 'unreachable', error_message: 'timed out' }; }
      // From the start: page 1 then a marker. Resumed from ledger 70000002: the rest, no marker.
      if (req.params.ledger_index_min === -1 && !req.params.marker) return { ledger_index_min: 32570, ledger_index_max: 95000000, transactions: pages[0], marker: { ledger: 70000002, seq: 1 } };
      return { ledger_index_min: req.params.ledger_index_min, ledger_index_max: 95000000, transactions: pages[1] };
    };
    try {
      const first = await sweepLedgerTrades();
      const afterFail = { failed: first.failed.length, sweeps: (await window.taxDB.getLedgerSweeps()).length,
                          partial: JSON.parse(await window.taxDB.getMeta('ledgerTradesPartial'))[W] };
      failSecond = false;
      const second = await sweepLedgerTrades();
      return { afterFail, second: { failed: second.failed, stored: second.stored }, resumeCall: calls[calls.length - 1],
               sweeps: await window.taxDB.getLedgerSweeps(), keys: (await window.taxDB.getLedgerTradeKeys('XRPL')).length,
               partialAfter: JSON.parse((await window.taxDB.getMeta('ledgerTradesPartial')) || '{}')[W] || null };
    } finally { chainRpcCall = saved; }
  }, { W, OTHER, h: [H('C'), H('D'), H('E')] });
  expect(out.afterFail.failed).toBe(1);
  expect(out.afterFail.sweeps).toBe(0);                        // not recorded as read
  expect(out.afterFail.partial).toMatchObject({ ledger: 70000002, txs: 2, stored: 2 });
  expect(out.second.failed).toEqual([]);
  expect(out.resumeCall).toEqual({ min: 70000002, marker: false });
  expect(out.second.stored).toBe(3);                            // 2 from before + 1 new; the re-read one not counted twice
  expect(out.keys).toBe(3);
  expect(out.sweeps[0]).toMatchObject({ through_ledger: 95000000, stored: 3 });
  expect(out.partialAfter).toBeNull();
});

test('removing what was read puts the old booking back', async () => {
  const out = await window.evaluate(async ({ W, OTHER, h }) => {
    await window.taxDB.clearAll();
    WALLETS.length = 0; WALLETS.push(W);
    await window.taxDB.insertRows(W, 'XRPL', [
      { tx_hash: 'IN1', timestamp: '2023-01-10 10:00:00', raw_json: JSON.stringify({ TransactionType: 'Payment', TransactionResult: 'tesSUCCESS', Account: OTHER, Destination: W,
          Timestamp: '2023-01-10 10:00:00', TransactionHash: 'F'.repeat(64), Amount_XRP: '5000', delivered_amount_XRP: '5000' }) },
      { tx_hash: makeTxHash({ TransactionHash: h }, '', W), timestamp: '2025-03-05 10:00:00', raw_json: JSON.stringify({ TransactionType: 'OfferCreate', TransactionResult: 'tesSUCCESS',
          Account: W, Destination: '', Timestamp: '2025-03-05 10:00:00', TransactionHash: h, TakerGets_XRP: '300' }) },
    ]);
    await window.taxDB.setLedgerSweep({ wallet: W, chain: 'XRPL', through_ledger: 95000000, through_ts: '2025-06-01 00:00:00', txs: 2, stored: 0 });
    await buildReportFromCache({ silent: true });
    const withSweep = allDisposalsHigh.length;
    const realConfirm = window.confirm; window.confirm = () => true;
    try { await clearLedgerTradesUI(); } finally { window.confirm = realConfirm; }
    return { withSweep, after: allDisposalsHigh.map((r) => r.qty), sweeps: await window.taxDB.getLedgerSweeps() };
  }, { W, OTHER, h: H('B') });
  expect(out.withSweep).toBe(0);
  expect(out.after).toEqual([300]);
  expect(out.sweeps).toEqual([]);
});
