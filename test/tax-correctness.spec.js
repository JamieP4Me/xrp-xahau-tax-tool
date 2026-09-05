// test/tax-correctness.spec.js — regression tests for the tax-math bugs found
// in the full code review. Every one of these changed a number that would
// have gone on a filed return, so each test asserts the specific wrong value
// the old code produced as well as the right one.
//
// These drive the REAL functions inside the running Electron renderer, not
// reimplementations.
//
// NOTE ON TIMEZONE: the first test only fails when the process runs somewhere
// other than UTC, which is exactly why the bug survived this long — CI and
// the dev container both run UTC, where the offset is zero. It is launched
// with TZ=America/New_York explicitly so it is actually meaningful.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_DIR = path.join(__dirname, '..');

async function launch(env = {}) {
  // Isolate the profile EXPLICITLY, not via HOME.
  //
  // Setting HOME is not enough: on Linux, Electron resolves userData from
  // XDG_CONFIG_HOME when that is set, and GitHub's runners set it. Every test
  // then shared one SQLite database, so a suite that passed locally failed in
  // CI with counts like 126,886 rows where the fixture had inserted 10 — one
  // test reading another's data. --user-data-dir is Chromium's own switch and
  // takes precedence over all of it, on every platform.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xrp-xahau-taxcorrect-'));
  const app = await electron.launch({
    args: [APP_DIR, '--user-data-dir=' + path.join(home, 'electron-profile')],
    cwd: APP_DIR,
    env: { ...process.env, HOME: home, ...env },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win, home };
}

test('timestamps are read as UTC, so a late-evening 31 Dec sale stays in the right tax year', async () => {
  // Runs in US Eastern. A WinDB timestamp is UTC; parsing it without a 'Z'
  // makes the engine treat it as LOCAL time and then read it back with
  // getUTC*, shifting every date by the machine's offset.
  const { app, win, home } = await launch({ TZ: 'America/New_York' });
  try {
    const r = await win.evaluate(() => ({
      // 2025-12-31 20:00 UTC is still 2025. Pre-fix this produced 2026-01-01.
      newYearsEve: toDK(parseWinDbTs('2025-12-31 20:00:00')),
      newYearsEveYear: new Date(parseWinDbTs('2025-12-31 20:00:00')).getUTCFullYear(),
      // Any evening-UTC transaction picked the NEXT day's price before.
      evening: toDK(parseWinDbTs('2025-06-15 21:00:00')),
      // Midday was unaffected either way — proves the fix didn't over-correct.
      midday: toDK(parseWinDbTs('2025-06-15 10:00:00')),
      tzOffsetMinutes: new Date().getTimezoneOffset(),
    }));
    expect(r.tzOffsetMinutes).not.toBe(0); // the test is only meaningful off-UTC
    expect(r.newYearsEve).toBe('2025-12-31');
    expect(r.newYearsEveYear).toBe(2025);
    expect(r.evening).toBe('2025-06-15');
    expect(r.midday).toBe('2025-06-15');
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('long-term requires MORE than a year — the one-year anniversary is still short-term', async () => {
  const { app, win, home } = await launch();
  try {
    const r = await win.evaluate(() => ({
      // 2024 is a leap year: this span is 366 days, so the old `days > 365`
      // test called it long-term. It is the anniversary itself → short-term.
      anniversaryLeap: isLongTerm('2024-01-01', '2025-01-01'),
      dayAfterLeap:    isLongTerm('2024-01-01', '2025-01-02'),
      anniversaryPlain:isLongTerm('2022-03-01', '2023-03-01'),
      dayAfterPlain:   isLongTerm('2022-03-01', '2023-03-02'),
      wellShort:       isLongTerm('2024-01-01', '2024-06-01'),
      wellLong:        isLongTerm('2020-01-01', '2025-01-01'),
      unknownLot:      isLongTerm(null, '2025-01-01'),
    }));
    expect(r.anniversaryLeap).toBe(false);  // was true — the actual bug
    expect(r.dayAfterLeap).toBe(true);
    expect(r.anniversaryPlain).toBe(false);
    expect(r.dayAfterPlain).toBe(true);
    expect(r.wellShort).toBe(false);
    expect(r.wellLong).toBe(true);
    expect(r.unknownLot).toBe(false);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('FIFO consumes by acquisition date, so a transferred-in older lot goes first', async () => {
  const { app, win, home } = await launch();
  try {
    const r = await win.evaluate(() => {
      Object.keys(walletLedger).forEach(k => delete walletLedger[k]);

      // B already holds a 2024 lot. A holds an older 2019 lot and transfers
      // it in. A later disposal from B must consume the 2019 lot first.
      ledgerAdd('wB', 'XRP', '2024-06-01', 1000, 0.50, 'received_market');
      ledgerAdd('wA', 'XRP', '2019-01-01', 1000, 0.35, 'received_market');
      ledgerTransferIn('wA', 'wB', 'XRP', 1000);

      const consumed = ledgerFIFODetailed('wB', 'XRP', 1000);
      return {
        acqDates: consumed.map(c => c.acqDate),
        basis: consumed.reduce((s, c) => s + c.qty * c.unitCost, 0),
        longTerm: consumed.every(c => isLongTerm(c.acqDate, '2024-08-01')),
      };
    });
    // Pre-fix: the inherited lot was appended last, so the 2024 lot was
    // consumed → $500 basis, short-term. Both wrong.
    expect(r.acqDates).toEqual(['2019-01-01']);
    expect(r.basis).toBeCloseTo(350, 6);
    expect(r.longTerm).toBe(true);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a wallet paying itself does not disturb its own lot order', async () => {
  const { app, win, home } = await launch();
  try {
    const r = await win.evaluate(() => {
      Object.keys(walletLedger).forEach(k => delete walletLedger[k]);
      ledgerAdd('wC', 'XAH', '2022-01-01', 100, 1.00, 'received');
      ledgerAdd('wC', 'XAH', '2024-01-01', 100, 2.00, 'received');

      ledgerTransferIn('wC', 'wC', 'XAH', 100); // self-payment — must be a no-op

      const consumed = ledgerFIFODetailed('wC', 'XAH', 100);
      return {
        acqDate: consumed[0].acqDate,
        unitCost: consumed[0].unitCost,
        lotCount: walletLedger['wC']['XAH'].length,
      };
    });
    // Pre-fix the self-payment drained the 2022 lot and re-appended it, so
    // this disposal consumed the 2024 lot at $2.00 instead of $1.00.
    expect(r.acqDate).toBe('2022-01-01');
    expect(r.unitCost).toBeCloseTo(1.0, 6);
    expect(r.lotCount).toBe(2); // no phantom third lot created
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a missing price date never yields NaN, $0, or the newest price in the series', async () => {
  const { app, win, home } = await launch();
  try {
    const r = await win.evaluate(() => {
      missingPriceRows.length = 0;
      const series = { '2024-01-10': {high: 1, low: 1}, '2024-01-20': {high: 2, low: 2}, '2026-09-03': {high: 9, low: 9} };
      return {
        exact:      lookupPrice(series, 'TEST', '2024-01-20', 'high'),
        nearBefore: lookupPrice(series, 'TEST', '2024-01-12', 'high'), // closer to the 10th
        nearAfter:  lookupPrice(series, 'TEST', '2024-01-18', 'high'), // closer to the 20th
        beforeAll:  lookupPrice(series, 'TEST', '2023-01-01', 'high'), // clamps to earliest, NOT newest
        afterAll:   lookupPrice(series, 'TEST', '2030-01-01', 'high'),
        flagged:    missingPriceRows.length,
      };
    });
    expect(r.exact).toBe(2);
    expect(r.nearBefore).toBe(1);
    expect(r.nearAfter).toBe(2);
    expect(r.beforeAll).toBe(1);  // the EVR bug reached for 9 (newest) here
    expect(r.afterAll).toBe(9);
    expect(Number.isFinite(r.exact)).toBe(true);
    expect(r.flagged).toBe(4);    // every inexact hit is recorded, not silent
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a disposal with an unusable price still produces finite totals, never NaN', async () => {
  const { app, win, home } = await launch();
  try {
    const r = await win.evaluate(() => {
      Object.keys(walletLedger).forEach(k => delete walletLedger[k]);
      allDisposalsHigh.length = 0;
      ledgerAdd('wN', 'XRP', '2024-01-01', 100, 0.5, 'received_market');
      // undefined is exactly what XRP_PRICES[dk]?.high used to hand over.
      pushDisposal('wN', 'XRP', 100, '2025-01-02', '1/2/2025', 2025, 'H1', undefined, undefined, '');
      const totalProceeds = allDisposalsHigh.reduce((s, r) => s + r.proceeds, 0);
      const totalGain = allDisposalsHigh.reduce((s, r) => s + r.gain, 0);
      return { totalProceeds, totalGain, rows: allDisposalsHigh.length };
    });
    expect(r.rows).toBeGreaterThan(0);
    expect(Number.isNaN(r.totalProceeds)).toBe(false); // whole report used to read "NaN"
    expect(Number.isNaN(r.totalGain)).toBe(false);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the sync cursor never advances past an incomplete pass', async () => {
  const { app, win, home } = await launch();
  try {
    const r = await win.evaluate(() => {
      const SAFE_NOW = '2026-09-04 00:00:00';
      return {
        // The real shape of the bug: the outbound pass truncated back in 2020
        // while the inbound pass completed into 2026. Taking the max jumped
        // the cursor to 2026 and orphaned six years of outbound history.
        oneTruncated: computeSyncCursor([
          { maxTs: '2020-05-01 00:00:00', ok: true, truncated: true },
          { maxTs: '2026-08-20 00:00:00', ok: true, truncated: false },
        ], SAFE_NOW),
        // Both complete: safe to move up to the safety-buffer watermark, and
        // NOT pinned back to the newest row seen (which re-downloaded a
        // dormant wallet's whole history at Payment-Claim cost every run).
        bothComplete: computeSyncCursor([
          { maxTs: '2021-05-01 00:00:00', ok: true, truncated: false },
          { maxTs: null, ok: true, truncated: false },
        ], SAFE_NOW),
        // Both truncated → the earlier of the two.
        bothTruncated: computeSyncCursor([
          { maxTs: '2023-01-01 00:00:00', ok: true, truncated: true },
          { maxTs: '2022-01-01 00:00:00', ok: true, truncated: true },
        ], SAFE_NOW),
        // Truncated with nothing to vouch for → don't move the cursor at all.
        unusable: computeSyncCursor([
          { maxTs: null, ok: true, truncated: true },
        ], SAFE_NOW),
        safeNow: SAFE_NOW,
      };
    });

    expect(r.oneTruncated).toBe('2020-05-01 00:00:00'); // min across passes, not max
    expect(r.bothComplete).toBe(r.safeNow);
    expect(r.bothTruncated).toBe('2022-01-01 00:00:00');
    expect(r.unusable).toBeNull();
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('CSV fields containing commas and quotes stay in their own column', async () => {
  const { app, win, home } = await launch();
  try {
    const r = await win.evaluate(() => ({
      // XRPL currency codes are attacker-supplied and may contain a comma.
      comma: csvField('A,B'),
      quote: csvField('say "hi"'),
      plain: csvField('XAH'),
      empty: csvField(null),
      newline: csvField('a\nb'),
      // A whole row must keep its column count.
      cols: [ 'rWallet', 'A,B', '12.5', 'note, with comma' ].map(csvField).join(',').split('","').length,
    }));
    expect(r.comma).toBe('"A,B"');
    expect(r.quote).toBe('"say ""hi"""');
    expect(r.plain).toBe('XAH');
    expect(r.empty).toBe('');
    expect(r.newline).toBe('"a\nb"');
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('XRP amounts are whole XRP — large transfers are not divided into oblivion', async () => {
  // Verified against the real 4.6M-row cache with xah-units-check.py: of 3,247
  // sampled native XRP payments, 1,873 carry a decimal point, and drops are
  // integral by protocol — so WinDB's Amount_XRP for XRPL is WHOLE XRP.
  //
  // The old code did `if (qty > 1000) qty = qty / 1e6`. That was accidentally
  // right below 1,000 XRP and silently catastrophic above it: 12,000 XRP
  // became 0.012, failed the dust test, and vanished from the ledger and
  // Form 8949 entirely — so the LARGEST transactions were the ones that
  // disappeared. The values below are the real observed range.
  const { app, win, home } = await launch();
  try {
    const r = await win.evaluate(async () => {
      const wallet = 'wUnitsTest';
      const walletSet = new Set([wallet]);
      const helpers = makeXrplPriceHelpers();
      const mk = (amt, hash) => ({
        Account: 'wExternalSender', Destination: wallet, TransactionType: 'Payment',
        TransactionResult: 'tesSUCCESS', Timestamp: '2025-04-01 12:00:00',
        TransactionHash: hash,
        delivered_amount_XRP: String(amt), Amount_XRP: String(amt),
        Amount_value: '', Amount_currency: '',
      });

      resetLedgerState();
      // One acquisition at each magnitude actually present in the real data.
      for (const [amt, h] of [[12.5,'A'], [250,'B'], [999,'C'], [1500,'D'], [12000,'E'], [69000,'F']]) {
        processOneXRPLRow(mk(amt, h), wallet, walletSet, 'out', helpers);
      }
      const lots = (walletLedger[wallet] && walletLedger[wallet]['XRP']) || [];
      return {
        lotQtys: lots.map(l => l.qty).sort((a,b) => a-b),
        totalXrp: lots.reduce((s,l) => s + l.qty, 0),
      };
    });

    // Every one of these must survive at face value. Pre-fix, the last three
    // (1,500 / 12,000 / 69,000 XRP) produced no lot at all.
    expect(r.lotQtys).toEqual([12.5, 250, 999, 1500, 12000, 69000]);
    expect(r.totalXrp).toBeCloseTo(83761.5, 4);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('sub-1-XRP dust is skipped and counted, not silently inflated', async () => {
  const { app, win, home } = await launch();
  try {
    const r = await win.evaluate(() => {
      const wallet = 'wDustTest';
      const walletSet = new Set([wallet]);
      const helpers = makeXrplPriceHelpers();
      const mk = (amt, h) => ({
        Account: 'wSpammer', Destination: wallet, TransactionType: 'Payment',
        TransactionResult: 'tesSUCCESS', Timestamp: '2025-04-02 12:00:00',
        TransactionHash: h, delivered_amount_XRP: String(amt), Amount_XRP: String(amt),
        Amount_value: '', Amount_currency: '',
      });
      resetLedgerState();
      // 0.000001 XRP is the real observed minimum — spam dust.
      processOneXRPLRow(mk(0.000001, 'D1'), wallet, walletSet, 'out', helpers);
      processOneXRPLRow(mk(0.5, 'D2'), wallet, walletSet, 'out', helpers);
      processOneXRPLRow(mk(5, 'D3'), wallet, walletSet, 'out', helpers);
      const lots = (walletLedger[wallet] && walletLedger[wallet]['XRP']) || [];
      return { lotQtys: lots.map(l => l.qty), dustSkipped };
    });
    expect(r.lotQtys).toEqual([5]);   // only the real one becomes a lot
    expect(r.dustSkipped).toBe(2);    // and the dust is reported, not hidden
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('one ownership set: a configured wallet with no cached rows is still mine', async () => {
  const { app, win, home } = await launch();
  try {
    const r = await win.evaluate(() => {
      // WALLETS ships empty (see scripts/verify-clean.sh) so the fixture has
      // to supply its own configured wallet rather than borrowing one from a
      // baked-in list.
      const configured = 'rQfpZ6wYhgsi1nsE3kuW3iqn5c3Nd8TQjL';
      WALLETS.length = 0; WALLETS.push(configured);
      const set = ownedWalletSet(['rSomeCachedOnlyWallet']);
      return {
        keepsConfigured: set.has(configured),
        keepsCached: set.has('rSomeCachedOnlyWallet'),
        excludesStranger: set.has('rTotallyExternalAddress'),
      };
    });
    // Pre-fix, the cache-rebuild path used the cached list ALONE, so a
    // configured-but-unsynced wallet counted as a stranger and a transfer to
    // it turned into a fabricated taxable disposal.
    expect(r.keepsConfigured).toBe(true);
    expect(r.keepsCached).toBe(true);
    expect(r.excludesStranger).toBe(false);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('two overlapping report builds cannot double-count — the exact corruption seen on 4.6M rows', async () => {
  // The real failure: the automatic startup rebuild takes minutes on a large
  // cache. Clicking "View Report From Cache" partway through began a SECOND
  // pass over the same shared arrays. The second's resetLedgerState() wiped
  // what the first had built, then both kept appending — producing duplicated
  // Form 8949 rows and a report that claimed 8,443,536 transactions scanned
  // against a cache holding only 4,601,178, with capital gains inflated to
  // match.
  const { app, win, home } = await launch();
  try {
    const r = await win.evaluate(async () => {
      const wallet = 'wRaceWallet';
      WALLETS.length = 0; WALLETS.push(wallet);
      await window.taxDB.clearWalletChain(wallet, 'Xahau');
      const rows = [];
      for (let i = 0; i < 400; i++) {
        const ts = `2025-0${(i % 9) + 1}-${String((i % 28) + 1).padStart(2, '0')} 10:00:${String(i % 60).padStart(2, '0')}`;
        const hash = 'RACE' + i;
        rows.push({ tx_hash: hash, timestamp: ts, raw_json: JSON.stringify({
          Account: i % 2 ? wallet : 'wRaceExternal',
          Destination: i % 2 ? 'wRaceExternal' : wallet,
          TransactionType: 'Payment', TransactionResult: 'tesSUCCESS',
          Timestamp: ts, TransactionHash: hash,
          delivered_amount_XRP: '100', Amount_XRP: '100',
          Amount_value: '', Amount_currency: '',
          TakerGets_XRP: '', TakerGets_value: '', TakerGets_currency: '',
          TakerPays_XRP: '', TakerPays_value: '', TakerPays_currency: '' })});
      }
      await window.taxDB.insertRows(wallet, 'Xahau', rows);
      await window.taxDB.upsertSyncState(wallet, 'Xahau', '2025-12-31 00:00:00');

      const cached = (await window.taxDB.countForChain('Xahau')) + (await window.taxDB.countForChain('XRPL'));

      // Fire two builds at once — the shape of the real bug.
      const [a, b] = await Promise.all([
        buildReportFromCache({ silent: true }),
        buildReportFromCache({ silent: true }),
      ]);

      return {
        cached,
        scanned: transactionsScanned,
        disposals: allDisposalsHigh.length,
        mismatch: ledgerCountMismatch,
        bothResolved: a === true && b === true,
      };
    });

    // The decisive assertion: rows processed must equal rows cached, exactly.
    // Pre-fix this came back at roughly 2x and nothing anywhere objected.
    expect(r.scanned).toBe(r.cached);
    expect(r.mismatch).toBeNull();       // the self-check agrees
    expect(r.bothResolved).toBe(true);   // the joiner still gets a real result

    // And a single clean build produces the same disposal count, proving the
    // second caller joined rather than duplicating.
    const solo = await win.evaluate(async () => {
      await buildReportFromCache({ silent: true });
      return { scanned: transactionsScanned, disposals: allDisposalsHigh.length };
    });
    expect(solo.scanned).toBe(r.cached);
    expect(solo.disposals).toBe(r.disposals);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('holdings + destination diagnostic expose a transfer wrongly booked as a sale', async () => {
  // The scenario the user is actually in: money moved to an address they own
  // (an exchange deposit address, or a wallet not in the list). The app can
  // only tell "mine" from "not mine" by the wallet list, so it books that
  // movement as a fully taxable sale at market value. The diagnostic has to
  // make that visible and attributable, because the totals alone just look
  // like a large gain.
  const { app, win, home } = await launch();
  try {
    const r = await win.evaluate(() => {
      resetLedgerState();
      const mine = 'wHoldMine';
      const myUnlistedExchange = 'wMyExchangeDepositAddr';

      // Acquire 10,000 XRP cheaply, then "send" it to an address that is
      // really the user's but is not in the wallet list.
      ledgerAdd(mine, 'XRP', '2021-01-01', 10000, 0.30, 'received_market');
      pushDisposal(mine, 'XRP', 10000, '2025-06-01', '6/1/2025', 2025, 'HASH_X', 2.40, 2.40, '', myUnlistedExchange);

      // A genuinely small real sale, to a different address.
      ledgerAdd(mine, 'XAH', '2024-01-01', 1000, 0.02, 'received_market');
      pushDisposal(mine, 'XAH', 1000, '2025-07-01', '7/1/2025', 2025, 'HASH_Y', 0.05, 0.05, '', 'wRealBuyer');

      applyReportingYear(2025);
      const dests = computeDisposalDestinations(2025);
      const holdings = computeHoldings();
      return {
        top: dests[0],
        second: dests[1],
        destCount: dests.length,
        // Both lots fully consumed, so the wallet should now look empty —
        // which is exactly the discrepancy the user can check on an explorer.
        holdingsForMine: holdings.filter(h => h.wallet === mine).length,
      };
    });

    // The mis-classified transfer dominates the reported proceeds and is
    // attributed to the specific address responsible.
    expect(r.top.dest).toBe('wMyExchangeDepositAddr');
    expect(r.top.proceeds).toBeCloseTo(24000, 2);
    expect(r.top.count).toBe(1);
    expect(r.second.dest).toBe('wRealBuyer');
    expect(r.second.proceeds).toBeCloseTo(50, 2);
    expect(r.destCount).toBe(2);
    // Ledger now believes the wallet holds nothing — the checkable symptom.
    expect(r.holdingsForMine).toBe(0);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('holdings report sums remaining FIFO lots per wallet and values them', async () => {
  const { app, win, home } = await launch();
  try {
    const r = await win.evaluate(() => {
      resetLedgerState();
      ledgerAdd('wH1', 'XRP', '2024-01-01', 1000, 0.50, 'received_market');
      ledgerAdd('wH1', 'XAH', '2024-02-01', 5000, 0.02, 'received_market');
      ledgerAdd('wH2', 'XRP', '2024-03-01', 250, 0.60, 'received_market');
      // Partially consume wH1's XRP — only the remainder should be reported.
      ledgerFIFODetailed('wH1', 'XRP', 400);
      const h = computeHoldings();
      const get = (w, t) => h.find(x => x.wallet === w && x.ticker === t);
      return {
        h1xrp: get('wH1', 'XRP'),
        h1xah: get('wH1', 'XAH'),
        h2xrp: get('wH2', 'XRP'),
        rowCount: h.length,
      };
    });
    expect(r.h1xrp.qty).toBeCloseTo(600, 6);          // 1000 acquired - 400 consumed
    expect(r.h1xrp.basis).toBeCloseTo(300, 6);        // 600 x $0.50
    expect(r.h1xah.qty).toBeCloseTo(5000, 6);
    expect(r.h2xrp.qty).toBeCloseTo(250, 6);
    expect(r.rowCount).toBe(3);
    expect(r.h1xrp.price).toBeGreaterThan(0);         // valued at a real embedded price
    expect(r.h1xrp.value).toBeCloseTo(r.h1xrp.qty * r.h1xrp.price, 4);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('marking a destination as mine reclassifies the transfer and is never fetched', async () => {
  // The resolution to the real finding: on a 4.6M-row cache, eight addresses
  // accounted for 99.2% of $540,609 of reported "proceeds" from a portfolio
  // worth $15,678 — transfers to the user's own exchange deposit addresses,
  // each booked as a taxable sale because the engine's only test is whether
  // the destination is in the wallet list.
  //
  // Marking such an address must (a) make the movement non-taxable, and
  // (b) NOT add it to anything the sync loop will try to fetch — an exchange
  // hot wallet has tens of millions of transactions.
  const { app, win, home } = await launch();
  try {
    const r = await win.evaluate(async () => {
      const mine = 'wOwnedSender';
      const myExchange = 'rQfpZ6wYhgsi1nsE3kuW3iqn5c3Nd8TQjL';
      WALLETS.length = 0; WALLETS.push(mine);   // its cached rows are its own perspective
      await window.taxDB.clearWalletChain(mine, 'Xahau');
      await window.taxDB.insertRows(mine, 'Xahau', [
        { tx_hash: 'ACQ1', timestamp: '2024-01-05 10:00:00', raw_json: JSON.stringify({
          Account: 'wSomeExternalSource', Destination: mine, TransactionType: 'Payment',
          TransactionResult: 'tesSUCCESS', Timestamp: '2024-01-05 10:00:00', TransactionHash: 'ACQ1',
          delivered_amount_XRP: '10000', Amount_XRP: '10000', Amount_value: '', Amount_currency: '' })},
        { tx_hash: 'MOVE1', timestamp: '2025-06-10 10:00:00', raw_json: JSON.stringify({
          Account: mine, Destination: myExchange, TransactionType: 'Payment',
          TransactionResult: 'tesSUCCESS', Timestamp: '2025-06-10 10:00:00', TransactionHash: 'MOVE1',
          delivered_amount_XRP: '10000', Amount_XRP: '10000', Amount_value: '', Amount_currency: '' })},
      ]);
      await window.taxDB.upsertSyncState(mine, 'Xahau', '2025-12-31 00:00:00');

      // Before: the move to the unlisted address is a taxable disposal.
      transferOnlyAddresses.length = 0;
      await buildReportFromCache({ silent: true });
      applyReportingYear(2025);
      const before = {
        disposals: allDisposalsHigh.filter(d => d.year === 2025).length,
        proceeds: allDisposalsHigh.filter(d => d.year === 2025).reduce((s, d) => s + d.proceedsH, 0),
      };

      // Mark it as mine and rebuild.
      transferOnlyAddresses.push(myExchange);
      await buildReportFromCache({ silent: true });
      applyReportingYear(2025);
      const after = {
        disposals: allDisposalsHigh.filter(d => d.year === 2025).length,
        proceeds: allDisposalsHigh.filter(d => d.year === 2025).reduce((s, d) => s + d.proceedsH, 0),
        ownedNow: ownedWalletSet([]).has(myExchange),
        // The sync loop iterates `selected`, never the ownership set.
        inWalletList: WALLETS.includes(myExchange),
        inSelected: selected.includes(myExchange),
      };
      transferOnlyAddresses.length = 0;
      return { before, after };
    });

    // The phantom sale existed, and marking the address removed it.
    expect(r.before.disposals).toBeGreaterThan(0);
    expect(r.before.proceeds).toBeGreaterThan(0);
    expect(r.after.disposals).toBe(0);
    expect(r.after.proceeds).toBe(0);

    // Counted as owned for classification...
    expect(r.after.ownedNow).toBe(true);
    // ...but NOT added to anything that would cause it to be fetched.
    expect(r.after.inWalletList).toBe(false);
    expect(r.after.inSelected).toBe(false);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a counterparty that pays money back is flagged as a round trip, one that never does is not', async () => {
  // The user was left with eight unidentified addresses holding 99.2% of the
  // reported proceeds and no way to tell which were their own accounts short
  // of checking each by hand. The cache already contains the answer: you do
  // not receive funds back from someone you sold to. This asserts the two
  // shapes are distinguished, and that the *directional* accounting is right
  // — sends and receipts must not be pooled.
  const { app, win, home } = await launch();
  try {
    const r = await win.evaluate(async () => {
      const mine = 'wFlowOwner';
      const myOther = 'rMyOtherWalletRoundTrip';   // funds come back from here
      const buyer   = 'rRealBuyerOneWayOnly';      // never sends anything back
      await window.taxDB.clearWalletChain(mine, 'Xahau');
      const pay = (h, ts, from, to, amt) => ({
        tx_hash: h, timestamp: ts, raw_json: JSON.stringify({
          Account: from, Destination: to, TransactionType: 'Payment',
          TransactionResult: 'tesSUCCESS', Timestamp: ts, TransactionHash: h,
          delivered_amount_XRP: String(amt), Amount_XRP: String(amt),
          Amount_value: '', Amount_currency: '' }) });
      await window.taxDB.insertRows(mine, 'Xahau', [
        pay('SRC', '2024-01-01 10:00:00', 'rExternalSource', mine, 50000),
        pay('OUT1', '2025-02-01 10:00:00', mine, myOther, 9000),
        pay('OUT2', '2025-03-01 10:00:00', mine, myOther, 1000),
        pay('BACK1','2025-04-01 10:00:00', myOther, mine, 7500),
        pay('OUT3', '2025-05-01 10:00:00', mine, buyer,   4000),
        pay('DUST', '2025-06-01 10:00:00', buyer,  mine,   0.4),  // below DUST_MIN_UNITS
      ]);
      await window.taxDB.upsertSyncState(mine, 'Xahau', '2025-12-31 00:00:00');
      transferOnlyAddresses.length = 0;
      await buildReportFromCache({ silent: true });

      const flows = await computeCounterpartyFlows();
      const rt = flows.get(myOther), one = flows.get(buyer);
      return {
        rt: rt && { sentCount: rt.sentCount, recvCount: rt.recvCount,
                    sentXAH: rt.sentBy.XAH, recvXAH: rt.recvBy.XAH },
        one: one && { sentCount: one.sentCount, recvCount: one.recvCount,
                      sentXAH: one.sentBy.XAH, recvXAH: one.recvBy.XAH },
        // The owner's own address must never appear as its own counterparty.
        selfListed: flows.has(mine),
      };
    });

    // Round-tripper: two out, one back, amounts kept in their own directions.
    expect(r.rt.sentCount).toBe(2);
    expect(r.rt.recvCount).toBe(1);
    expect(r.rt.sentXAH).toBeCloseTo(10000, 6);
    expect(r.rt.recvXAH).toBeCloseTo(7500, 6);

    // Genuine buyer: one-way. The 0.4-unit dust payment is below the
    // threshold and must NOT turn a real sale into a false "round trip".
    expect(r.one.sentCount).toBe(1);
    expect(r.one.recvCount).toBe(0);
    expect(r.one.recvXAH).toBeUndefined();

    expect(r.selfListed).toBe(false);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a gift is not a sale: no gain, coins leave the ledger, basis and holding period carry over', async () => {
  // Two addresses were used since 2024 to gift XRP to the user's daughters.
  // The engine booked every one of those transfers as a taxable disposal at
  // market value, because its only test is whether the destination is owned.
  //
  // Neither existing category fixes it. Marking the addresses "mine" removes
  // the phantom sale but leaves the gifted coins in the portfolio for ever.
  // A gift must consume the lots AND produce no disposal — and must carry
  // out the two numbers the recipient needs (IRC §1015: carryover basis for
  // a gain, gift-date FMV for a loss) before the lots are gone.
  const { app, win, home } = await launch();
  try {
    const r = await win.evaluate(async () => {
      const mine = 'wGiftDonor';
      const daughter = 'rDaughterOneGiftAddress';
      WALLETS.length = 0; WALLETS.push(mine);
      await window.taxDB.clearWalletChain(mine, 'XRPL');
      const pay = (h, ts, from, to, amt) => ({
        tx_hash: h, timestamp: ts, raw_json: JSON.stringify({
          Account: from, Destination: to, TransactionType: 'Payment',
          TransactionResult: 'tesSUCCESS', Timestamp: ts, TransactionHash: h,
          delivered_amount_XRP: String(amt), Amount_XRP: String(amt),
          Amount_value: '', Amount_currency: '' }) });
      await window.taxDB.insertRows(mine, 'XRPL', [
        // Acquired well over a year before the gift → long-term to the donor,
        // and that holding period must tack onto the daughter's.
        pay('BUY', '2023-01-10 10:00:00', 'rExchangeWithdrawal', mine, 20000),
        pay('GIFT1', '2025-03-15 10:00:00', mine, daughter, 6000),
        pay('GIFT2', '2025-09-20 10:00:00', mine, daughter, 4000),
      ]);
      await window.taxDB.upsertSyncState(mine, 'XRPL', '2025-12-31 00:00:00');

      // ── Before: booked as taxable sales ────────────────────────────────
      transferOnlyAddresses.length = 0;
      giftAddresses.length = 0;
      await buildReportFromCache({ silent: true });
      applyReportingYear(2025);
      const asSales = {
        disposals: allDisposalsHigh.filter(d => d.year === 2025).length,
        proceeds: allDisposalsHigh.filter(d => d.year === 2025).reduce((s, d) => s + d.proceedsH, 0),
        gifts: allGiftRows.length,
      };

      // ── After: marked as a gift recipient ──────────────────────────────
      setGiftAddress(daughter, 'Recipient One');
      await buildReportFromCache({ silent: true });
      applyReportingYear(2025);
      const held = computeHoldings().filter(h => h.wallet === mine && h.ticker === 'XRP');
      const asGifts = {
        disposals: allDisposalsHigh.filter(d => d.year === 2025).length,
        proceeds: allDisposalsHigh.filter(d => d.year === 2025).reduce((s, d) => s + d.proceedsH, 0),
        giftCount: allGiftRows.length,
        giftQty: allGiftRows.reduce((s, g) => s + g.qty, 0),
        fmv: allGiftRows.reduce((s, g) => s + g.fmv, 0),
        basis: allGiftRows.reduce((s, g) => s + g.basis, 0),
        terms: allGiftRows.map(g => g.term),
        recipients: [...new Set(allGiftRows.map(g => g.recipient))],
        remainingQty: held.reduce((s, h) => s + h.qty, 0),
        // A gift address must NOT be treated as one of the user's own.
        ownedNow: ownedWalletSet([]).has(daughter),
        inWalletList: WALLETS.includes(daughter),
        // Marking it "mine" afterwards must clear the gift flag, not stack.
        exclusive: (() => { toggleTransferOnly(daughter); const both = isTransferOnly(daughter) && isGiftAddress(daughter); toggleTransferOnly(daughter); return both; })(),
      };
      const byYear = giftsByRecipientYear();
      giftAddresses.length = 0; transferOnlyAddresses.length = 0;
      return { asSales, asGifts, byYear };
    });

    // The phantom sales were real before the change.
    expect(r.asSales.disposals).toBeGreaterThan(0);
    expect(r.asSales.proceeds).toBeGreaterThan(0);
    expect(r.asSales.gifts).toBe(0);

    // Marking as a gift removes them from Form 8949 entirely.
    expect(r.asGifts.disposals).toBe(0);
    expect(r.asGifts.proceeds).toBe(0);

    // But the coins genuinely left: 20,000 in, 10,000 gifted, 10,000 left.
    expect(r.asGifts.giftCount).toBe(2);
    expect(r.asGifts.giftQty).toBeCloseTo(10000, 6);
    expect(r.asGifts.remainingQty).toBeCloseTo(10000, 6);

    // Both numbers the recipient will need were captured, and the donor's
    // long-term holding period is recorded so it can tack.
    expect(r.asGifts.fmv).toBeGreaterThan(0);
    expect(r.asGifts.basis).toBeGreaterThan(0);
    expect(r.asGifts.terms).toEqual(['LT', 'LT']);
    expect(r.asGifts.recipients).toEqual(['Recipient One']);

    // Per recipient per year — the unit the annual exclusion is measured in.
    expect(r.byYear).toHaveLength(1);
    expect(r.byYear[0].recipient).toBe('Recipient One');
    expect(r.byYear[0].year).toBe(2025);
    expect(r.byYear[0].count).toBe(2);

    // A gift recipient is not the user, and is never fetched.
    expect(r.asGifts.ownedNow).toBe(false);
    expect(r.asGifts.inWalletList).toBe(false);
    expect(r.asGifts.exclusive).toBe(false);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a wallet whose key is lost keeps draining without manufacturing gains, and leaves the portfolio', async () => {
  // Three Evernode host accounts lost their secrets in a server crash. They
  // are still live on the network and hooks/fees keep spending XAH out of
  // them until they hit zero, and nobody can stop it.
  //
  // Two distinct errors follow if this is not modelled. Every involuntary
  // outflow is booked as a taxable sale at market value — manufacturing gains
  // out of a loss, every year, until the accounts drain. And the stranded
  // coins are counted in the portfolio, overstating what the user owns.
  //
  // The date access was lost is the hinge: activity BEFORE it was real,
  // controlled activity and must still be taxed normally.
  const { app, win, home } = await launch();
  try {
    const r = await win.evaluate(async () => {
      const lost = 'wLostHostWallet';
      const LOST_ON = '2024-06-01';
      WALLETS.length = 0; WALLETS.push(lost);   // lost wallets ARE fetched
      await window.taxDB.clearWalletChain(lost, 'Xahau');
      const pay = (h, ts, from, to, amt) => ({
        tx_hash: h, timestamp: ts, raw_json: JSON.stringify({
          Account: from, Destination: to, TransactionType: 'Payment',
          TransactionResult: 'tesSUCCESS', Timestamp: ts, TransactionHash: h,
          delivered_amount_XRP: String(amt), Amount_XRP: String(amt),
          Amount_value: '', Amount_currency: '' }) });
      await window.taxDB.insertRows(lost, 'Xahau', [
        pay('FUND',  '2024-02-01 10:00:00', 'rExchangeWithdrawal', lost, 10000),
        // BEFORE the key was lost — a real, controlled payment out. Taxable.
        pay('REAL',  '2024-03-01 10:00:00', lost, 'rSomeoneElse', 1000),
        // AFTER — hooks and fees draining the account. Not taxable.
        pay('DRAIN1','2024-08-01 10:00:00', lost, 'rHookSink', 500),
        pay('DRAIN2','2025-02-01 10:00:00', lost, 'rHookSink', 700),
        pay('DRAIN3','2025-11-01 10:00:00', lost, 'rHookSink', 800),
      ]);
      await window.taxDB.upsertSyncState(lost, 'Xahau', '2025-12-31 00:00:00');

      // ── Before marking: every outflow is a sale ────────────────────────
      lostWallets.length = 0; giftAddresses.length = 0; transferOnlyAddresses.length = 0;
      await buildReportFromCache({ silent: true });
      const unmarked = {
        disposals: allDisposalsHigh.length,
        proceeds: allDisposalsHigh.reduce((s,d)=>s+d.proceedsH,0),
        lostRows: allLostSpendRows.length,
        portfolio: computeHoldings().reduce((s,h)=>s+h.value,0),
      };

      // ── After marking ─────────────────────────────────────────────────
      setLostWallet(lost, LOST_ON, 'Test host');
      await buildReportFromCache({ silent: true });
      const all = computeHoldings();
      const marked = {
        disposals: allDisposalsHigh.length,
        // makeTxHash hex-encodes the raw hash, so identify the surviving
        // disposal by its date instead — 1 Mar 2024, before the key was lost.
        disposalDates: allDisposalsHigh.map(d => d.dk),
        disposalQty: allDisposalsHigh.reduce((s,d)=>s+d.qty,0),
        lostRows: allLostSpendRows.length,
        lostQty: allLostSpendRows.reduce((s,x)=>s+x.qty,0),
        lostBasis: allLostSpendRows.reduce((s,x)=>s+x.basis,0),
        lostYears: [...new Set(allLostSpendRows.map(x=>x.year))].sort(),
        // Portfolio excludes the lost wallet; the stranded balance is still
        // visible separately rather than vanishing from the books.
        portfolioExcludingLost: all.filter(h=>!isLostWallet(h.wallet)).reduce((s,h)=>s+h.value,0),
        strandedQty: all.filter(h=>isLostWallet(h.wallet)).reduce((s,h)=>s+h.qty,0),
        strandedBasis: all.filter(h=>isLostWallet(h.wallet)).reduce((s,h)=>s+h.basis,0),
      };
      lostWallets.length = 0;
      return { unmarked, marked };
    });

    // Unmarked, all four outflows were booked as taxable sales.
    expect(r.unmarked.disposals).toBe(4);
    expect(r.unmarked.proceeds).toBeGreaterThan(0);
    expect(r.unmarked.lostRows).toBe(0);

    // Marked: only the pre-loss payment survives as a disposal. The date is
    // doing real work here — this is not "exclude the whole wallet".
    expect(r.marked.disposals).toBe(1);
    expect(r.marked.disposalDates).toEqual(['2024-03-01']);
    expect(r.marked.disposalQty).toBeCloseTo(1000, 6);

    // The three post-loss drains are recorded, not discarded, across years.
    expect(r.marked.lostRows).toBe(3);
    expect(r.marked.lostQty).toBeCloseTo(2000, 6);
    expect(r.marked.lostBasis).toBeGreaterThan(0);
    expect(r.marked.lostYears).toEqual([2024, 2025]);

    // 10,000 in − 1,000 sold − 2,000 drained = 7,000 stranded, and none of
    // it counts toward the portfolio.
    expect(r.marked.strandedQty).toBeCloseTo(7000, 6);
    expect(r.marked.strandedBasis).toBeGreaterThan(0);
    expect(r.marked.portfolioExcludingLost).toBe(0);
    expect(r.unmarked.portfolio).toBeGreaterThan(0);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the wallet CSV routes each address to exactly one category, and gift/mine are never fetchable', async () => {
  // Four categories now, and they differ on the two questions that matter:
  // is a transfer out taxable, and is the address fetched. Getting the second
  // wrong is expensive in both directions — fetching an exchange hot wallet
  // would blow up the cache, and fetching a gift address would pull a family
  // member's whole financial history into this file.
  //
  // The re-classification case is the subtle one: importing a file that
  // demotes an active wallet to gift must REMOVE it from WALLETS and from the
  // fetch selection, not just add it to the gift list.
  const { app, win, home } = await launch();
  try {
    const r = await win.evaluate(async () => {
      WALLETS.length = 0; selected.length = 0;
      transferOnlyAddresses.length = 0; giftAddresses.length = 0; lostWallets.length = 0;

      // Synthetic addresses. R_ADDR_RE enforces the base58 alphabet, which
      // excludes 0/O/I/l, so casual invented names like "rMyWallet" do not
      // validate — these are generated to satisfy it without belonging to
      // anyone. Never put a real address in a test.
      const ACTIVE = 'rycjSH6ZgDSqNfUPvfgKNmtTCTE1eMn9NP';
      const LOST   = 'rqauguvPi9SbeuGwJq8qifvFxdrbcu8fER';
      const GIFT   = 'rFWZLoGbeHa5xZYyYdNw21ifSHcZpfadeM';
      const MINE   = 'rZg5vPkMc5JM49CMYsaDvRxuiwL3abUBxT';
      const NODATE = 'rgZeTc7afk1xbYwgoib8hpozKJRnfSFt1J';
      const NONAME = 'r8dzoamNbcsUR2oeRnM2FUsaqnXpbgovbN';
      const csv = [
        'Address,Type,Label,Date Lost,Gift Recipient',
        `${ACTIVE},active,Main wallet,,`,
        // The literal label style from the user's own audit spreadsheet.
        `${LOST},LOST KEY - Postnode,Postnode.xrp,2024-06-01,`,
        `${GIFT},gift,,,"Daughter, One"`,          // quoted comma in a field
        `${MINE},Exchange,Kraken deposit,,`,
        `${NODATE},lost,No date given,,`,          // error: lost with no date
        'notAnRAddress,active,,,',                 // error: bad address
        `${NONAME},gift,,,`,                       // error: gift with no name
      ].join('\n');

      const parsed = parseWalletCSV(csv);
      const applied = applyWalletCSV(parsed.rows);

      // Select everything selectable, then re-import with one wallet demoted.
      selectAll();
      const selectedBefore = [...selected];
      const demote = parseWalletCSV(`Address,Type,Gift Recipient\n${ACTIVE},gift,Recipient Two`);
      applyWalletCSV(demote.rows);
      renderWallets('');

      const out = {
        parsedCount: parsed.rows.length,
        errorCount: parsed.errors.length,
        errors: parsed.errors,
        types: parsed.rows.map(x => `${x.addr}:${x.type}`),
        // The quoted field survived the parse intact.
        giftRecipient: (parsed.rows.find(x => x.type === 'gift') || {}).recipient,
        lostDate: (parsed.rows.find(x => x.type === 'lost') || {}).lostDate,
        applied,
        // Fetchable = WALLETS. Gift and mine must not be in it.
        walletsAfterFirst: null,
        selectedBefore,
        // After the demotion:
        stillInWallets: WALLETS.includes(ACTIVE),
        stillSelected: selected.includes(ACTIVE),
        nowGift: isGiftAddress(ACTIVE),
        // No address may appear in two lists at once.
        doubleListed: classifiedWallets().filter(e => {
          const n = [WALLETS.includes(e.addr), isGiftAddress(e.addr) , isTransferOnly(e.addr)]
            .filter(Boolean).length;
          return isLostWallet(e.addr) ? n > 1 : n > 1;
        }).map(e => e.addr),
        classified: classifiedWallets().map(e => `${e.addr}:${e.type}`).sort(),
      };

      // Round-trip: export and re-import must reproduce the same state.
      const exported = [WALLET_CSV_HEADER];
      for(const w of lostWallets) exported.push([w.addr,'lost',w.note||'',w.lostDate||'',''].map(csvField).join(','));
      for(const g of giftAddresses) exported.push([g.addr,'gift','','',g.recipient||''].map(csvField).join(','));
      for(const a of transferOnlyAddresses) exported.push([a,'mine','','',''].map(csvField).join(','));
      for(const w of WALLETS) if(!isLostWallet(w)) exported.push([w,'active','','',''].map(csvField).join(','));
      const before = out.classified.join('|');
      WALLETS.length = 0; transferOnlyAddresses.length = 0; giftAddresses.length = 0; lostWallets.length = 0;
      applyWalletCSV(parseWalletCSV(exported.join('\n')).rows);
      out.roundTripped = classifiedWallets().map(e => `${e.addr}:${e.type}`).sort().join('|') === before;
      out.roundTripLostDate = (lostWallets[0]||{}).lostDate;

      WALLETS.length = 0; selected.length = 0;
      transferOnlyAddresses.length = 0; giftAddresses.length = 0; lostWallets.length = 0;
      return out;
    });

    // Four good rows, three rejected — each with a reason naming the line.
    expect(r.parsedCount).toBe(4);
    expect(r.errorCount).toBe(3);
    expect(r.errors.some(e => e.includes('Date Lost'))).toBe(true);
    expect(r.errors.some(e => e.includes('not a valid r-address'))).toBe(true);
    expect(r.errors.some(e => e.includes('recipient'))).toBe(true);

    // "LOST KEY - Postnode" and "Exchange" both normalise, so the labels
    // already in the user's audit spreadsheet import without editing.
    expect(r.types).toContain('rqauguvPi9SbeuGwJq8qifvFxdrbcu8fER:lost');
    expect(r.types).toContain('rZg5vPkMc5JM49CMYsaDvRxuiwL3abUBxT:mine');
    expect(r.lostDate).toBe('2024-06-01');
    expect(r.giftRecipient).toBe('Daughter, One');   // quoted comma preserved

    expect(r.applied.active).toBe(1);
    expect(r.applied.lost).toBe(1);
    expect(r.applied.gift).toBe(1);
    expect(r.applied.mine).toBe(1);

    // Only active + lost were ever selectable for fetching.
    expect(r.selectedBefore.sort()).toEqual(
      ['rqauguvPi9SbeuGwJq8qifvFxdrbcu8fER','rycjSH6ZgDSqNfUPvfgKNmtTCTE1eMn9NP'].sort());

    // Re-classifying moved it out of the fetch list AND out of the selection.
    expect(r.nowGift).toBe(true);
    expect(r.stillInWallets).toBe(false);
    expect(r.stillSelected).toBe(false);

    // Nothing is ever in two categories at once.
    expect(r.doubleListed).toEqual([]);

    // Export → import reproduces the configuration, loss date included.
    expect(r.roundTripped).toBe(true);
    expect(r.roundTripLostDate).toBe('2024-06-01');
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the Holdings page paints without waiting on the full-cache round-trip scan', async () => {
  // The regression this replaces: computeCounterpartyFlows() reads EVERY
  // cached row, and renderHoldings() awaited it inline. On a 4.6M-row cache
  // the page sat on "Scanning the cache for return flows…" and never painted
  // — the same blank-page failure mode the app had already been through once.
  // The scan is now opt-in and cached; the tables come from the in-memory
  // ledger and must render regardless.
  const { app, win, home } = await launch();
  try {
    const r = await win.evaluate(async () => {
      const mine = 'wPaintTestWallet';
      WALLETS.length = 0; WALLETS.push(mine);
      await window.taxDB.clearWalletChain(mine, 'Xahau');
      const rows = [];
      for(let i = 0; i < 4000; i++) {
        const ts = `2025-0${(i%9)+1}-1${i%9} 10:00:0${i%10}`;
        rows.push({ tx_hash: 'PAINT'+i, timestamp: ts, raw_json: JSON.stringify({
          Account: i%2 ? mine : 'rExt'+(i%40), Destination: i%2 ? 'rExt'+(i%40) : mine,
          TransactionType:'Payment', TransactionResult:'tesSUCCESS', Timestamp: ts,
          TransactionHash:'PAINT'+i, delivered_amount_XRP:'100', Amount_XRP:'100',
          Amount_value:'', Amount_currency:'' })});
      }
      await window.taxDB.insertRows(mine, 'Xahau', rows);
      await window.taxDB.upsertSyncState(mine, 'Xahau', '2025-12-31 00:00:00');
      transferOnlyAddresses.length = 0; giftAddresses.length = 0; lostWallets.length = 0;
      await buildReportFromCache({ silent: true });

      // A rebuild must invalidate any earlier scan result.
      const cacheAfterRebuild = _flowsCache;

      document.getElementById('holdingsBody').innerHTML = '';
      const t0 = performance.now();
      await renderHoldings();
      const paintMs = performance.now() - t0;
      const html = document.getElementById('holdingsBody').innerHTML;

      // Now run the scan explicitly and re-render.
      await scanCounterpartyFlows();
      const htmlAfter = document.getElementById('holdingsBody').innerHTML;

      return {
        cacheAfterRebuild,
        paintMs,
        paintedTables: html.includes('Holdings by wallet') && html.includes('Where the'),
        stuckOnScan: html.includes('Scanning the cache'),
        offersScan: html.includes('Scan for round trips'),
        saysNotScanned: html.includes('not scanned yet'),
        scannedAfter: htmlAfter.includes('one-way') || htmlAfter.includes('ROUND TRIP'),
        cacheNowSet: !!_flowsCache,
      };
    });

    // A rebuild clears any stale scan.
    expect(r.cacheAfterRebuild).toBeNull();

    // The page paints the real tables, fast, without running the scan.
    expect(r.paintedTables).toBe(true);
    expect(r.stuckOnScan).toBe(false);
    expect(r.paintMs).toBeLessThan(2000);

    // The scan is offered rather than performed, and the column says so.
    expect(r.offersScan).toBe(true);
    expect(r.saysNotScanned).toBe(true);

    // Running it explicitly fills the column in and caches the result.
    expect(r.scannedAfter).toBe(true);
    expect(r.cacheNowSet).toBe(true);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('marking an exchange address as mine must not destroy the basis of what you withdraw from it', async () => {
  // The trap in the advice "just mark your exchange deposit address as mine".
  //
  // The inbound guard was `dest === wallet && !ownSrc`. Marking the exchange
  // address makes ownSrc TRUE, so an arrival from it matched nothing — and
  // there is no outbound side either, because the address is never fetched.
  // Every coin withdrawn from that exchange entered the ledger with no lot at
  // all, and the eventual sale was computed at $0 basis, short-term: the
  // maximum possible tax, caused by correctly classifying an address.
  //
  // Two shapes must both come out right:
  //   round trip  — deposit then withdraw the same coins: original basis and
  //                 acquisition date come back, so the holding period tacks
  //   bought there — withdrawing more than was deposited: the excess takes the
  //                 market price on arrival, and is disclosed as inferred
  const { app, win, home } = await launch();
  try {
    const r = await win.evaluate(async () => {
      const mine = 'wExchangeUserWallet';
      const exch = 'rZg5vPkMc5JM49CMYsaDvRxuiwL3abUBxT'; // stands in for Uphold
      WALLETS.length = 0; WALLETS.push(mine);
      await window.taxDB.clearWalletChain(mine, 'XRPL');
      const pay = (h, ts, from, to, amt) => ({
        tx_hash: h, timestamp: ts, raw_json: JSON.stringify({
          Account: from, Destination: to, TransactionType: 'Payment',
          TransactionResult: 'tesSUCCESS', Timestamp: ts, TransactionHash: h,
          delivered_amount_XRP: String(amt), Amount_XRP: String(amt),
          Amount_value: '', Amount_currency: '' }) });
      await window.taxDB.insertRows(mine, 'XRPL', [
        pay('XBUY',  '2022-01-10 10:00:00', 'rExchangeWithdrawal', mine, 10000),
        pay('XDEP',  '2024-03-01 10:00:00', mine, exch, 4000),   // deposit to the exchange
        pay('XWD',   '2025-06-01 10:00:00', exch, mine, 6000),   // withdraw MORE than deposited
      ]);
      await window.taxDB.upsertSyncState(mine, 'XRPL', '2025-12-31 00:00:00');

      transferOnlyAddresses.length = 0; giftAddresses.length = 0; lostWallets.length = 0;
      transferOnlyAddresses.push(exch);
      await buildReportFromCache({ silent: true });

      const lots = (walletLedger[mine]||{}).XRP || [];
      const held = computeHoldings().filter(h => h.wallet === mine && h.ticker === 'XRP');
      const out = {
        // The deposit is not a sale, and the withdrawal is not income.
        disposals: allDisposalsHigh.length,
        income: allIncomeRows.length,
        // 10,000 in − 4,000 deposited + 6,000 withdrawn = 12,000 held.
        heldQty: held.reduce((s,h)=>s+h.qty, 0),
        heldBasis: held.reduce((s,h)=>s+h.basis, 0),
        // 4,000 came back as the original 2022 lots; 2,000 was bought on the
        // exchange and priced at the 2025 arrival date.
        sources: lots.filter(l=>l.remaining>0).map(l => `${l.source}:${Math.round(l.remaining)}`).sort(),
        tackedDates: lots.filter(l=>l.remaining>0 && l.source==='transfer_in').map(l=>l.date),
        inferredCount: inferredBasisRows.length,
        inferredQty: inferredBasisRows.reduce((s,x)=>s+x.qty,0),
        inferredPriced: inferredBasisRows.every(x => x.unitCost > 0),
        disclosed: dataQualityHTML().includes('inferred, not observed'),
      };
      transferOnlyAddresses.length = 0;
      return out;
    });

    // Moving your own coins to and from your own exchange account is neither
    // a sale nor income.
    expect(r.disposals).toBe(0);
    expect(r.income).toBe(0);

    // Nothing vanished: every coin is still accounted for.
    expect(r.heldQty).toBeCloseTo(12000, 6);

    // And critically, the basis did NOT collapse to zero.
    expect(r.heldBasis).toBeGreaterThan(0);

    // 6,000 remaining from the original buy, 4,000 returned with their
    // original lots, 2,000 inferred at the arrival price.
    expect(r.sources).toEqual(['exchange_withdrawal:2000','received_market:6000','transfer_in:4000']);

    // The returned coins kept their 2022 acquisition date, so the holding
    // period tacks rather than restarting on withdrawal.
    expect(r.tackedDates.every(d => String(d).startsWith('2022'))).toBe(true);

    // The inferred portion is priced and disclosed, not silently assumed.
    expect(r.inferredCount).toBe(1);
    expect(r.inferredQty).toBeCloseTo(2000, 6);
    expect(r.inferredPriced).toBe(true);
    expect(r.disclosed).toBe(true);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a shared service address is identified by its counterparty count, not by recognising it', async () => {
  // The failure this exists to catch: an address that is NOT a personal wallet
  // — a bridge, an exchange hot wallet, a payment service — classified as
  // `active`. The app then fetches its entire public history and books every
  // payment it makes to any stranger as the user's own taxable sale. Funds
  // merely passing through become millions of dollars of fictional proceeds
  // whose basis nearly equals them, which is why the gain looks small while
  // the proceeds look absurd.
  //
  // No amount of price or FIFO correctness catches this, because every
  // individual disposal is computed correctly. The only signal available is
  // the SHAPE of the activity: a personal wallet deals with a handful of
  // addresses; a service deals with thousands, most of them exactly once.
  const { app, win, home } = await launch();
  try {
    const r = await win.evaluate(async () => {
      const personal = 'wPersonalWallet';
      const service  = 'wServiceHotWallet';
      WALLETS.length = 0; WALLETS.push(personal, service);   // the service is misclassified `active` — that is the scenario
      await window.taxDB.clearWalletChain(personal, 'XRPL');
      await window.taxDB.clearWalletChain(service, 'XRPL');
      const pay = (h, ts, from, to, amt) => ({
        tx_hash: h, timestamp: ts, raw_json: JSON.stringify({
          Account: from, Destination: to, TransactionType: 'Payment',
          TransactionResult: 'tesSUCCESS', Timestamp: ts, TransactionHash: h,
          delivered_amount_XRP: String(amt), Amount_XRP: String(amt),
          Amount_value: '', Amount_currency: '' }) });

      // A normal personal wallet: funded once, a few payments to four people.
      const pRows = [pay('P0', '2024-01-02 10:00:00', 'rFunding', personal, 50000)];
      for(let i = 0; i < 8; i++) {
        pRows.push(pay('P'+(i+1), `2025-03-0${(i%9)+1} 10:00:00`, personal, 'rFriend'+(i%4), 500));
      }
      await window.taxDB.insertRows(personal, 'XRPL', pRows);
      await window.taxDB.upsertSyncState(personal, 'XRPL', '2025-12-31 00:00:00');

      // A service address: money in from strangers, straight back out to
      // different strangers. 600 distinct counterparties, most seen once.
      const sRows = [];
      for(let i = 0; i < 300; i++) {
        const d = String((i % 28) + 1).padStart(2, '0');
        const m = String((i % 12) + 1).padStart(2, '0');
        sRows.push(pay('SIN'+i,  `2025-${m}-${d} 09:00:00`, 'rUserIn'+i,  service, 1000));
        sRows.push(pay('SOUT'+i, `2025-${m}-${d} 11:00:00`, service, 'rUserOut'+i, 1000));
      }
      await window.taxDB.insertRows(service, 'XRPL', sRows);
      await window.taxDB.upsertSyncState(service, 'XRPL', '2025-12-31 00:00:00');

      transferOnlyAddresses.length = 0; giftAddresses.length = 0; lostWallets.length = 0;
      walletLabels['wServiceHotWallet'] = 'Some Bridge';
      await buildReportFromCache({ silent: true });
      applyReportingYear(2025);

      const acts = computeWalletActivity(2025);
      const svc = acts.find(a => a.wallet === service);
      const per = acts.find(a => a.wallet === personal);
      const out = {
        // The service dominates the proceeds — the shape of the real problem.
        topWallet: acts[0].wallet,
        svc: svc && { peers: svc.peers, suspect: svc.suspect, passThrough: svc.passThrough,
                      count: svc.count, label: svc.label },
        per: per && { peers: per.peers, suspect: per.suspect, passThrough: per.passThrough,
                      count: per.count },
        bannerWarns: walletActivityHTML(2025).includes('unusually large number of one-time'),
        // Proceeds ≈ basis is the fingerprint of pass-through, and must show up.
        proceeds: allDisposalsHigh.filter(d=>d.year===2025).reduce((s,d)=>s+d.proceedsH,0),
        basis: allDisposalsHigh.filter(d=>d.year===2025).reduce((s,d)=>s+d.basis,0),
      };
      delete walletLabels['wServiceHotWallet'];
      return out;
    });

    // The service address is flagged, on evidence, without being recognised.
    // 300 senders + 300 recipients = 600 counterparties, every one a one-off.
    expect(r.svc.peers).toBeGreaterThanOrEqual(500);
    expect(r.svc.passThrough).toBe(true);
    expect(r.svc.suspect).toBe(true);
    expect(r.svc.label).toBe('Some Bridge');   // labels survive for diagnostics

    // The genuine personal wallet is NOT flagged — this must not cry wolf.
    expect(r.per.peers).toBeLessThan(50);
    expect(r.per.suspect).toBe(false);

    // It sorts to the top by proceeds, which is what makes it findable.
    expect(r.topWallet).toBe('wServiceHotWallet');
    expect(r.bannerWarns).toBe(true);

    // And the pass-through fingerprint is present: basis nearly equals
    // proceeds, so an enormous "proceeds" figure yields a trivial gain.
    expect(r.basis / r.proceeds).toBeGreaterThan(0.9);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('reclassifying a shared address actually removes its activity — stale cached rows are not processed', async () => {
  // The bug that made the $24.6M survive being diagnosed.
  //
  // Exchanges and bridges use ONE shared address for every customer, separated
  // by destination tag. Classify one `active` and its whole public history is
  // fetched. The user then works out which address it is and reclassifies it —
  // and nothing changes, because the ledger build pages over the entire cache
  // BY CHAIN, not by wallet list. The stale rows keep being processed from
  // that address's perspective.
  //
  // Worse, the damage propagates: the bridge's onward transfers to a Coinbase
  // address the user had correctly marked `mine` piled up 913,410 XRP of
  // phantom "holdings" they had never sent.
  //
  // A cached row is a PERSPECTIVE — "wallet W's view of transaction T" — and
  // may only be processed if W is a wallet the user actually owns and fetches.
  const { app, win, home } = await launch();
  try {
    const r = await win.evaluate(async () => {
      const mine     = 'wMyRealWallet';
      const bridge   = 'wSharedBridgeAddress';
      const exchange = 'wMyExchangeDeposit';
      for(const w of [mine, bridge]) await window.taxDB.clearWalletChain(w, 'XRPL');
      const pay = (h, ts, from, to, amt) => ({
        tx_hash: h, timestamp: ts, raw_json: JSON.stringify({
          Account: from, Destination: to, TransactionType: 'Payment',
          TransactionResult: 'tesSUCCESS', Timestamp: ts, TransactionHash: h,
          delivered_amount_XRP: String(amt), Amount_XRP: String(amt),
          Amount_value: '', Amount_currency: '' }) });

      // The user's own modest activity: funded, then one real sale.
      await window.taxDB.insertRows(mine, 'XRPL', [
        pay('M0', '2024-01-02 10:00:00', 'rFunding', mine, 5000),
        pay('M1', '2025-05-01 10:00:00', mine, 'rRealBuyer', 1000),
      ]);
      await window.taxDB.upsertSyncState(mine, 'XRPL', '2025-12-31 00:00:00');

      // The bridge's public history, cached because it was once `active`:
      // strangers in, strangers out, plus large onward transfers to the
      // exchange address — none of it the user's money.
      const bRows = [];
      for(let i = 0; i < 60; i++) {
        const d = String((i % 28) + 1).padStart(2, '0');
        bRows.push(pay('BIN'+i,  `2025-06-${d} 09:00:00`, 'rStranger'+i, bridge, 5000));
        bRows.push(pay('BOUT'+i, `2025-06-${d} 11:00:00`, bridge, 'rOther'+i,  4000));
        bRows.push(pay('BEX'+i,  `2025-06-${d} 12:00:00`, bridge, exchange,    1000));
      }
      await window.taxDB.insertRows(bridge, 'XRPL', bRows);
      await window.taxDB.upsertSyncState(bridge, 'XRPL', '2025-12-31 00:00:00');

      const measure = () => {
        applyReportingYear(2025);
        const d25 = allDisposalsHigh.filter(x => x.year === 2025);
        const exchQty = computeHoldings()
          .filter(h => h.wallet === exchange).reduce((s,h)=>s+h.qty, 0);
        return { disposals: d25.length, proceeds: d25.reduce((s,x)=>s+x.proceedsH,0), exchQty };
      };

      // ── Misclassified: bridge is `active` ─────────────────────────────
      WALLETS.length = 0; WALLETS.push(mine, bridge);
      transferOnlyAddresses.length = 0; transferOnlyAddresses.push(exchange);
      giftAddresses.length = 0; lostWallets.length = 0;
      await buildReportFromCache({ silent: true });
      const wrong = measure();
      const skippedWhenWrong = rowsSkippedNotOwned;

      // ── Reclassified: bridge removed from the wallet list ─────────────
      // The cached rows are still in the database and are still streamed.
      WALLETS.length = 0; WALLETS.push(mine);
      await buildReportFromCache({ silent: true });
      const right = measure();

      const out = {
        wrong, right,
        skippedWhenWrong,
        skippedWhenRight: rowsSkippedNotOwned,
        streamed: rowsStreamedThisBuild,
        cachedRows: await window.taxDB.countForChain('XRPL'),
        // The invariant that catches double-processing must still hold:
        // skipped rows are read past, not un-counted.
        countsReconcile: ledgerCountMismatch === null,
        disclosed: dataQualityHTML().includes('cached row(s) were skipped'),
      };
      WALLETS.length = 0; transferOnlyAddresses.length = 0;
      return out;
    });

    // Misclassified, the bridge manufactures disposals and stuffs the
    // exchange address with coins the user never sent.
    // 60 payments to strangers become phantom sales; the 60 onward transfers
    // to the exchange address are (correctly) transfers, not sales — which is
    // precisely why they silently inflate the exchange balance instead.
    expect(r.wrong.disposals).toBe(61);
    expect(r.wrong.proceeds).toBeGreaterThan(100000);
    expect(r.wrong.exchQty).toBeCloseTo(60000, 0);   // 60 x 1,000 phantom XRP
    expect(r.skippedWhenWrong).toBe(0);

    // Reclassified, only the user's own single sale survives, and the
    // phantom exchange balance is gone entirely.
    expect(r.right.disposals).toBe(1);
    expect(r.right.proceeds).toBeLessThan(10000);
    expect(r.right.exchQty).toBe(0);
    expect(r.skippedWhenRight).toBe(180);            // 3 x 60 bridge rows

    // Skipped rows are still counted, so the double-processing invariant
    // keeps working rather than firing a false "DO NOT FILE" alarm.
    expect(r.streamed).toBe(r.cachedRows);
    expect(r.countsReconcile).toBe(true);

    // And the skip is disclosed rather than silent.
    expect(r.disclosed).toBe(true);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Remove All Wallets clears every classification, and lost wallets can never drift out of the fetch list', async () => {
  // Two bugs from one screenshot. "Remove All Wallets" cleared only WALLETS,
  // so 8 lost + 4 gift + 6 mine addresses stayed on screen after the user had
  // asked for everything to go.
  //
  // The second is the dangerous one. A lost wallet lives in BOTH lostWallets
  // and WALLETS — it is still the user's and is still fetched. Clearing only
  // WALLETS left it visible in the list while dropping it from the set the
  // perspective guard checks, so its cached history would be silently skipped:
  // the drainage from those accounts would vanish from the report with nothing
  // on screen to say so.
  const { app, win, home } = await launch();
  try {
    const r = await win.evaluate(async () => {
      WALLETS.length = 0; selected.length = 0;
      transferOnlyAddresses.length = 0; giftAddresses.length = 0; lostWallets.length = 0;
      walletLabels = {};
      applyWalletCSV(parseWalletCSV([
        'Address,Type,Label,Date Lost,Gift Recipient',
        'rycjSH6ZgDSqNfUPvfgKNmtTCTE1eMn9NP,active,Main,,',
        'rqauguvPi9SbeuGwJq8qifvFxdrbcu8fER,lost,Postnode,2024-01-30,',
        'rFWZLoGbeHa5xZYyYdNw21ifSHcZpfadeM,gift,,,Recipient One',
        'rpTUDzRcmp9CBS9GRY9kM4mCZ8oLqtuNHG,mine,Coinbase,,',
      ].join('\n')).rows);

      const LOST = 'rqauguvPi9SbeuGwJq8qifvFxdrbcu8fER';
      const before = {
        classified: classifiedWallets().length,
        lostInWallets: WALLETS.includes(LOST),
        lostFetchable: isFetchableOwnWallet(LOST),
      };

      // Simulate the exact old failure: drop WALLETS only, as the old
      // clearAllWallets did, then let reconciliation repair it.
      WALLETS.length = 0;
      const drifted = { fetchableWhileDrifted: isFetchableOwnWallet(LOST) };
      reconcileClassification();
      const repaired = { lostBackInWallets: WALLETS.includes(LOST) };

      // Gift and mine must never be pushed into the fetch list by repair.
      const leaked = WALLETS.filter(w => isGiftAddress(w) || isTransferOnly(w));

      // Now the real clear, minus the confirm dialog.
      const realClear = () => {
        WALLETS = []; selected = [];
        transferOnlyAddresses = []; giftAddresses = []; lostWallets = []; walletLabels = {};
        saveWalletList(); saveSelected(); saveTransferOnly(); saveGifts(); saveLost(); saveLabels();
      };
      realClear();
      reconcileClassification();
      const after = {
        classified: classifiedWallets().length,
        wallets: WALLETS.length, gifts: giftAddresses.length,
        lost: lostWallets.length, mine: transferOnlyAddresses.length,
        labels: Object.keys(walletLabels).length,
      };
      return { before, drifted, repaired, leaked, after };
    });

    expect(r.before.classified).toBe(4);
    expect(r.before.lostInWallets).toBe(true);
    expect(r.before.lostFetchable).toBe(true);

    // Even mid-drift a lost wallet stays fetchable — belt and braces, so a
    // future path that forgets to reconcile cannot silently drop its data.
    expect(r.drifted.fetchableWhileDrifted).toBe(true);
    expect(r.repaired.lostBackInWallets).toBe(true);

    // Repair never promotes a gift or exchange address into the fetch list.
    expect(r.leaked).toEqual([]);

    // And "remove all" really removes all four lists plus the labels.
    expect(r.after).toEqual({ classified: 0, wallets: 0, gifts: 0, lost: 0, mine: 0, labels: 0 });
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the service-address heuristic needs scale AND churn, so a busy personal wallet is not flagged', async () => {
  // Retune after a false positive on real data. The first version flagged a
  // genuine main wallet with 118 counterparties built up over five years,
  // because it also treated "funds pass through" as evidence — which is
  // NORMAL for an Evernode host, where rewards arrive and get swept onward.
  //
  // A false positive here is expensive: it tells someone to delete a real
  // wallet, which would drop real disposals off their tax return. The address
  // that actually caused the problem had 1,339 counterparties in a single
  // year, most seen exactly once. So the test needs both scale and churn, and
  // pass-through is reported but never votes.
  const { app, win, home } = await launch();
  try {
    const r = await win.evaluate(async () => {
      const busy    = 'wBusyPersonalWallet';   // many peers, but REUSED
      const service = 'wRealServiceAddress';   // many peers, each seen once
      for(const w of [busy, service]) await window.taxDB.clearWalletChain(w, 'XRPL');
      const pay = (h, ts, from, to, amt) => ({
        tx_hash: h, timestamp: ts, raw_json: JSON.stringify({
          Account: from, Destination: to, TransactionType: 'Payment',
          TransactionResult: 'tesSUCCESS', Timestamp: ts, TransactionHash: h,
          delivered_amount_XRP: String(amt), Amount_XRP: String(amt),
          Amount_value: '', Amount_currency: '' }) });

      // A real, busy wallet: 120 counterparties, each dealt with repeatedly,
      // and funds do pass through it — the exact shape that was wrongly
      // flagged.
      // Small opening balance so inbound ~= outbound and the wallet genuinely
      // reads as "passes through" — the property that used to convict it.
      const bRows = [pay('BF', '2024-01-02 10:00:00', 'rFund', busy, 20000)];
      for(let i = 0; i < 120; i++) {
        for(let k = 0; k < 4; k++) {
          const d = String(((i + k) % 28) + 1).padStart(2, '0');
          const m = String(((i + k) % 12) + 1).padStart(2, '0');
          bRows.push(pay(`BI${i}_${k}`, `2025-${m}-${d} 09:00:00`, 'rPeer'+i, busy, 300));
          bRows.push(pay(`BO${i}_${k}`, `2025-${m}-${d} 15:00:00`, busy, 'rPeer'+i, 300));
        }
      }
      await window.taxDB.insertRows(busy, 'XRPL', bRows);
      await window.taxDB.upsertSyncState(busy, 'XRPL', '2025-12-31 00:00:00');

      // A genuine service: 700 counterparties, every one seen exactly once.
      const sRows = [];
      for(let i = 0; i < 700; i++) {
        const d = String((i % 28) + 1).padStart(2, '0');
        const m = String((i % 12) + 1).padStart(2, '0');
        sRows.push(pay('SO'+i, `2025-${m}-${d} 11:00:00`, service, 'rCustomer'+i, 400));
      }
      await window.taxDB.insertRows(service, 'XRPL', sRows);
      await window.taxDB.upsertSyncState(service, 'XRPL', '2025-12-31 00:00:00');

      WALLETS.length = 0; WALLETS.push(busy, service);
      transferOnlyAddresses.length = 0; giftAddresses.length = 0; lostWallets.length = 0;
      await buildReportFromCache({ silent: true });
      applyReportingYear(2025);

      const acts = computeWalletActivity(2025);
      const b = acts.find(a => a.wallet === busy);
      const sv = acts.find(a => a.wallet === service);
      const out = {
        busy: { peers: b.peers, oneTimeShare: b.oneTimeShare, passThrough: b.passThrough, suspect: b.suspect },
        svc:  { peers: sv.peers, oneTimeShare: sv.oneTimeShare, suspect: sv.suspect },
        // The advice must offer "mark it mine" for an address the user has an
        // account at, not only deletion — deleting one would turn transfers to
        // it back into taxable sales.
        offersMine: walletActivityHTML(2025).includes('mark it <b>mine</b>'),
        callsItAHint: walletActivityHTML(2025).includes('a hint, not a verdict'),
      };
      WALLETS.length = 0;
      return out;
    });

    // The busy personal wallet: lots of counterparties, funds passing through
    // — and NOT flagged, because it reuses its counterparties.
    expect(r.busy.peers).toBeGreaterThanOrEqual(100);
    expect(r.busy.passThrough).toBe(true);
    expect(r.busy.oneTimeShare).toBeLessThan(0.6);
    expect(r.busy.suspect).toBe(false);

    // The service: same order of magnitude of activity, but every
    // counterparty is a one-off. Flagged.
    expect(r.svc.peers).toBeGreaterThanOrEqual(500);
    expect(r.svc.oneTimeShare).toBeGreaterThan(0.9);
    expect(r.svc.suspect).toBe(true);

    // And the remedy text covers the "I have an account there" case.
    expect(r.offersMine).toBe(true);
    expect(r.callsItAHint).toBe(true);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('coins sent to an exchange keep their original basis and dates, ready to pair with a 1099-DA', async () => {
  // Form 1099-DA reports GROSS PROCEEDS only for 2025; basis reporting begins
  // with 2026 transactions, and even then assets transferred in from a
  // self-custody wallet are NON-COVERED — the exchange never saw the purchase.
  // So for exactly this user's pattern (buy in a wallet, send to an exchange,
  // sell there) the 1099-DA will never carry the basis, and reporting those
  // proceeds without it means paying tax on the entire amount.
  //
  // What the ledger must therefore preserve, against the exchange address, is
  // the ORIGINAL acquisition date and cost of each lot — not the transfer
  // date, which would also silently convert long-term gains into short-term.
  const { app, win, home } = await launch();
  try {
    const r = await win.evaluate(async () => {
      const mine = 'wBasisHandoffWallet';
      const exch = 'rZg5vPkMc5JM49CMYsaDvRxuiwL3abUBxT';
      WALLETS.length = 0; WALLETS.push(mine);
      await window.taxDB.clearWalletChain(mine, 'XRPL');
      const pay = (h, ts, from, to, amt) => ({
        tx_hash: h, timestamp: ts, raw_json: JSON.stringify({
          Account: from, Destination: to, TransactionType: 'Payment',
          TransactionResult: 'tesSUCCESS', Timestamp: ts, TransactionHash: h,
          delivered_amount_XRP: String(amt), Amount_XRP: String(amt),
          Amount_value: '', Amount_currency: '' }) });
      await window.taxDB.insertRows(mine, 'XRPL', [
        pay('OLD', '2021-04-10 10:00:00', 'rSource', mine, 8000),   // long-term by 2025
        pay('NEW', '2025-02-10 10:00:00', 'rSource', mine, 2000),   // short-term
        pay('DEP', '2025-08-01 10:00:00', mine, exch, 9000),        // sent to the exchange
      ]);
      await window.taxDB.upsertSyncState(mine, 'XRPL', '2025-12-31 00:00:00');

      transferOnlyAddresses.length = 0; transferOnlyAddresses.push(exch);
      giftAddresses.length = 0; lostWallets.length = 0;
      walletLabels[exch] = 'Coinbase - Exchange';
      await buildReportFromCache({ silent: true });

      const lots = ((walletLedger[exch] || {}).XRP || []).filter(l => l.remaining > 0);
      const out = {
        // Sending to your own exchange account is not a sale.
        disposals: allDisposalsHigh.length,
        lotCount: lots.length,
        qty: lots.reduce((s,l)=>s+l.remaining, 0),
        basis: lots.reduce((s,l)=>s+l.remaining*l.unitCost, 0),
        // The dates that matter: FIFO took all 8,000 of the 2021 lot and
        // 1,000 of the 2025 one, and BOTH keep their original dates.
        years: lots.map(l => String(l.date).slice(0,4)).sort(),
        // Not folded into the self-custody portfolio.
        selfCustody: computeHoldings().filter(h => !isTransferOnly(h.wallet) && !isLostWallet(h.wallet))
                       .reduce((s,h)=>s+h.qty, 0),
        exchangeQty: computeHoldings().filter(h => isTransferOnly(h.wallet)).reduce((s,h)=>s+h.qty, 0),
      };
      delete walletLabels[exch];
      transferOnlyAddresses.length = 0; WALLETS.length = 0;
      return out;
    });

    // Moving coins to your own exchange account produced no taxable sale.
    expect(r.disposals).toBe(0);

    // All 9,000 sit against the exchange address with real basis...
    expect(r.qty).toBeCloseTo(9000, 6);
    expect(r.basis).toBeGreaterThan(0);
    expect(r.exchangeQty).toBeCloseTo(9000, 6);

    // ...and 1,000 remains in self custody.
    expect(r.selfCustody).toBeCloseTo(1000, 6);

    // The critical property: the 2021 lot arrived carrying 2021, so a later
    // sale on the exchange is long-term. Stamping the transfer date here
    // would quietly reclassify a long-term gain as short-term.
    expect(r.lotCount).toBe(2);
    expect(r.years).toEqual(['2021', '2025']);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
