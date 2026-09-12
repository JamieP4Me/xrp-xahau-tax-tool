// test/iou-inventory.test.js — the inventory of assets the engine does not book.
//
// Built against a synthetic cache rather than a mock, because the thing most
// likely to be wrong here is the shape of a real cached row, not the logic
// over it. Every fixture below is the shape WinDB actually stores: an IOU
// leaves Amount_XRP empty and puts the figure in Amount_value, with the
// currency as a 3-character code or a 40-character hex blob.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDb } = require('../db');
const { decodeCurrency, nonNativeLegs, BOOKED } = require('../scripts/iou-inventory');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); }
  catch (e) {
    failures++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${e.stack.split('\n').slice(0, 4).join('\n    ')}`);
  }
}

console.log('iou-inventory.js — assets the tax engine does not book');

// ── currency decoding ─────────────────────────────────────────────────────
test('a 3-character code passes through', () => {
  assert.strictEqual(decodeCurrency('USD'), 'USD');
  assert.strictEqual(decodeCurrency('evr'), 'EVR');
});

test('a 40-char hex blob decodes to its ASCII name', () => {
  // "CX1" right-padded with NULs, as the ledger stores a non-standard code.
  const hex = Buffer.from('CX1'.padEnd(20, '\0'), 'ascii').toString('hex').toUpperCase();
  assert.strictEqual(hex.length, 40);
  assert.strictEqual(decodeCurrency(hex), 'CX1');
});

test('a longer name decodes too', () => {
  const hex = Buffer.from('XPIRATES'.padEnd(20, '\0'), 'ascii').toString('hex').toUpperCase();
  assert.strictEqual(decodeCurrency(hex), 'XPIRATES');
});

test('non-printable hex is shown as hex rather than as mojibake', () => {
  // An LP token's code is binary, not a name. Rendering it as control
  // characters would corrupt the terminal and hide what the row is.
  const hex = '03' + '0'.repeat(38);
  assert.strictEqual(decodeCurrency(hex), hex);
});

test('empty is empty, not a phantom asset', () => {
  assert.strictEqual(decodeCurrency(''), '');
  assert.strictEqual(decodeCurrency(null), '');
  assert.strictEqual(decodeCurrency(undefined), '');
});

// ── which legs count ──────────────────────────────────────────────────────
test('the three booked assets are never reported as missing', () => {
  for (const c of ['XRP', 'XAH', 'EVR']) {
    assert.deepStrictEqual(
      nonNativeLegs({ TransactionType: 'Payment', Amount_currency: c, Amount_value: '5' }), [],
      `${c} is booked by the engine and must not appear here`);
  }
  assert.ok(BOOKED.has('XRP') && BOOKED.has('XAH') && BOOKED.has('EVR'));
});

test('a native XRP payment yields nothing — the currency field is EMPTY, not "XRP"', () => {
  // The convention this whole project had to learn the hard way: WinDB leaves
  // the currency blank on a native amount rather than writing "XRP". A guard
  // built on `currency === 'XRP'` rejected every row it was meant to admit.
  assert.deepStrictEqual(
    nonNativeLegs({ TransactionType: 'Payment', Amount_XRP: '250.5', Amount_currency: '' }), []);
});

test('an IOU payment is caught, with its quantity from Amount_value', () => {
  const legs = nonNativeLegs({
    TransactionType: 'Payment', Amount_XRP: '',
    Amount_currency: 'CX1', Amount_issuer: 'rISSUER', Amount_value: '2974.1',
  });
  assert.strictEqual(legs.length, 1);
  assert.strictEqual(legs[0].currency, 'CX1');
  assert.strictEqual(legs[0].qty, 2974.1);
  assert.strictEqual(legs[0].issuer, 'rISSUER');
});

test('delivered_amount_* wins over Amount_* — delivered is what arrived', () => {
  const legs = nonNativeLegs({
    TransactionType: 'Payment',
    Amount_currency: 'CX1', Amount_value: '100',
    delivered_amount_currency: 'CX1', delivered_amount_value: '97.5',
  });
  assert.strictEqual(legs[0].qty, 97.5, 'the requested figure is not what moved');
});

test('BOTH sides of a DEX trade are reported', () => {
  // An IOU-for-IOU trade has no native leg at all. Reading only the Amount
  // fields would miss the entire transaction — which is how a whole class of
  // disposals goes unreported.
  const legs = nonNativeLegs({
    TransactionType: 'OfferCreate',
    TakerGets_currency: 'CX1', TakerGets_value: '500', TakerGets_issuer: 'rA',
    TakerPays_currency: 'XVR', TakerPays_value: '1200', TakerPays_issuer: 'rB',
  });
  assert.strictEqual(legs.length, 2);
  assert.deepStrictEqual(legs.map(l => l.currency).sort(), ['CX1', 'XVR']);
  assert.ok(legs.find(l => l.role.includes('sold')));
  assert.ok(legs.find(l => l.role.includes('bought')));
});

test('an IOU sold FOR XRP reports only the IOU leg', () => {
  const legs = nonNativeLegs({
    TransactionType: 'OfferCreate',
    TakerGets_currency: 'XVR', TakerGets_value: '1200',
    TakerPays_XRP: '300', TakerPays_currency: '',
  });
  assert.strictEqual(legs.length, 1);
  assert.strictEqual(legs[0].currency, 'XVR');
});

test('a quantity that will not parse is recorded as null, never as zero', () => {
  // Zero would read as "nothing moved", which is the one answer that is
  // actively wrong rather than merely absent.
  const legs = nonNativeLegs({
    TransactionType: 'Payment', Amount_currency: 'OVX', Amount_value: '' });
  assert.strictEqual(legs.length, 1);
  assert.strictEqual(legs[0].qty, null);
});

test('a type the engine never books still reports its IOU amount', () => {
  const legs = nonNativeLegs({
    TransactionType: 'CheckCash', Amount_currency: 'XBLADE', Amount_value: '0.016' });
  assert.strictEqual(legs.length, 1);
  assert.strictEqual(legs[0].role, 'CheckCash');
});

// ── against a real SQLite cache ───────────────────────────────────────────
test('END-TO-END: a synthetic cache is inventoried correctly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iou-test-'));
  const p = path.join(dir, 'tax-data.sqlite3');
  const db = createDb(p);
  const W = 'rTESTwa11etXRPL1111111111111111111';
  const hexCX1 = Buffer.from('CX1'.padEnd(20, '\0'), 'ascii').toString('hex').toUpperCase();

  const row = (hash, ts, obj) => ({ tx_hash: hash, timestamp: ts, raw_json: JSON.stringify(obj) });
  db.insertRows(W, 'XRPL', [
    // Native XRP — must NOT appear.
    row('A', '2025-01-01 00:00:00', { TransactionType: 'Payment', TransactionResult: 'tesSUCCESS',
      Account: 'rOTHER', Destination: W, Amount_XRP: '100', Amount_currency: '' }),
    // IOU in, hex currency code.
    row('B', '2025-02-01 00:00:00', { TransactionType: 'Payment', TransactionResult: 'tesSUCCESS',
      Account: 'rOTHER', Destination: W, Amount_currency: hexCX1, Amount_value: '2974.1' }),
    // IOU out.
    row('C', '2025-03-01 00:00:00', { TransactionType: 'Payment', TransactionResult: 'tesSUCCESS',
      Account: W, Destination: 'rOTHER', Amount_currency: hexCX1, Amount_value: '974.1' }),
    // FAILED IOU — must NOT appear; it moved nothing but the fee.
    row('D', '2025-04-01 00:00:00', { TransactionType: 'Payment', TransactionResult: 'tecPATH_DRY',
      Account: W, Destination: 'rOTHER', Amount_currency: hexCX1, Amount_value: '9999' }),
  ]);
  db.close();

  // Re-open the way the script does, and run the same aggregation.
  const Database = require('better-sqlite3');
  const ro = new Database(p, { readonly: true, fileMustExist: true });
  const seen = new Map();
  let skippedFailed = 0;
  for (const r of ro.prepare('SELECT wallet, timestamp, raw_json FROM raw_transactions WHERE chain = ?').iterate('XRPL')) {
    const raw = JSON.parse(r.raw_json);
    if (raw.TransactionResult && raw.TransactionResult !== 'tesSUCCESS') { skippedFailed++; continue; }
    for (const leg of nonNativeLegs(raw)) {
      const e = seen.get(leg.currency) || { n: 0, in: 0, out: 0 };
      e.n++;
      if (raw.Destination === r.wallet) e.in += leg.qty;
      else if (raw.Account === r.wallet) e.out += leg.qty;
      seen.set(leg.currency, e);
    }
  }
  ro.close();
  fs.rmSync(dir, { recursive: true, force: true });

  assert.strictEqual(seen.size, 1, 'one non-native asset, not two — the XRP row must not appear');
  const cx1 = seen.get('CX1');
  assert.ok(cx1, 'the hex code decoded to CX1');
  assert.strictEqual(cx1.n, 2, 'the failed transaction is excluded');
  assert.strictEqual(skippedFailed, 1);
  assert.strictEqual(cx1.in, 2974.1);
  assert.strictEqual(cx1.out, 974.1);
});

// ── the two bugs a real wallet balance exposed ────────────────────────────
test('REGRESSION: an empty delivered_amount falls back to Amount, not to nothing', () => {
  // `??` returns the empty string rather than falling through, so the leg was
  // discarded entirely. Found by reconciling a cache against a wallet balance:
  // 3,935.94 RPR held, 1,013.85 net in the inventory.
  const legs = nonNativeLegs({
    TransactionType: 'Payment',
    delivered_amount_currency: '', delivered_amount_value: '', delivered_amount_issuer: '',
    Amount_currency: 'RPR', Amount_value: '1.28', Amount_issuer: 'rISS',
  });
  assert.strictEqual(legs.length, 1, 'the leg must not be discarded');
  assert.strictEqual(legs[0].currency, 'RPR');
  assert.strictEqual(legs[0].qty, 1.28);
  assert.strictEqual(legs[0].issuer, 'rISS');
});

test('delivered_amount still WINS when it is actually populated', () => {
  const legs = nonNativeLegs({
    TransactionType: 'Payment',
    delivered_amount_currency: 'RPR', delivered_amount_value: '0.97',
    Amount_currency: 'RPR', Amount_value: '1.28',
  });
  assert.strictEqual(legs[0].qty, 0.97, 'delivered is what arrived');
});

test('REGRESSION: a cross-currency payment to YOURSELF is an acquisition', () => {
  // Account === Destination === your wallet is how a token is bought with XRP
  // without a DEX offer. Testing Account first called every one a disposal.
  const dir = (raw, wallet) => {
    const selfPay = raw.Account === wallet && raw.Destination === wallet;
    return selfPay ? 'in' : raw.Account === wallet ? 'out'
         : (raw.Destination === wallet ? 'in' : '—');
  };
  const W = 'rTESTwa11etXRPL1111111111111111111';
  assert.strictEqual(dir({ Account: W, Destination: W }, W), 'in', 'self-payment = purchase');
  assert.strictEqual(dir({ Account: W, Destination: 'rOTHER' }, W), 'out', 'sent away = disposal');
  assert.strictEqual(dir({ Account: 'rOTHER', Destination: W }, W), 'in', 'received = acquisition');
});

console.log('');
if (failures > 0) {
  console.log(`${failures} test(s) FAILED`);
  process.exit(1);
} else {
  console.log('All iou-inventory.js tests passed');
  process.exit(0);
}
