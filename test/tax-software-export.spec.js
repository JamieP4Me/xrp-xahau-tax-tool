// test/tax-software-export.spec.js — regression test for the Koinly /
// CoinLedger CSV export feature (buildRelevantTaxRows() + koinlyRow() /
// coinLedgerRow() in renderer/index.html).
//
// The user asked for a CSV they can import into Koinly.io or CoinLedger.io
// that skips everything those tools don't need — trustline/account-setting
// housekeeping, and transfers between the user's own wallets (which never
// cross the "my funds" boundary those tools tax on). This test seeds a
// small synthetic cache covering every category buildRelevantTaxRows() has
// to tell apart, then checks it kept exactly the right rows and dropped the
// rest:
//   - an external Xahau (XAH) deposit and withdrawal          → kept
//   - an EVR "reward" deposit (this app's only income case)   → kept, tagged
//   - a Xahau OfferCreate DEX trade (XAH -> EVR)               → kept
//   - an external XRPL (XRP) deposit and withdrawal            → kept
//   - a Payment between two of the user's OWN wallets          → dropped
//   - a TrustSet (no economic value)                           → dropped
//   - an XRPL OfferCreate (cached data can't capture the        → dropped,
//     received side of an XRPL DEX trade, so it can't be          counted
//     represented correctly)                                      separately
//
// It also spot-checks the two per-platform row formatters: Koinly's Tag
// column gets "reward" only on the EVR income row, and CoinLedger's date
// column is correctly reformatted from WinDB's "YYYY-MM-DD HH:mm:ss" to
// its own "MM/DD/YYYY HH:mm:ss".

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_DIR = path.join(__dirname, '..');

