// test/amm-real-file.spec.js — the AMM import, run against the ACTUAL output
// of scripts/verify-xrpl.js --amm rather than a hand-written fixture.
//
// WHY A SEPARATE FILE
//
// Every other test of this feature builds its own CSV, which means every one
// of them tests the parser against a file the parser's author wrote. That is
// exactly the shape of mistake this project keeps making: reasoning about the
// data instead of measuring it. The AMMDeposit re-sync that recovered nothing,
// the "AMMWithdraw has no amount anywhere" claim, the 45-of-68 counting bug —
// all three came from a confident assumption about a file nobody had looked at.
//
// So this file parses the real thing. It is SKIPPED unless the CSV is present,
// because that file carries wallet addresses and transaction hashes and can
// never be committed (see .gitignore and scripts/verify-clean.js). Point it at
// one with:
//
//   AMM_CSV=/path/to/amm-all.csv xvfb-run -a npx playwright test test/amm-real-file.spec.js
//
// The assertions below are deliberately about SHAPE and INVARIANTS, not about
// this particular taxpayer's figures — a test that hardcoded "73 rows" would
// fail the moment the verifier was re-run, which is not a defect.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_DIR = path.join(__dirname, '..');
const CSV = process.env.AMM_CSV || path.join(APP_DIR, 'amm-all.csv');

let app, window, userDataDir;

test.beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrp-xahau-ammfile-'));
  app = await electron.launch({
    args: [APP_DIR, '--user-data-dir=' + path.join(userDataDir, 'electron-profile')],
    cwd: APP_DIR,
    env: { ...process.env, HOME: userDataDir },
  });
  window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.waitForFunction(() => typeof _ledgerBuildInFlight !== 'undefined' && _ledgerBuildInFlight === null);
});

