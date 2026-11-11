// test/ledger-lock.test.js — nothing that writes the ledger arrays may run
// over anything else that does.
//
// 2026-11-10: the treatment-comparison button was pressed while a fetch was
// running. The fetch builds the ledger itself and never took part in the
// "one build at a time" guard, so the comparison's rebuilds ran straight over
// it. Every 2024 row came out twice, 2025's gain read $1,827 against a filed
// $882, some sales drew on coins "acquired" in 2026, and the comparison's
// "not booked" column was all zeros. The row-count check passed, because the
// second pass's reset zeroed the counter it compares.
//
// This exercises the lock exactly as written in the renderer, and pins that
// every ledger-writing entry point goes through it.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
let failures = 0;
const pending = [];
function test(name, fn) {
  pending.push(Promise.resolve().then(fn).then(
    () => console.log(`  ok - ${name}`),
    (e) => { failures++; console.log(`  FAIL - ${name}\n      ${e.message}`); }));
}

const start = html.indexOf('let _ledgerLock = Promise.resolve();');
const end = html.indexOf('async function buildReportFromCache');
assert.ok(start > 0 && end > start, 'lock source not found in renderer');
const L = new Function(html.slice(start, end) +
  '; return { withLedgerLock, held: () => _ledgerLockHeld, q: () => _ledgerQueue };')();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('an idle lock starts its operation synchronously', async () => {
  let started = false;
  const p = L.withLedgerLock('x', async () => { started = true; await sleep(1); });
  assert.ok(started, 'did not start synchronously');
  await p;
});

test('operations run one at a time, in the order requested, and a throw does not jam it', async () => {
  const log = [];
  let inside = 0, max = 0;
  const op = (n, ms, fail) => L.withLedgerLock(n, async () => {
    inside++; max = Math.max(max, inside); log.push('+' + n);
    await sleep(ms); inside--; log.push('-' + n);
    if (fail) throw new Error('boom');
  });
  const r = await Promise.allSettled([op('fetch', 30), op('compare', 5, true), op('rebuild', 1)]);
  assert.strictEqual(max, 1, 'two operations overlapped');
  assert.strictEqual(log.join(' '), '+fetch -fetch +compare -compare +rebuild -rebuild');
  assert.strictEqual(r[1].status, 'rejected');
  assert.strictEqual(L.q(), 0);
  assert.strictEqual(L.held(), null);
});

const body = (name) => {
  const i = html.indexOf(name);
  assert.ok(i > 0, name + ' not found');
  return html.slice(i, html.indexOf('\n}\n', i));
};

