// test/restart-persistence.spec.js — regression test for the "closed and
// reopened the app, and Form 8949 was empty again" bug report.
//
// Two independent things were wrong, and this test locks down both:
//
// 1. THE MAIN CAUSE: allDisposalsHigh/walletLedger/
//    the scanned-transaction count are plain in-memory JS state — nothing in the
//    renderer process survives a real app restart on its own. The only way
//    to repopulate them used to be runFetch(), which hard-requires a
//    Payment-Claim — so even a wallet set that was ALREADY 100% synced,
//    with literally nothing new to fetch, still showed an empty Form 8949
//    after every restart until the user pasted a fresh claim and clicked
//    Fetch again. Fixed by buildReportFromCache() (rebuilds everything from
//    the local SQLite cache, no claim, no network) running automatically
//    and silently right after the page loads — see the end of the <script>
//    block in renderer/index.html.
//
// 2. A SECONDARY BUG: main.js used to bind the local static server to an
//    OS-assigned port (`listen(0, ...)`), so the renderer's origin
//    (http://127.0.0.1:<port>) was DIFFERENT every single launch. Since the
//    wallet list and term overrides are saved to localStorage — which is
//    scoped per-origin — every restart silently wiped any customization to
//    those (the wallet cache itself was fine; it's keyed in SQLite by
//    wallet address, not by origin). Fixed by pinning the local server to a
//    fixed port (FIXED_LOCAL_SERVER_PORT in main.js).
//
// This test drives the REAL Electron app across two separate launches
// sharing the same profile directory — i.e. an actual "quit and reopen",
// not a page reload — and checks both fixes hold.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_DIR = path.join(__dirname, '..');

test('after a real restart: cached data shows in Form 8949 with no fetch, and localStorage survives', async () => {
  const sharedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xrp-xahau-restart-e2e-'));
  const env = { ...process.env, HOME: sharedHome };
  // Both launches must land on the SAME profile — that is the whole point
  // of this test — so the directory is fixed once here. See the note in
  // tax-correctness.spec.js for why HOME alone does not isolate it.
  const profileArgs = [APP_DIR, '--user-data-dir=' + path.join(sharedHome, 'electron-profile')];

  // ── Launch 1: seed the local cache directly (as if a real fetch had
  // already happened) and customize localStorage-backed settings. ─────────
  const app1 = await electron.launch({ args: profileArgs, cwd: APP_DIR, env });
  try {
    const win1 = await app1.firstWindow();
    await win1.waitForLoadState('domcontentloaded');

    await win1.evaluate(async () => {
      const wallet = 'wRestartTestWallet';
      const chain = 'Xahau';
      await window.taxDB.clearWalletChain(wallet, chain); // clean slate if a stale run left something
      await window.taxDB.insertRows(wallet, chain, [
        {
          tx_hash: 'RESTART_ACQ',
          timestamp: '2025-03-01 00:00:00',
          raw_json: JSON.stringify({
            Account: 'wSomeExternalSender', Destination: wallet, TransactionType: 'Payment',
            TransactionResult: 'tesSUCCESS', Timestamp: '2025-03-01 00:00:00',
            TransactionHash: 'RESTART_ACQ',
            delivered_amount_XRP: '500', delivered_amount_value: '', delivered_amount_currency: '',
            Amount_XRP: '500', Amount_value: '', Amount_currency: '',
          }),
        },
        {
          tx_hash: 'RESTART_DISPOSE',
          timestamp: '2025-06-01 00:00:00',
          raw_json: JSON.stringify({
            Account: wallet, Destination: 'wSomeExternalRecipient', TransactionType: 'Payment',
            TransactionResult: 'tesSUCCESS', Timestamp: '2025-06-01 00:00:00',
            TransactionHash: 'RESTART_DISPOSE',
            delivered_amount_XRP: '500', delivered_amount_value: '', delivered_amount_currency: '',
            Amount_XRP: '500', Amount_value: '', Amount_currency: '',
          }),
        },
      ]);
      await window.taxDB.upsertSyncState(wallet, chain, '2025-06-01 00:00:00');

      // Customize the two localStorage-backed settings the port bug used to wipe.
      localStorage.setItem('walletList', JSON.stringify(['wRestartTestWallet', 'wSomeOtherCustomWallet']));
      localStorage.setItem('termOverrides', JSON.stringify({ RESTART_DISPOSE: 'LT' }));
    });
  } finally {
    await app1.close();
  }

  // ── Launch 2: a genuinely separate process, same profile dir — a real
  // "quit and reopen", not a page reload. ─────────────────────────────────
  const app2 = await electron.launch({ args: profileArgs, cwd: APP_DIR, env });
  try {
    const win2 = await app2.firstWindow();
    await win2.waitForLoadState('domcontentloaded');

    // The silent cache-load at startup is async (and now yields between
    // chunks) — wait for it to actually finish rather than racing it.
    await win2.waitForFunction(() => typeof transactionsScanned !== 'undefined' && transactionsScanned > 0, { timeout: 15000 });

    const result = await win2.evaluate(() => ({
      walletList: JSON.parse(localStorage.getItem('walletList') || 'null'),
      termOverrides: JSON.parse(localStorage.getItem('termOverrides') || 'null'),
      transactionCount: transactionsScanned,
      disposalFound: allDisposalsHigh.some(d => d.wallet === 'wRestartTestWallet' && d.ticker === 'XAH' && d.qty === 500),
      ledgerHasWallet: !!walletLedger['wRestartTestWallet'],
    }));

    expect(result.walletList).toEqual(['wRestartTestWallet', 'wSomeOtherCustomWallet']);
    expect(result.termOverrides).toEqual({ RESTART_DISPOSE: 'LT' });
    expect(result.transactionCount).toBeGreaterThan(0);
    expect(result.disposalFound).toBe(true);
    expect(result.ledgerHasWallet).toBe(true);
  } finally {
    await app2.close();
    fs.rmSync(sharedHome, { recursive: true, force: true });
  }
});
