// test/fifo-ordering.spec.js — regression test for the cross-wallet FIFO
// lot-ordering bug that used to be an explicitly documented, deliberately
// unfixed limitation of the desktop build (see README's "Known scope
// limitations" — since removed now that this is fixed).
//
// The bug: when three or more of the user's own wallets are selected and
// an asset is transferred in a chain (A → B → C), the app used to process
// each wallet's COMPLETE history before moving to the next one, in
// whatever order they happened to appear in the wallet list. If that order
// didn't match the real chronological order of the chain — e.g. C got
// processed before A had recorded the lot that eventually reaches C via
// B — the disposal from C would find no cost-basis lot available yet and
// silently fall back to $0 basis / unknown acquisition date, understating
// the real cost basis (and therefore overstating the gain) for no reason
// a user could see.
//
// The fix: processMergedXahauEntries() / processMergedXRPLEntries() (see
// renderer/index.html) merge every selected wallet's cached rows into ONE
// stream sorted by real transaction timestamp, and process that single
// stream once — so ledger state at any row is always exactly what really
// existed at that moment in time, regardless of wallet iteration order.
//
// This test proves the fix concretely: it drives the actual functions from
// the actual renderer (not a reimplementation) with a synthetic A→B→C XAH
// transfer chain plus an external disposal from C, and checks two things:
//   1. processWalletHistory() called per-wallet in the "wrong" (C, B, A)
//      order — the shape of the old bug, still reachable directly since
//      that function still backs the browser-only fallback path — DOES
//      reproduce $0 basis for C's disposal. This isn't a mistake in the
//      test; it's there so a future change can't silently "fix" this test
//      by breaking the merge path back to the old per-wallet approach
//      without anyone noticing the regression test stopped meaning anything.
//   2. processMergedXahauEntries(), fed the same four rows merged and
//      sorted by timestamp (exactly what fetchXahauWinDB() now does before
//      calling it), gets the real basis: 100 XAH acquired at $2.50/XAH,
//      carried through two internal transfers, disposed for $250 basis.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_DIR = path.join(__dirname, '..');

test('cross-wallet FIFO lot ordering: merged chronological processing fixes the old per-wallet bug', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrp-xahau-fifo-e2e-'));

  const app = await electron.launch({
    args: [APP_DIR, '--user-data-dir=' + path.join(userDataDir, 'electron-profile')],
    cwd: APP_DIR,
    env: { ...process.env, HOME: userDataDir },
  });

  try {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    const result = await window.evaluate(async () => {
      const wA = 'wSyntheticA', wB = 'wSyntheticB', wC = 'wSyntheticC', wEXT = 'wSyntheticEXT';
      const walletSet = new Set([wA, wB, wC]);

      // A synthetic price point far outside any real embedded price history,
      // so the result can't accidentally be right because of real market
      // data — it's only right if the lot actually carried through.
      XAH_PRICES['2030-01-01'] = { high: 2.5, low: 2.0 };

      const mkRow = (src, dest, ts, hash) => ({
        Account: src, Destination: dest, TransactionType: 'Payment',
        TransactionResult: 'tesSUCCESS', Timestamp: ts,
        TransactionHash: hash,
        delivered_amount_XRP: '100', delivered_amount_value: '', delivered_amount_currency: '',
        Amount_XRP: '100', Amount_value: '', Amount_currency: '',
      });

      const row1 = mkRow(wEXT, wA, '2030-01-01 00:00:00', 'H1'); // external → A (acquisition)
      const row2 = mkRow(wA, wB, '2030-01-02 00:00:00', 'H2');   // A → B (internal)
      const row3 = mkRow(wB, wC, '2030-01-03 00:00:00', 'H3');   // B → C (internal)
      const row4 = mkRow(wC, wEXT, '2030-01-04 00:00:00', 'H4'); // C → external (disposal)

      function resetState() {
        Object.keys(walletLedger).forEach(k => delete walletLedger[k]);
        allDisposalsHigh.length = 0;
        allIncomeRows.length = 0;
        allTransactionHistory.length = 0;
        transactionsScanned = 0;
      }

      // ── (1) Reproduce the shape of the old bug: each wallet's complete
      // history processed in isolation, in the "wrong" order relative to
      // the real transfer chain (C before B before A). ────────────────────
      resetState();
      processWalletHistory([row3, row4], wC, walletSet, 'out'); // C's own rows first — worst case
      processWalletHistory([row2, row3], wB, walletSet, 'out');
      processWalletHistory([row1, row2], wA, walletSet, 'out');
      const oldDisposal = allDisposalsHigh.find(d => d.wallet === wC);
      const oldBasis = oldDisposal ? oldDisposal.basis : null;

      // ── (2) The actual fix: one merged, timestamp-sorted pass across all
      // three wallets' cached rows — exactly what fetchXahauWinDB() builds
      // and feeds to processMergedXahauEntries() now. ─────────────────────
      resetState();
      const merged = [
        { row: row1, wallet: wA, mode: 'out' },
        { row: row2, wallet: wA, mode: 'out' },
        { row: row2, wallet: wB, mode: 'out' },
        { row: row3, wallet: wB, mode: 'out' },
        { row: row3, wallet: wC, mode: 'out' },
        { row: row4, wallet: wC, mode: 'out' },
      ];
      // Shuffle to a deliberately non-chronological, non-wallet-grouped
      // input order first, so the sort below is what's actually doing the
      // work — not an accidental pass-through of already-sorted input.
      const shuffled = [merged[4], merged[0], merged[5], merged[2], merged[1], merged[3]];
      shuffled.sort((a, b) => (a.row.Timestamp || '').localeCompare(b.row.Timestamp || ''));
      await processMergedXahauEntries(shuffled, walletSet);
      const newDisposal = allDisposalsHigh.find(d => d.wallet === wC);
      const newBasis = newDisposal ? newDisposal.basis : null;
      const newTerm = newDisposal ? newDisposal.term : null;

      resetState(); // leave no synthetic residue in the app's real state
      delete XAH_PRICES['2030-01-01'];

      return { oldBasis, newBasis, newTerm, foundOldDisposal: !!oldDisposal, foundNewDisposal: !!newDisposal };
    });

    expect(result.foundOldDisposal).toBe(true);
    expect(result.foundNewDisposal).toBe(true);
    // The old per-wallet-in-isolation approach loses the chain: C's ledger
    // has no lot yet when its disposal is processed, so it falls back to $0.
    expect(result.oldBasis).toBe(0);
    // The fix: 100 XAH * $2.50 real acquisition price, correctly carried
    // through two internal transfers via true chronological processing.
    expect(result.newBasis).toBe(250);
    expect(result.newTerm).toBe('ST'); // 3 days held — correctly short-term
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