test('Koinly/CoinLedger export keeps only tax-relevant rows and drops internal transfers + noise', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrp-xahau-taxexport-e2e-'));

  const app = await electron.launch({
    args: [APP_DIR, '--user-data-dir=' + path.join(userDataDir, 'electron-profile')],
    cwd: APP_DIR,
    env: { ...process.env, HOME: userDataDir },
  });

  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    const result = await win.evaluate(async () => {
      const wA = 'wTaxA';      // the wallet under test, both chains
      const wB = 'wTaxB';      // a second owned wallet, for the internal-transfer case
      const extIn1 = 'wExtSender1', extOut1 = 'wExtRecipient1';
      const extIn2 = 'wExtSender2';    // EVR reward sender
      const extIn3 = 'wExtSender3', extOut2 = 'wExtRecipient2'; // XRPL counterparties
      const extIn4 = 'wExtSender4';    // deposit into wB, just so wB shows up as "owned"

      const mkPayment = (hash, ts, src, dest, opts) => ({
        tx_hash: hash, timestamp: ts, raw_json: JSON.stringify({
          Account: src, Destination: dest, TransactionType: 'Payment',
          TransactionResult: 'tesSUCCESS', Timestamp: ts, TransactionHash: hash,
          delivered_amount_XRP: opts.xrp ?? '', delivered_amount_value: opts.val ?? '',
          delivered_amount_currency: opts.cur ?? '',
          Amount_XRP: opts.xrp ?? '', Amount_value: opts.val ?? '', Amount_currency: opts.cur ?? '',
        }),
      });

      await window.taxDB.clearWalletChain(wA, 'Xahau');
      await window.taxDB.clearWalletChain(wB, 'Xahau');
      await window.taxDB.clearWalletChain(wA, 'XRPL');

      await window.taxDB.insertRows(wA, 'Xahau', [
        // 1. External deposit (acquisition) — kept
        mkPayment('TX1', '2025-01-01 00:00:00', extIn1, wA, { xrp: '100' }),
        // 2. External withdrawal (disposal) — kept
        mkPayment('TX2', '2025-02-01 00:00:00', wA, extOut1, { xrp: '50' }),
        // 3. Internal transfer to wB (both owned) — dropped
        mkPayment('TX3', '2025-03-01 00:00:00', wA, wB, { xrp: '20' }),
        // 4. EVR reward inbound — kept, income
        mkPayment('TX4', '2025-04-01 00:00:00', extIn2, wA, { val: '5', cur: 'EVR' }),
        // 5. Xahau DEX trade (OfferCreate): sell 10 XAH, buy 2 EVR — kept
        {
          tx_hash: 'TX5', timestamp: '2025-05-01 00:00:00', raw_json: JSON.stringify({
            Account: wA, TransactionType: 'OfferCreate', TransactionResult: 'tesSUCCESS',
            Timestamp: '2025-05-01 00:00:00', TransactionHash: 'TX5',
            TakerGets_XRP: '10', TakerGets_value: '', TakerGets_currency: '',
            TakerPays_XRP: '', TakerPays_value: '2', TakerPays_currency: 'EVR',
          }),
        },
        // 6. TrustSet — no economic value — dropped (not even counted as skipped)
        {
          tx_hash: 'TX6', timestamp: '2025-06-01 00:00:00', raw_json: JSON.stringify({
            Account: wA, TransactionType: 'TrustSet', TransactionResult: 'tesSUCCESS',
            Timestamp: '2025-06-01 00:00:00', TransactionHash: 'TX6',
          }),
        },
      ]);

      await window.taxDB.insertRows(wB, 'Xahau', [
        // 10. External deposit into wB — kept; also what makes wB "owned"
        mkPayment('TX10', '2025-10-01 00:00:00', extIn4, wB, { xrp: '7' }),
      ]);

      await window.taxDB.insertRows(wA, 'XRPL', [
        // 7. External XRPL deposit, 5 XRP — kept.
        // NOTE: WinDB's XRPL Amount_XRP is in WHOLE XRP, not drops — verified
        // against the real cache (see xah-units-check.py and the comment in
        // processOneXRPLRow). This fixture originally used 5000000 "drops",
        // which was wrong in the same way the app's own /1e6 was.
        mkPayment('TX7', '2025-07-01 00:00:00', extIn3, wA, { xrp: '5' }),
        // 8. External XRPL withdrawal, 3 XRP — kept
        mkPayment('TX8', '2025-08-01 00:00:00', wA, extOut2, { xrp: '3' }),
        // 9. XRPL OfferCreate — dropped, counted as skippedXrplDex
        {
          tx_hash: 'TX9', timestamp: '2025-09-01 00:00:00', raw_json: JSON.stringify({
            Account: wA, TransactionType: 'OfferCreate', TransactionResult: 'tesSUCCESS',
            Timestamp: '2025-09-01 00:00:00', TransactionHash: 'TX9',
            TakerGets_XRP: '2',
          }),
        },
      ]);

      for (const [w, chain] of [[wA,'Xahau'],[wB,'Xahau'],[wA,'XRPL']]) {
        await window.taxDB.upsertSyncState(w, chain, '2025-12-31 00:00:00');
      }

      // Force a deterministic rebuild here, rather than relying on
      // buildRelevantTaxRows()'s own "rebuild if empty" fallback — the app's
      // silent startup rebuild (see the init block) already fired once on
      // page load, before any of this test's rows existed, and raced against
      // it here would just be timing-sensitive noise.
      await buildReportFromCache({ silent: true });
      const { rows, skippedXrplDex, totalScanned } = await buildRelevantTaxRows();

      // makeTxHash() hex-encodes TransactionHash's characters rather than
      // passing it through — reproduce that here so lookups below match.
      const hex = s => [...s].map(c => c.charCodeAt(0).toString(16).padStart(2,'0')).join('').toUpperCase();
      const byHash = Object.fromEntries(rows.map(r => [r.txHash, r]));
      const H = { TX1: hex('TX1'), TX2: hex('TX2'), TX3: hex('TX3'), TX4: hex('TX4'), TX5: hex('TX5'),
        TX6: hex('TX6'), TX7: hex('TX7'), TX8: hex('TX8'), TX9: hex('TX9'), TX10: hex('TX10') };

      return {
        totalScanned,
        skippedXrplDex,
        rowCount: rows.length,
        hashesPresentCount: Object.keys(byHash).length,
        deposit1: byHash[H.TX1] && { kind: byHash[H.TX1].kind, ticker: byHash[H.TX1].receivedTicker, amt: byHash[H.TX1].receivedAmount },
        withdrawal2: byHash[H.TX2] && { kind: byHash[H.TX2].kind, ticker: byHash[H.TX2].sentTicker, amt: byHash[H.TX2].sentAmount },
        internalTransferPresent: !!byHash[H.TX3],
        income4: byHash[H.TX4] && { isIncome: byHash[H.TX4].isIncome, ticker: byHash[H.TX4].receivedTicker, amt: byHash[H.TX4].receivedAmount },
        trade5: byHash[H.TX5] && { sent: [byHash[H.TX5].sentTicker, byHash[H.TX5].sentAmount], recv: [byHash[H.TX5].receivedTicker, byHash[H.TX5].receivedAmount] },
        trustSetPresent: !!byHash[H.TX6],
        xrplDeposit7: byHash[H.TX7] && { ticker: byHash[H.TX7].receivedTicker, amt: byHash[H.TX7].receivedAmount },
        xrplWithdrawal8: byHash[H.TX8] && { ticker: byHash[H.TX8].sentTicker, amt: byHash[H.TX8].sentAmount },
        xrplOfferPresent: !!byHash[H.TX9],
        deposit10Present: !!byHash[H.TX10],
        koinlyIncomeRow: koinlyRow(byHash[H.TX4]),
        coinLedgerIncomeRow: coinLedgerRow(byHash[H.TX4]),
        coinLedgerDeposit1Row: coinLedgerRow(byHash[H.TX1]),
      };
    });

    expect(result.totalScanned).toBe(10); // TX1..TX10 all cached, all tesSUCCESS
    expect(result.skippedXrplDex).toBe(1); // TX9
    expect(result.rowCount).toBe(7); // TX1,TX2,TX4,TX5,TX7,TX8,TX10
    expect(result.hashesPresentCount).toBe(7);

    expect(result.deposit1).toEqual({ kind:'deposit', ticker:'XAH', amt:100 });
    expect(result.withdrawal2).toEqual({ kind:'withdrawal', ticker:'XAH', amt:50 });
    expect(result.internalTransferPresent).toBe(false);
    expect(result.income4).toEqual({ isIncome:true, ticker:'EVR', amt:5 });
    expect(result.trade5).toEqual({ sent:['XAH',10], recv:['EVR',2] });
    expect(result.trustSetPresent).toBe(false);
    expect(result.xrplDeposit7).toEqual({ ticker:'XRP', amt:5 });
    expect(result.xrplWithdrawal8).toEqual({ ticker:'XRP', amt:3 });
    expect(result.xrplOfferPresent).toBe(false);
    expect(result.deposit10Present).toBe(true);

    // Koinly: Tag column ("reward") is the 10th of 12 comma-separated fields.
    expect(result.koinlyIncomeRow.split(',')[9]).toBe('reward');
    // CoinLedger: Type column ("Income") is the 9th of 11 fields.
    expect(result.coinLedgerIncomeRow.split(',')[8]).toBe('Income');
    // CoinLedger date reformatted from "2025-01-01 00:00:00" to "01/01/2025 00:00:00".
    // Unquoted: fields now go through csvField(), which only quotes when the
    // value actually contains a comma, quote or newline (a date contains none).
    expect(result.coinLedgerDeposit1Row.split(',')[0]).toBe('01/01/2025 00:00:00');
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('a gift is exported tagged, so Koinly and CoinLedger do not re-create the phantom sale', async () => {
  // Fixing Form 8949 inside this app is only half the job: the user also
  // imports into Koinly/CoinLedger, and those tools apply the same rule —
  // an outgoing transfer to an address they do not recognise is a taxable
  // disposal at market value. An untagged gift row reproduces the exact
  // overstatement in the other tool.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xrp-xahau-giftexport-'));
  const app = await electron.launch({ args: [APP_DIR, '--user-data-dir=' + path.join(home, 'electron-profile')], cwd: APP_DIR, env: { ...process.env, HOME: home } });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    const r = await win.evaluate(async () => {
      const mine = 'wExportGiftDonor';
      const daughter = 'rExportDaughterAddress';
      const buyer = 'rExportRealBuyer';
      await window.taxDB.clearWalletChain(mine, 'XRPL');
      const pay = (h, ts, from, to, amt) => ({
        tx_hash: h, timestamp: ts, raw_json: JSON.stringify({
          Account: from, Destination: to, TransactionType: 'Payment',
          TransactionResult: 'tesSUCCESS', Timestamp: ts, TransactionHash: h,
          delivered_amount_XRP: String(amt), Amount_XRP: String(amt),
          Amount_value: '', Amount_currency: '' }) });
      await window.taxDB.insertRows(mine, 'XRPL', [
        pay('EBUY', '2023-01-10 10:00:00', 'rExchangeWithdrawal', mine, 20000),
        pay('EGIFT', '2025-03-15 10:00:00', mine, daughter, 6000),
        pay('ESALE', '2025-04-15 10:00:00', mine, buyer, 1000),
      ]);
      await window.taxDB.upsertSyncState(mine, 'XRPL', '2025-12-31 00:00:00');
      giftAddresses.length = 0; transferOnlyAddresses.length = 0;
      setGiftAddress(daughter, 'Daughter One');

      const { rows } = await buildRelevantTaxRows();
      const gift = rows.find(x => x.txHash && x.description.includes('GIFT'));
      const sale = rows.find(x => x.kind === 'withdrawal' && !x.isGift);
      const out = {
        giftTagKoinly: gift ? koinlyRow(gift).split(',')[9] : null,
        giftTypeCoinLedger: gift ? coinLedgerRow(gift).split(',')[8] : null,
        saleTagKoinly: sale ? koinlyRow(sale).split(',')[9] : null,
        saleTypeCoinLedger: sale ? coinLedgerRow(sale).split(',')[8] : null,
        giftRecipientInDescription: gift ? gift.description.includes('Daughter One') : false,
      };
      giftAddresses.length = 0;
      return out;
    });

    // The gift carries each tool's own non-taxable outgoing-gift label...
    expect(r.giftTagKoinly).toBe('gift');
    expect(r.giftTypeCoinLedger).toBe('Gift Sent');
    expect(r.giftRecipientInDescription).toBe(true);

    // ...and a genuine sale is still left unlabelled, i.e. taxable.
    expect(r.saleTagKoinly).toBe('');
    expect(r.saleTypeCoinLedger).toBe('');
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('drainage from a lost wallet is exported as non-taxable in both tools', async () => {
  // Koinly's `lost` and CoinLedger's `Casualty Loss` both remove the asset
  // from the balance without realizing a gain or loss — the same treatment
  // the ledger applies. Without them, the involuntary drainage from these
  // accounts becomes a taxable sale on import, every year, until they empty.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xrp-xahau-lostexport-'));
  const app = await electron.launch({ args: [APP_DIR, '--user-data-dir=' + path.join(home, 'electron-profile')], cwd: APP_DIR, env: { ...process.env, HOME: home } });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    const r = await win.evaluate(async () => {
      const lost = 'wExportLostHost';
      await window.taxDB.clearWalletChain(lost, 'Xahau');
      const pay = (h, ts, from, to, amt) => ({
        tx_hash: h, timestamp: ts, raw_json: JSON.stringify({
          Account: from, Destination: to, TransactionType: 'Payment',
          TransactionResult: 'tesSUCCESS', Timestamp: ts, TransactionHash: h,
          delivered_amount_XRP: String(amt), Amount_XRP: String(amt),
          Amount_value: '', Amount_currency: '' }) });
      await window.taxDB.insertRows(lost, 'Xahau', [
        pay('LFUND', '2024-02-01 10:00:00', 'rExchangeWithdrawal', lost, 10000),
        pay('LREAL', '2024-03-01 10:00:00', lost, 'rSomeoneElse', 1000), // pre-loss, taxable
        pay('LDRAIN','2024-08-01 10:00:00', lost, 'rHookSink', 500),     // post-loss
      ]);
      await window.taxDB.upsertSyncState(lost, 'Xahau', '2025-12-31 00:00:00');
      lostWallets.length = 0; giftAddresses.length = 0; transferOnlyAddresses.length = 0;
      setLostWallet(lost, '2024-06-01', 'Test host');

      const { rows } = await buildRelevantTaxRows();
      const drain = rows.find(x => x.isLost);
      const real  = rows.find(x => x.kind === 'withdrawal' && !x.isLost);
      const out = {
        drainTagKoinly: drain ? koinlyRow(drain).split(',')[9] : null,
        drainTypeCoinLedger: drain ? coinLedgerRow(drain).split(',')[8] : null,
        drainFlagged: drain ? drain.description.includes('LOST wallet') : false,
        realTagKoinly: real ? koinlyRow(real).split(',')[9] : null,
        realTypeCoinLedger: real ? coinLedgerRow(real).split(',')[8] : null,
      };
      lostWallets.length = 0;
      return out;
    });

    expect(r.drainTagKoinly).toBe('lost');
    expect(r.drainTypeCoinLedger).toBe('Casualty Loss');
    expect(r.drainFlagged).toBe(true);

    // The payment made BEFORE access was lost is still exported as taxable.
    expect(r.realTagKoinly).toBe('');
    expect(r.realTypeCoinLedger).toBe('');
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
