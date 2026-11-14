// test/gift-lots.spec.js — the per-lot gift statement (1.10.13).
//
// A gift that mixes cheap and expensive lots, or long- and short-term ones,
// cannot be described by one basis and one earliest date. What must hold:
//   - every lot a gift consumed is kept: quantity, acquisition date, cost, how
//     it was acquired;
//   - the basis for a loss is the lesser of cost and gift-date value LOT BY
//     LOT, not on the gift's totals;
//   - the holding period tacks for a gain, and restarts on the gift date for
//     the loss on a dual-basis lot;
//   - the CSV and the recipient's PDF statement say the same thing.
//
// Never put a real address in a test.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_DIR = path.join(__dirname, '..');
const W = 'rTESTgiftDonor1111111111111111111';
const TO = 'rTESTgiftRecipient11111111111111';

let app, window, userDataDir;

test.beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrp-xahau-giftlots-'));
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

// 6,000 XRP at $0.48 (2024) + 5,000 at $2.90 (2025-08-27). Gift 10,000 on
// 2026-05-27 at $1.34. FIFO takes all of the first lot and 4,000 of the second.
async function giveFixture() {
  return window.evaluate(({ W, TO }) => {
    resetLedgerState();
    ledgerAdd(W, 'XRP', '2024-06-30', 6000, 0.48, 'amm_withdrawal');
    ledgerAdd(W, 'XRP', '2025-08-27', 5000, 2.90, 'amm_withdrawal');
    pushGift(W, 'XRP', 10000, '2026-05-27', '5/27/2026', 2026, 'GIFTHASH1', 1.34, 'Recipient One', TO);
    const g = allGiftRows[0];
    return { n: allGiftRows.length, basis: g.basis, fmv: g.fmv, lossBasis: g.lossBasis, dual: g.dualBasis, term: g.term,
             lots: g.lots.map((l) => ({ qty: l.qty, unitCost: l.unitCost, acqDate: l.acqDate, source: l.source,
                                        basis: l.basis, fmv: l.fmv, lossBasis: l.lossBasis, dual: l.dual, term: l.term })) };
  }, { W, TO });
}

test('a gift keeps every lot it consumed, and the loss basis is lot by lot', async () => {
  const g = await giveFixture();
  expect(g.n).toBe(1);
  expect(g.lots).toHaveLength(2);
  expect(g.lots[0]).toMatchObject({ qty: 6000, unitCost: 0.48, acqDate: '2024-06-30', source: 'amm_withdrawal', dual: false, term: 'LT' });
  expect(g.lots[1]).toMatchObject({ qty: 4000, unitCost: 2.90, acqDate: '2025-08-27', dual: true, term: 'ST' });
  expect(g.basis).toBeCloseTo(6000 * 0.48 + 4000 * 2.90, 6);        // 14,480 carries over for a gain
  expect(g.fmv).toBeCloseTo(13400, 6);
  // Lot 1: cost 2,880 < value 8,040 → 2,880. Lot 2: cost 11,600 > value 5,360 → 5,360.
  expect(g.lots[0].lossBasis).toBeCloseTo(2880, 6);
  expect(g.lots[1].lossBasis).toBeCloseTo(5360, 6);
  expect(g.lossBasis).toBeCloseTo(8240, 6);                          // not min(14,480, 13,400) = 13,400
  expect(g.dual).toBe(true);
  expect(g.term).toBe('VARIOUS');
});

test('the lot CSV gives each lot its dates: tacked for a gain, the gift date for a dual-basis loss', async () => {
  await giveFixture();
  const out = await window.evaluate(() => {
    const real = downloadCSV; let captured = null;
    downloadCSV = (lines, name) => { captured = { lines, name }; };
    try { exportGiftLotsCSV(); } finally { downloadCSV = real; }
    return captured;
  });
  expect(out.name).toMatch(/^Gift-Lots-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(out.lines[0]).toContain('Date You Acquired');
  expect(out.lines[0]).toContain('Their Basis For A Loss USD');
  expect(out.lines).toHaveLength(3);
  const cols = (l) => l.split(',');
  const head = cols(out.lines[0]);
  const at = (row, name) => cols(row)[head.indexOf(name)];
  // Lot 1 is not dual: both dates tack from 6/30/2024.
  expect(at(out.lines[1], 'Date You Acquired')).toBe('6/30/2024');
  expect(at(out.lines[1], 'How You Acquired It')).toBe('AMM pool withdrawal');
  expect(at(out.lines[1], 'Long-Term For A Gain If Sold After')).toBe('6/30/2025');
  expect(at(out.lines[1], 'Long-Term For A Loss If Sold After')).toBe('6/30/2025');
  // Lot 2 is dual: gain tacks from 8/27/2025, loss starts on the gift date.
  expect(at(out.lines[2], 'Dual Basis (This Lot)')).toBe('YES');
  expect(at(out.lines[2], 'Long-Term For A Gain If Sold After')).toBe('8/27/2026');
  expect(at(out.lines[2], 'Long-Term For A Loss If Sold After')).toBe('5/27/2027');
  expect(at(out.lines[2], 'Their Basis For A Loss USD')).toBe('5360.00');
});

test('a lot with no acquisition record says so and gets no tacking', async () => {
  const out = await window.evaluate(({ W, TO }) => {
    resetLedgerState();
    ledgerAdd(W, 'XRP', '2023-01-10', 100, 0.40, 'received');
    pushGift(W, 'XRP', 150, '2026-02-01', '2/1/2026', 2026, 'GIFTHASH2', 2, 'Recipient One', TO);
    return giftLotRows('Recipient One').map((r) => ({ how: r.how, acquired: r.acquired, basis: r.basis, ltg: r.ltGainAfter }));
  }, { W, TO });
  expect(out).toHaveLength(2);
  expect(out[1].how).toMatch(/no record/);
  expect(out[1].acquired).toBe('');
  expect(out[1].basis).toBe(0);
  expect(out[1].ltg).toBe('2/1/2027');
});

test('the recipient statement PDF lists the lots and both basis figures', async () => {
  await giveFixture();
  const out = await window.evaluate(() => {
    const doc = buildGiftStatementDoc('Recipient One');
    const pdf = doc.output();
    return { pages: doc.internal.getNumberOfPages(), recipients: giftRecipients(),
             has: ['Gift basis statement for Recipient One', '6/30/2024', '8/27/2025', '5/27/2027', '$5,360.00', '$8,240.00', 'AMM pool withdrawal', 'Dual-basis lot']
               .filter((t) => pdf.includes(t)) };
  });
  expect(out.pages).toBeGreaterThanOrEqual(1);
  expect(out.recipients).toEqual(['Recipient One']);
  expect(out.has).toEqual(['Gift basis statement for Recipient One', '6/30/2024', '8/27/2025', '5/27/2027', '$5,360.00', '$8,240.00', 'AMM pool withdrawal', 'Dual-basis lot']);
});

test('the gift summary shows both basis figures and a statement button per recipient', async () => {
  await giveFixture();
  const html = await window.evaluate(() => giftSummaryHTML());
  expect(html).toContain('Their basis for a loss');
  expect(html).toContain('$8,240.00');
  expect(html).toContain('dual basis');
  expect(html).toContain('Statement for Recipient One (PDF)');
  expect(html).toContain('Gift Lots CSV');
});
