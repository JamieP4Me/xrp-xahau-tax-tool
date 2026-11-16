// test/probe-ties.test.js — scripts/probe-ties.js.
//
// The first version of the probe counted rows of one wallet sharing a
// timestamp, got zero on a real cache, and printed "no row has overwritten
// another". Every row in that cache is stored under timestamp + wallet, so
// two such rows can never both be there: the zero was guaranteed and proved
// nothing. These tests pin the test that CAN tell (the same instant under two
// wallets, compared by transaction id), and pin that the report no longer
// draws a conclusion from the count that cannot.
//
// Never put a real address in a test.
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
const W = 'rTESTtiesMain1111111111111111111', W2 = 'rTESTtiesSecond11111111111111111', W3 = 'rTESTtiesThird111111111111111111';
const INDEX_SQL = (/CREATE INDEX IF NOT EXISTS (\w+)\s+ON raw_transactions\(chain, timestamp, wallet, tx_hash\);/
  .exec(fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8')) || [''])[0];
const hash = (n) => n.toString(16).toUpperCase().padStart(64, '0');
const ctid = (n) => 'C' + n.toString(16).toUpperCase().padStart(15, '0');
// The id the app makes for a row with no hash (makeTxHash in renderer/index.html).
const madeUp = (ts, wallet) => (ts + '_' + wallet).replace(/[^a-zA-Z0-9_]/g, '');
// [wallet, chain, key, timestamp, raw]
function cache(rows) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE raw_transactions (wallet TEXT NOT NULL, chain TEXT NOT NULL, tx_hash TEXT NOT NULL, timestamp TEXT NOT NULL,
    raw_json TEXT NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY (wallet, chain, tx_hash))`);
  db.exec(INDEX_SQL);   // the same index the app creates (db.js), which is what makes the probe fast
  const ins = db.prepare('INSERT OR IGNORE INTO raw_transactions VALUES (?, ?, ?, ?, ?, ?)');
  for (const r of rows) ins.run(r[0], r[1], r[2], r[3], JSON.stringify(r[4] || {}), 'now');
  return db;
}
const said = (results) => { const lines = []; p.report(results, (l) => lines.push(l)); return lines.join('\n'); };

console.log('probe-ties — can two transactions share a timestamp?');

test('made-up ids: one wallet can never show two rows at one timestamp, and the report does not call that proof', () => {
  const t = '2025-12-17 10:50:42.168000006';
  const db = cache([
    [W, 'Xahau', madeUp(t, W), t, { CTID: ctid(1), Account: W }],
    [W, 'Xahau', madeUp(t, W), t, { CTID: ctid(2), Account: W }],          // a second transaction at that instant: dropped on arrival
    [W, 'Xahau', madeUp('2025-12-17 10:50:45.000000001', W), '2025-12-17 10:50:45.000000001', { CTID: ctid(3) }],
  ]);
  const [r] = p.measure(db);
  assert.strictEqual(r.rows, 2);                                            // the collision left no trace
  assert.strictEqual(r.madeUp, 2);
  assert.deepStrictEqual(r.sameWallet, { groups: 0, rows: 0, largest: 0 });
  const text = said([r]);
  assert.match(text, /always zero here/);
  assert.match(text, /Not enough to tell/);
  assert.ok(!/cannot collide|does not collide|no row has overwritten/i.test(text), 'a zero that is guaranteed must not be reported as proof');
});

test('the same instant under two wallets with one transaction id is one transaction, and seconds with several timestamps are counted', () => {
  const a = '2025-06-01 00:00:10.100000001', b = '2025-06-01 00:00:10.100000002', c = '2025-06-01 00:00:10.100000003', d = '2025-06-01 00:00:14.000000001';
  const db = cache([
    [W, 'Xahau', madeUp(a, W), a, { CTID: ctid(10), Account: W, Destination: W2 }],
    [W2, 'Xahau', madeUp(a, W2), a, { CTID: ctid(10), Account: W, Destination: W2 }],     // the other side of the same transfer
    [W, 'Xahau', madeUp(b, W), b, { CTID: ctid(11) }],
    [W3, 'Xahau', madeUp(c, W3), c, { CTID: ctid(12) }],
    [W, 'Xahau', madeUp(d, W), d, { Account: W, Destination: W3, TransactionType: 'Payment', Amount_XRP: '5' }],   // stored before CTID was downloaded
    [W3, 'Xahau', madeUp(d, W3), d, { Account: W, Destination: W3, TransactionType: 'Payment', Amount_XRP: '5' }],
    [W, 'Xahau', 'LEDGER:' + hash(9), a, {}],                                // the app's own rows are not counted
  ]);
  const [r] = p.measure(db);
  assert.strictEqual(r.rows, 6);
  assert.deepStrictEqual(r.seconds, { several: 1, mostInOne: 3 });           // three transactions in second :10, each with its own timestamp
  assert.deepStrictEqual(r.shared, { instants: 2, checked: 2, same: 1, sameByContent: 1, different: 0, unknown: 0 });
  const text = said([r]);
  assert.match(text, /No two different transactions share a timestamp/);
  assert.match(text, /does not collide/);
  assert.match(text, /judged by content/);
  assert.ok(![W, W2, W3].some((w) => text.includes(w)) && !/C0{10}/.test(text) && !/[0-9A-F]{64}/.test(text), 'the report must not print an address, a hash or a transaction id');
});

test('two different transactions at one timestamp are found and called out', () => {
  const t = '2025-06-01 00:00:10.000000000';
  const db = cache([
    [W, 'XRPL', madeUp(t, W), t, { CTID: ctid(20), Account: W }],
    [W2, 'XRPL', madeUp(t, W2), t, { CTID: ctid(21), Account: W2 }],          // a different transaction, same timestamp
    [W, 'XRPL', madeUp('2025-06-01 00:00:11.000000000', W), '2025-06-01 00:00:11.000000000', { Account: W, Amount_XRP: '1' }],
    [W3, 'XRPL', madeUp('2025-06-01 00:00:11.000000000', W3), '2025-06-01 00:00:11.000000000', { Account: W3, Amount_XRP: '2' }],
    [W, 'XRPL', hash(5), '1717200000', { CTID: ctid(22) }],
  ]);
  const [r] = p.measure(db);
  assert.deepStrictEqual(r.shared, { instants: 2, checked: 2, same: 0, sameByContent: 0, different: 1, unknown: 1 });
  assert.strictEqual(r.madeUp, 4);
  assert.deepStrictEqual(r.forms.map((f) => [f.shape, f.usable]), [['9999-99-99 99:99:99.999999999', true], ['9999999999', false]]);
  const text = said([r]);
  assert.match(text, /Different transactions DO share a timestamp: 1 case/);
  assert.match(text, /row ids need to change/);
  assert.match(text, /could not tell/);
  assert.match(text, /does not know/);
  // A cap on how many are looked at is stated, not hidden.
  const [capped] = p.measure(db, null, { maxShared: 1 });
  assert.strictEqual(capped.shared.instants, 2);
  assert.strictEqual(capped.shared.checked, 1);
  assert.match(said([capped]), /first 1 compared/);
});

test('classify: by transaction id when every row has one, otherwise by content', () => {
  assert.strictEqual(p.classify([{ CTID: ctid(1) }, { CTID: ctid(1) }]), 'same');
  assert.strictEqual(p.classify([{ CTID: ctid(1) }, { CTID: ctid(2) }]), 'different');
  assert.strictEqual(p.classify([{ CTID: ctid(1), Account: 'a' }, { Account: 'a' }]), 'sameByContent');
  assert.strictEqual(p.classify([{ Account: 'a' }, { Account: 'b' }]), 'unknown');
  assert.strictEqual(p.ctidOf({ CTID: '\u0000'.repeat(16) }), '');
  assert.strictEqual(p.ctidOf({ CTID: 'c0a1b2c3d4e5f607' }), 'C0A1B2C3D4E5F607');
});

test('it walks one index and never the table, and says how far it has got', () => {
  assert.ok(INDEX_SQL, 'db.js no longer creates an index on (chain, timestamp, wallet, tx_hash): the probe depends on it');
  const small = cache([[W, 'XRPL', hash(1), '2025-01-01 00:00:00.000000001']]);
  const plan = small.prepare('EXPLAIN QUERY PLAN ' + p.SCAN_SQL).all().map((r) => r.detail).join(' | ');
  assert.match(plan, /USING COVERING INDEX/, 'the scan must be answered from the index alone: ' + plan);
  assert.ok(!/TEMP B-TREE/.test(plan), 'the scan must not sort: ' + plan);
  // 600,000 rows, two wallets at every instant: progress on the way, counts right.
  const big = new Database(':memory:');
  big.exec(`CREATE TABLE raw_transactions (wallet TEXT NOT NULL, chain TEXT NOT NULL, tx_hash TEXT NOT NULL, timestamp TEXT NOT NULL,
    raw_json TEXT NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY (wallet, chain, tx_hash))`);
  big.exec(INDEX_SQL);
  const ins = big.prepare('INSERT INTO raw_transactions VALUES (?, ?, ?, ?, ?, ?)');
  big.transaction(() => {
    for (let i = 0; i < 600000; i++) {
      const k = Math.floor(i / 2), t = '2024-01-01 00:00:00.' + String(k).padStart(9, '0');
      ins.run(i % 2 ? W : W2, 'Xahau', madeUp(t, i % 2 ? W : W2), t, JSON.stringify({ CTID: ctid(k) }), 'now');
    }
  })();
  const ticks = [];
  const started = Date.now();
  const [r] = p.measure(big, (what, n, done, of) => ticks.push([what, n, !!done, of || 0]), { maxShared: 12000 });
  assert.strictEqual(r.rows, 600000);
  assert.deepStrictEqual(r.shared, { instants: 300000, checked: 12000, same: 12000, sameByContent: 0, different: 0, unknown: 0 });
  assert.deepStrictEqual(r.seconds, { several: 1, mostInOne: 300000 });
  assert.deepStrictEqual(ticks, [['reading', 250000, false, 0], ['reading', 500000, false, 0], ['read', 600000, true, 0],
    ['comparing', 5000, false, 12000], ['comparing', 10000, false, 12000], ['compared', 12000, true, 12000]]);
  assert.ok(Date.now() - started < 20000, 'the probe took too long on 600,000 rows');
});

test('it opens the cache readonly and uses the download\'s own timestamp test', () => {
  const src = fs.readFileSync(require.resolve('../scripts/probe-ties'), 'utf8');
  assert.ok(/readonly: true, fileMustExist: true/.test(src));
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|REPLACE INTO|PRAGMA)\b/.test(code), 'the probe must not write');
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const m = /const SQL_TS_RE = (\/.*\/);/.exec(html);
  assert.ok(m, 'SQL_TS_RE not found in the app');
  assert.strictEqual(m[1], String(p.SQL_TS_RE), 'the probe and the download must apply the same test');
});

console.log('');
if (failures) { console.log(`${failures} probe-ties test(s) FAILED`); process.exit(1); }
console.log('All probe-ties tests passed');