test('a fetch takes the lock', () => {
  assert.ok(/withLedgerLock\('fetch'/.test(body('async function runFetch(')));
});

test('the treatment switch changes the setting inside the lock', () => {
  const b = body('async function setAmmTreatmentUI(');
  const lock = b.indexOf('withLedgerLock(');
  const set = b.indexOf('ammTreatment = next;');
  assert.ok(lock > 0 && set > lock, 'ammTreatment is assigned outside the lock');
  assert.ok(!/buildReportFromCache\(/.test(b), 'calls the locking build from inside the lock: deadlock');
});

test('both comparison entry points run it inside one turn of the lock', () => {
  const ui = body('async function compareTreatmentsUI(');
  assert.ok(/withLedgerLock\('treatment comparison'[\s\S]*_compareInsideLock\(/.test(ui));
  const bg = body('function scheduleBackgroundCompare(');
  assert.ok(/withLedgerLock\('background treatment comparison'[\s\S]*_compareInsideLock\(/.test(bg));
  for (const b of [ui, bg]) assert.ok(!/buildReportFromCache\(/.test(b), 'locking build inside the lock: deadlock');
  const callers = html.split('\n').filter((l) => /_compareInsideLock\(/.test(l) && !/async function _compareInsideLock/.test(l));
  assert.strictEqual(callers.length, 2, callers.join('\n'));
});

test('the comparison builds both sides and always restores your treatment', () => {
  const b = body('async function _compareInsideLock(');
  assert.ok(!/withLedgerLock\(|buildReportFromCache\(/.test(b), 'would deadlock: it is called with the lock held');
  assert.strictEqual((b.match(/_runLedgerBuild\(/g) || []).length, 3);
  const fin = b.indexOf('} finally {');
  assert.ok(fin > 0 && b.indexOf('ammTreatment = cur;', fin) > fin, 'restore is not in finally');
  assert.ok(/buildIsConsistent\(\)/.test(b), 'stores figures without checking the build');
});

test('a stored comparison is trusted only for the data and figures it was built from', () => {
  const grab = (n) => { const i = html.indexOf(n); return html.slice(i, html.indexOf('\n}', i) + 2); };
  const sk = html.slice(html.indexOf('const snapKey ='), html.indexOf('const buildIsConsistent'));
  const f = new Function(sk + grab('function storedCompareMatches(') + '; return storedCompareMatches;')();
  const snap = (g) => ({ byYear: { 2025: { rows: 3, stProceeds: 10, stBasis: 5, ltProceeds: 1, ltBasis: 0.5 + g } } });
  const stored = { stamp: 'S', before: snap(0), after: snap(9) };
  assert.strictEqual(f(stored, { treatment: 'none', stamp: 'S', snap: snap(0) }), true);
  assert.strictEqual(f(stored, { treatment: 'A', stamp: 'S', snap: snap(9) }), true, 'switching treatment should reuse it');
  assert.strictEqual(f(stored, { treatment: 'none', stamp: 'T', snap: snap(0) }), false, 'data changed');
  assert.strictEqual(f(stored, { treatment: 'none', stamp: 'S', snap: snap(1) }), false, 'figures changed');
  assert.strictEqual(f(null, { treatment: 'none', stamp: 'S', snap: snap(0) }), false);
  assert.strictEqual(f(stored, null), false);
});

test('every export that reads the live arrays waits for the lock', () => {
  for (const n of ['exportCSV', 'exportUnvaluedCSV', 'exportIncome', 'exportAllTx', 'exportKoinlyCSV',
    'exportCoinLedgerCSV', 'exportWalletActivityCSV', 'exportLostWalletCSV', 'exportGiftsCSV', 'exportHoldingsPDF',
    'exportExchangeBasisCSV', 'exportHoldingsCSV', 'exportDestinationsCSV', 'exportLedger']) {
    const re = new RegExp('function ' + n + '\\(\\) ?\\{\\n  if\\(ledgerBusy\\(\\)\\) return;');
    assert.ok(re.test(html), n + ' does not check ledgerBusy() first');
  }
  assert.ok(/if\(!src && ledgerBusy\(\)\) return;/.test(body('function exportForm8949PDF(')));
});

test('no caller outside the lock-holders reaches the raw build', () => {
  const calls = html.split('\n').filter((l) => /_runLedgerBuild\(/.test(l) && !/function _runLedgerBuild/.test(l));
  assert.strictEqual(calls.length, 1 + 1 + 3, calls.join('\n'));   // buildReportFromCache + treatment + _compareInsideLock
});

test('a sale matched to a lot acquired after it is a filing-blocking error', () => {
  assert.ok(/futureLotRows\+\+/.test(html));
  assert.ok(/if\(futureLotRows\) \{[\s\S]{0,300}DO NOT FILE/.test(html));
  assert.ok(/futureLotRows = 0;/.test(body('function resetLedgerState(')));
});

test('the DO NOT FILE warnings are painted after a cache rebuild, not only after a fetch', () => {
  const b = body('function renderDataSummary(');
  const early = b.indexOf('if(total === 0)');
  assert.ok(early > 0, 'renderDataSummary shape changed');
  const branch = b.slice(early, b.indexOf('return;', early));
  assert.ok(/dataQualityHTML\(\)/.test(branch), 'the no-fetch-counts branch drops the data-quality warnings');
});

test('the row-count check expects the same type-filtered rows the build streams', () => {
  const v = body('async function verifyScannedRowCount(');
  assert.ok(/expectedRowsForChain\('Xahau'\)/.test(v) && /expectedRowsForChain\('XRPL'\)/.test(v),
    'expected count is not the type-filtered selection');
  const e = body('async function expectedRowsForChain(');
  const st = body('async function streamChainIntoLedger(');
  for (const b of [e, st]) {
    assert.ok(/FETCH_TYPES_XAHAU : FETCH_TYPES_XRPL/.test(b));
    assert.ok(/countForChain\(chain, types\)/.test(b));
  }
  assert.ok(/getChainRowsPage\(chain, LEDGER_PAGE_ROWS, cursor, types\)/.test(st));
});

Promise.all(pending).then(() => {
  if (failures) { console.log(`\n${failures} test(s) FAILED`); process.exit(1); }
  console.log('\nAll ledger-lock tests passed');
});
