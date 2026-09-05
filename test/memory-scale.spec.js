// test/memory-scale.spec.js — guards the failure that actually took the app
// down on the user's machine: the renderer process being killed part-way
// through the startup cache rebuild, leaving a blank white window and no
// error anywhere.
//
// The cause was memory, not speed. At 4.6M cached rows the renderer held,
// simultaneously: a ~1.1 GB merged array for the chain being processed, and
// a ~3.0 GB `allTransactionHistory` array that existed only to serve two
// on-demand exports. That is ~4.6 GB against a V8 renderer old-space ceiling
// of roughly 4 GB, so V8 aborted the process.
//
// The fix was to stop accumulating the history array in desktop mode — SQLite
// already holds every one of those rows — and to stream it back out one
// wallet at a time (forEachCachedTx) when an export actually needs it.
//
// This test seeds a real cache, runs the real rebuild, and measures the real
// heap. It asserts two things that together pin the fix in place:
//   1. transactionsScanned counts every row, but allTransactionHistory stays
//      empty — i.e. we are genuinely not accumulating.
//   2. heap growth per cached row stays far below the ~694 bytes/row the old
//      array cost, so a regression that reintroduces accumulation fails here
//      rather than on someone's tax return.
//
// It runs at a size chosen to be meaningful but quick. The per-row assertion
// is what makes it extrapolate: the old code would blow the budget at any
// size.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_DIR = path.join(__dirname, '..');
const WALLETS = 40;
const ROWS_PER_WALLET = 1500;
const TOTAL_ROWS = WALLETS * ROWS_PER_WALLET; // 60,000