test.afterAll(async () => {
  if (app) await app.close();
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

test.describe(() => {
  test.skip(!fs.existsSync(CSV),
    `No AMM CSV at ${CSV}. Produce one with: node scripts/verify-xrpl.js --amm --out amm-all.csv`);

  test('the real verifier output parses with no errors at all', async () => {
    const text = fs.readFileSync(CSV, 'utf8');
    const out = await window.evaluate((t) => {
      const r = parseAmmLedgerCSV(t);
      return { errors: r.errors, stats: r.stats, n: r.rows.length };
    }, text);

    // Not "few errors" — none. Every error is one transaction left on the
    // understated requested figure, and the whole point of the import is that
    // no such transaction remains.
    expect(out.errors, 'the real file must parse cleanly').toEqual([]);
    expect(out.n).toBeGreaterThan(0);
    expect(out.stats.total).toBe(out.n);
    expect(out.stats.withDelivered + out.stats.unpaired).toBe(out.n);
  });

  test('every parsed row carries the three fields the lookup is keyed on', async () => {
    // A row missing any one of these cannot be matched to a cached
    // transaction, so it would import successfully and then do nothing —
    // the quietest possible failure.
    const text = fs.readFileSync(CSV, 'utf8');
    const bad = await window.evaluate((t) => parseAmmLedgerCSV(t).rows
      .filter(r => !r.wallet || !r.tx_type || !r.timestamp)
      .map(r => ({ wallet: !!r.wallet, type: r.tx_type, ts: r.timestamp })), text);
    expect(bad).toEqual([]);
  });

  test('timestamps are in the cache\'s own format, so the lookup is an exact string match', async () => {
    // The pairing is a raw string comparison against raw_transactions.timestamp
    // — no parsing, no rounding, no timezone. If the verifier ever started
    // emitting ISO timestamps with a "T", every row would silently miss.
    const text = fs.readFileSync(CSV, 'utf8');
    const shapes = await window.evaluate((t) => {
      const rows = parseAmmLedgerCSV(t).rows;
      return {
        withT: rows.filter(r => r.timestamp.includes('T')).length,
        withZ: rows.filter(r => /Z$/.test(r.timestamp)).length,
        matching: rows.filter(r => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(r.timestamp)).length,
        total: rows.length,
      };
    }, text);
    expect(shapes.withT, 'an ISO "T" means the cache lookup can never match').toBe(0);
    expect(shapes.withZ).toBe(0);
    expect(shapes.matching).toBe(shapes.total);
  });

  test('delivered amounts are never negative — a zero is allowed and means something', async () => {
    // The verifier reports |balance delta + fee|, so a NEGATIVE here would mean
    // the absolute value was lost somewhere and a deposit could book as a
    // negative acquisition.
    //
    // A ZERO is different, and this assertion was originally written to reject
    // it. The real file has three: AMMWithdraw rows, all tfOneAssetWithdrawAll,
    // whose measured XRP delta is exactly zero because the withdrawal took the
    // pool's OTHER asset. The ledger was asked and answered. Treating that as
    // corrupt data would have thrown away the clearest evidence in the whole
    // dataset that the untracked second asset moved real value.
    const text = fs.readFileSync(CSV, 'utf8');
    const out = await window.evaluate((t) => {
      const rows = parseAmmLedgerCSV(t).rows;
      return {
        negative: rows.filter(r => r.delivered !== null && r.delivered < 0)
                      .map(r => ({ type: r.tx_type, delivered: r.delivered })),
        zeros: rows.filter(r => r.delivered === 0).map(r => r.tx_type),
      };
    }, text);

    expect(out.negative, 'a negative delivered amount means the absolute value was lost').toEqual([]);
    // Not asserting a count — a re-run may find more or fewer. Asserting that
    // if any exist, they are withdrawals, which is the only shape that makes
    // sense: a deposit of zero XRP would not be a transaction worth signing.
    for (const t of out.zeros) expect(t).toBe('AMMWithdraw');
  });

  test('the direction of the correction differs by type, and neither is assumed', async () => {
    // The measured claim the whole feature rests on, asserted against the data
    // rather than repeated from a comment — and the assertion that caught the
    // comment being wrong.
    //
    // An earlier version of this test asserted "the requested figure is a
    // floor" across ALL AMM rows, because that is what the project's notes
    // said. It is true of withdrawals and false of deposits:
    //
    //   AMMWithdraw  the Amount field is a bound; the pool pays what its
    //                formula says, which was MORE on every comparable row.
    //   AMMDeposit   on a two-asset deposit Amount is a maximum; the pool
    //                takes only what preserves its ratio, so slightly LESS.
    //
    // Hence: assert each direction separately, and let the data say which.
    const text = fs.readFileSync(CSV, 'utf8');
    const out = await window.evaluate((t) => {
      const rows = parseAmmLedgerCSV(t).rows;
      const by = (type) => {
        const c = rows.filter(r => r.tx_type === type && r.delivered !== null && r.submitted !== null);
        return {
          comparable: c.length,
          more: c.filter(r => r.delivered > r.submitted + 1e-6).length,
          less: c.filter(r => r.delivered < r.submitted - 1e-6).length,
          net: c.reduce((a, r) => a + (r.delivered - r.submitted), 0),
          worst: c.reduce((m, r) => Math.max(m, Math.abs(r.delivered - r.submitted)), 0),
        };
      };
      return { wd: by('AMMWithdraw'), dep: by('AMMDeposit') };
    }, text);

    expect(out.wd.comparable).toBeGreaterThan(0);
    // Withdrawals: the understatement is the material one, and it is one-way.
    expect(out.wd.less, 'a withdrawal delivering LESS than requested would invert the correction').toBe(0);
    expect(out.wd.net).toBeGreaterThan(0);

    // Deposits: differences are allowed in either direction but must stay
    // small. A large deposit discrepancy would mean the pairing matched the
    // wrong transaction, not that the pool rebalanced a rounding amount.
    expect(out.dep.worst, 'a large deposit gap means a mispairing, not a ratio adjustment').toBeLessThan(5);
  });

  test('importing the real file and rebuilding the map round-trips every row', async () => {
    // End to end through the actual database, not a stub: parse, import,
    // reload, look each row up by the key the engine uses. A silent key
    // mismatch between the writer and the reader is the failure that would
    // leave every AMM row on the WinDB figure with the panel cheerfully
    // reporting a successful import.
    const text = fs.readFileSync(CSV, 'utf8');
    const out = await window.evaluate(async (t) => {
      const { rows } = parseAmmLedgerCSV(t);
      await window.taxDB.clearAmmLedger();
      const written = await window.taxDB.importAmmLedger(rows);
      const loaded = await loadAmmDeltas();
      const missed = rows.filter(r => !ammDeltas.has(ammDeltaKey(r.wallet, r.tx_type, r.timestamp)));
      const stats = await window.taxDB.getAmmStats();
      await window.taxDB.clearAmmLedger();
      ammDeltas.clear();
      return { parsed: rows.length, written, loaded, missed: missed.length, stats };
    }, text);

    expect(out.written).toBe(out.parsed);
    expect(out.loaded).toBe(out.parsed);
    expect(out.missed, 'a row that imports but cannot be looked up is worse than one that fails').toBe(0);
    expect(out.stats.rows).toBe(out.parsed);
  });
});
