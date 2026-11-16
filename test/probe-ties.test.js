// test/probe-ties.test.js — scripts/probe-ties.js counts what it says it
// counts, prints no address or hash, and applies the same timestamp test the
// download does. Never put a real address in a test.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const p = require('../scripts/probe-ties');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); }
  catch (e) { failures++; console.log(`  FAIL - ${name}\n    ${e.stack.split('\n').slice(0, 3).join('\n    ')}`); }
}
const W = 'rTESTtiesMain1111111111111111111', W2 = 'rTESTtiesSecond11111111111111111';
const hash = (n) => n.toString(16).toUpperCase().padStart(64, '0');
function cache(rows) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE raw_transactions (wallet TEXT NOT NULL, chain TEXT NOT NULL, tx_hash TEXT NOT NULL, timestamp TEXT NOT NULL,
    raw_json TEXT NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY (wallet, chain, tx_hash))`);
  const ins = db.prepare('INSERT INTO raw_transactions VALUES (?, ?, ?, ?, ?, ?)');
  for (const r of rows) ins.run(r[0], r[1], r[2], r[3], '{}', 'now');
  return db;
}

console.log('probe-ties — rows that share a timestamp');

test('unique timestamps: nothing tied, and the report says keys are safe', () => {
  const db = cache([
    [W, 'XRPL', hash(1), '2025-12-17 10:50:42.168000006'],
    [W, 'XRPL', hash(2), '2025-12-17 10:50:42.168000007'],
    [W, 'XRPL', '20251217105042168000008_' + W, '2025-12-17 10:50:42.168000008'],
    [W2, 'XRPL', hash(3), '2025-12-17 10:50:42.168000006'],          // another wallet at the same instant is not a tie
    [W, 'XRPL', 'LEDGER:' + hash(9), '2025-12-17 10:50:42'],          // the app's own rows are not counted
  ]);
  const [r] = p.measure(db);
  assert.strictEqual(r.rows, 4);
  assert.deepStrictEqual(r.ties, { groups: 0, rows: 0, largest: 0 });
  assert.strictEqual(r.madeUp, 1);
  assert.strictEqual(r.madeUpTied, 0);
  assert.deepStrictEqual(r.forms, [{ shape: '9999-99-99 99:99:99.999999999', rows: 4, usable: true }]);
  const lines = []; p.report([r], (l) => lines.push(l));
  assert.match(lines.join('\n'), /cannot collide/);
});

test('tied rows are counted per wallet, and a tied made-up id is called out', () => {
  const db = cache([
    [W, 'Xahau', hash(1), '2024-01-01 00:00:00'], [W, 'Xahau', hash(2), '2024-01-01 00:00:00'], [W, 'Xahau', hash(3), '2024-01-01 00:00:00'],
    [W, 'Xahau', hash(4), '2024-01-02 00:00:00'], [W, 'Xahau', '20240102000000_' + W, '2024-01-02 00:00:00'],
    [W, 'Xahau', hash(5), '1704153600'],
  ]);
  const [r] = p.measure(db);
  assert.deepStrictEqual(r.ties, { groups: 2, rows: 5, largest: 3 });
  assert.strictEqual(r.madeUp, 1);
  assert.strictEqual(r.madeUpTied, 1);
  assert.deepStrictEqual(r.forms.map((f) => [f.shape, f.usable]), [['9999-99-99 99:99:99', true], ['9999999999', false]]);
  const lines = []; p.report([r], (l) => lines.push(l));
  const text = lines.join('\n');
  assert.match(text, /largest group 3/);
  assert.match(text, /report this/);
  assert.match(text, /does not know/);
  assert.ok(!text.includes(W) && !/[0-9A-F]{64}/.test(text), 'the report must not print an address or a hash');
});

test('it opens the cache readonly and uses the download\'s own timestamp test', () => {
  const src = fs.readFileSync(require.resolve('../scripts/probe-ties'), 'utf8');
  assert.ok(/readonly: true, fileMustExist: true/.test(src));
  assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|CREATE)\b/.test(src.replace(/\/\*[\s\S]*?\*\//, '')), 'the probe must not write');
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const m = /const SQL_TS_RE = (\/.*\/);/.exec(html);
  assert.ok(m, 'SQL_TS_RE not found in the app');
  assert.strictEqual(m[1], String(p.SQL_TS_RE), 'the probe and the download must apply the same test');
});

console.log('');
if (failures) { console.log(`${failures} probe-ties test(s) FAILED`); process.exit(1); }
console.log('All probe-ties tests passed');