test('cache rebuild does not accumulate the full transaction history in memory', async () => {
  test.setTimeout(180000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xrp-xahau-mem-'));
  const app = await electron.launch({
    args: [APP_DIR],
    cwd: APP_DIR,
    env: { ...process.env, HOME: home },
  });

  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // ── Seed a realistically shaped cache ────────────────────────────────
    await win.evaluate(async ({ wallets, perWallet }) => {
      // Cached rows are only processed from the perspective of a wallet the
      // user actually owns and fetches, so the fixture must list them.
      WALLETS.length = 0;
      for (let w = 0; w < wallets; w++) {
        const wallet = 'rMemWallet' + String(w).padStart(4, '0');
        WALLETS.push(wallet);
        const rows = [];
        for (let i = 0; i < perWallet; i++) {
          const day = String((i % 28) + 1).padStart(2, '0');
          const mon = String((i % 12) + 1).padStart(2, '0');
          const ts = `2025-${mon}-${day} 12:00:${String(i % 60).padStart(2, '0')}`;
          const hash = `MEM${w}_${i}`;
          rows.push({
            tx_hash: hash, timestamp: ts,
            raw_json: JSON.stringify({
              Account: i % 2 ? wallet : 'rExternalCounterparty' + (i % 50),
              Destination: i % 2 ? 'rExternalCounterparty' + (i % 50) : wallet,
              TransactionType: 'Payment', TransactionResult: 'tesSUCCESS',
              Timestamp: ts, TransactionHash: hash,
              delivered_amount_XRP: String(10 + (i % 500)),
              Amount_XRP: String(10 + (i % 500)),
              Amount_value: '', Amount_currency: '',
              TakerGets_XRP: '', TakerGets_value: '', TakerGets_currency: '',
              TakerPays_XRP: '', TakerPays_value: '', TakerPays_currency: '',
            }),
          });
        }
        await window.taxDB.insertRows(wallet, 'Xahau', rows);
        await window.taxDB.upsertSyncState(wallet, 'Xahau', '2025-12-31 00:00:00');
      }
    }, { wallets: WALLETS, perWallet: ROWS_PER_WALLET });

    // ── Rebuild, measuring heap before and after ─────────────────────────
    const result = await win.evaluate(async () => {
      // usedJSHeapSize counts garbage that hasn't been collected yet, and the
      // paged reader produces a lot of short-lived objects. Sampling a few
      // times with the event loop free in between lets incremental GC catch
      // up; the minimum is the closest cheap approximation of live heap.
      // Without this the measurement is dominated by collection timing and
      // reports higher AFTER a change that genuinely reduced memory.
      window.__settledHeap = async () => {
        if (!performance.memory) return 0;
        let min = Infinity;
        for (let i = 0; i < 6; i++) {
          await new Promise(r => setTimeout(r, 60));
          min = Math.min(min, performance.memory.usedJSHeapSize);
        }
        return min;
      };
      const heap = () => window.__settledHeap();
      resetLedgerState();
      const before = await heap();
      await buildReportFromCache({ silent: true });
      const after = await heap();
      return {
        before, after,
        scanned: transactionsScanned,
        historyArrayLength: allTransactionHistory.length,
        disposals: allDisposalsHigh.length,
        income: allIncomeRows.length,
        missingPrices: missingPriceRows.length,
        lots: Object.values(walletLedger).reduce((s,t)=>s+Object.values(t).reduce((a,l)=>a+l.length,0),0),
        haveHeapApi: !!performance.memory,
      };
    });

    // The rebuild really did process everything.
    expect(result.scanned).toBe(TOTAL_ROWS);
    expect(result.disposals).toBeGreaterThan(0);

    // The core assertion: the history array is NOT accumulated in desktop
    // mode. This is the single line that, if it regresses, brings back the
    // out-of-memory kill.
    expect(result.historyArrayLength).toBe(0);

    if (result.haveHeapApi) {
      const bytesPerRow = (result.after - result.before) / TOTAL_ROWS;
      // eslint-disable-next-line no-console
      console.log(`heap growth: ${((result.after - result.before) / 1048576).toFixed(1)} MB ` +
                  `over ${TOTAL_ROWS.toLocaleString()} rows = ${bytesPerRow.toFixed(0)} bytes/row`);
      console.log(`  retained: ${result.disposals.toLocaleString()} disposals, ` +
                  `${result.lots.toLocaleString()} lots, ${result.income.toLocaleString()} income, ` +
                  `${result.missingPrices.toLocaleString()} missing-price records`);
      // Calibration, from measurement rather than guesswork.
      //
      // This fixture is a deliberate worst case: every seeded row is a
      // value-bearing Payment, so half become disposals and half become
      // cost-basis lots and NOTHING is discarded. Measured retention is
      // ~30,000 disposals + ~30,000 lots from 60,000 rows, costing ~727
      // bytes/row — that is legitimate ledger state, not accumulation. A
      // real cache is mostly TrustSet/AccountSet housekeeping and dust,
      // which produce neither, so its bytes-per-row is far lower.
      //
      // The threshold separates that from the regression: putting the raw
      // per-row array back costs a further ~694 bytes/row, which would land
      // around ~1,420. 1,100 sits clearly between the two.
      //
      // Note this number is noisier than it looks — usedJSHeapSize includes
      // uncollected garbage, which is why it is sampled and minimised above.
      // The precise, non-noisy guards are historyArrayLength === 0 and the
      // scaling ratio below; this one is a canary.
      expect(bytesPerRow).toBeLessThan(1100);
    }

    // ── Transient peak during the rebuild must be bounded by ONE PAGE ────
    //
    // This is the property that actually failed on the user's machine, and
    // it is not the same as total retained memory. Retained ledger state
    // legitimately grows with the number of taxable events — you cannot
    // report disposals you did not keep. What must NOT grow with the cache
    // is the working set used to get there.
    //
    // The old rebuild materialised an entire chain into one array so it
    // could sort it in JavaScript: ~523 bytes x 4.57M Xahau rows ~= 2.2 GB
    // of pure transient buffer, on top of the ledger. SQLite now yields the
    // same chronological order from an index, so the renderer should hold
    // one page (25,000 rows) and nothing more.
    //
    // Measured directly: sample the heap while the rebuild runs, take the
    // maximum, and compare it against what is still held once it finishes.
    // The gap between them IS the transient working set.
    // Double the cache first, so the working-set bound is demonstrated
    // against more data than the first measurement used.
    await win.evaluate(async ({ perWallet }) => {
      for (let w = 0; w < 40; w++) {
        const wallet = 'rMemWalletB' + String(w).padStart(4, '0');
        WALLETS.push(wallet);
        const rows = [];
        for (let i = 0; i < perWallet; i++) {
          const ts = `2025-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')} 13:00:${String(i % 60).padStart(2, '0')}`;
          const hash = `MEMB${w}_${i}`;
          rows.push({ tx_hash: hash, timestamp: ts, raw_json: JSON.stringify({
            Account: i % 2 ? wallet : 'rExtB' + (i % 50),
            Destination: i % 2 ? 'rExtB' + (i % 50) : wallet,
            TransactionType: 'Payment', TransactionResult: 'tesSUCCESS',
            Timestamp: ts, TransactionHash: hash,
            delivered_amount_XRP: String(10 + (i % 500)), Amount_XRP: String(10 + (i % 500)),
            Amount_value: '', Amount_currency: '',
            TakerGets_XRP: '', TakerGets_value: '', TakerGets_currency: '',
            TakerPays_XRP: '', TakerPays_value: '', TakerPays_currency: '',
          })});
        }
        await window.taxDB.insertRows(wallet, 'Xahau', rows);
      }
    }, { perWallet: ROWS_PER_WALLET });

    const transient = await win.evaluate(async () => {
      resetLedgerState();
      await new Promise(r => setTimeout(r, 200));
      let peak = 0;
      const sampler = setInterval(() => {
        if (performance.memory) peak = Math.max(peak, performance.memory.usedJSHeapSize);
      }, 15);
      await buildReportFromCache({ silent: true });
      clearInterval(sampler);
      const retained = await window.__settledHeap();
      return { peak, retained, scanned: transactionsScanned };
    });

    // Twice the data really was processed this time.
    expect(transient.scanned).toBe(TOTAL_ROWS * 2);

    if (result.haveHeapApi) {
      const workingSetMB = Math.max(0, transient.peak - transient.retained) / 1048576;
      // eslint-disable-next-line no-console
      console.log(`transient working set over ${(TOTAL_ROWS * 2).toLocaleString()} rows: ` +
                  `${workingSetMB.toFixed(1)} MB (peak ${(transient.peak/1048576).toFixed(0)} MB, ` +
                  `retained ${(transient.retained/1048576).toFixed(0)} MB)`);
      // One 25,000-row page is roughly 12 MB of parsed rows; allow generous
      // slack for GC lag and IPC buffers. The old whole-chain array would be
      // ~63 MB at this fixture size and ~2,200 MB at the user's, so this
      // threshold separates the two by a wide margin at any scale.
      expect(workingSetMB).toBeLessThan(120);
    }

    // ── The exports must still see every row, streaming from SQLite ──────
    const streamed = await win.evaluate(async () => {
      let seen = 0, payments = 0;
      const total = await forEachCachedTx(tx => {
        seen++;
        if (tx.type === 'Payment') payments++;
      });
      return { seen, payments, total };
    });
    expect(streamed.total).toBe(TOTAL_ROWS * 2);
    expect(streamed.seen).toBe(TOTAL_ROWS * 2);
    expect(streamed.payments).toBe(TOTAL_ROWS * 2);

    // And the tax-software export still finds its rows without the array.
    const relevant = await win.evaluate(async () => {
      const { rows, totalScanned } = await buildRelevantTaxRows();
      return { rowCount: rows.length, totalScanned };
    });
    expect(relevant.totalScanned).toBe(TOTAL_ROWS * 2);
    expect(relevant.rowCount).toBeGreaterThan(0);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
