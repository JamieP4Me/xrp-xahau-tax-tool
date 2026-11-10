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

test('the comparison holds the lock across all three of its builds', () => {
  const b = body('async function compareTreatmentsUI(');
  assert.ok(/withLedgerLock\('treatment comparison'/.test(b));
  assert.ok(!/buildReportFromCache\(/.test(b), 'calls the locking build from inside the lock: deadlock');
  assert.strictEqual((b.match(/_runLedgerBuild\(/g) || []).length, 3);
});

test('no caller outside the lock-holders reaches the raw build', () => {
  const calls = html.split('\n').filter((l) => /_runLedgerBuild\(/.test(l) && !/function _runLedgerBuild/.test(l));
  assert.strictEqual(calls.length, 1 + 1 + 3, calls.join('\n'));   // buildReportFromCache + treatment + comparison
});

test('a sale matched to a lot acquired after it is a filing-blocking error', () => {
  assert.ok(/futureLotRows\+\+/.test(html));
  assert.ok(/if\(futureLotRows\) \{[\s\S]{0,300}DO NOT FILE/.test(html));
  assert.ok(/futureLotRows = 0;/.test(body('function resetLedgerState(')));
});

Promise.all(pending).then(() => {
  if (failures) { console.log(`\n${failures} test(s) FAILED`); process.exit(1); }
  console.log('\nAll ledger-lock tests passed');
});
