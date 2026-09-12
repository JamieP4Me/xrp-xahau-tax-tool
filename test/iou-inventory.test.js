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
const { decodeCurrency, nonNativeLegs, BOOKED,
        directionOf, classifyRoutes } = require('../scripts/iou-inventory');

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


// ── direction: signing is not sending ─────────────────────────────────────
const W = 'rTESTwa11etXRPL1111111111111111111';

test('REGRESSION: an AMMWithdraw is an ACQUISITION, not a disposal', () => {
  // You are the Account -- you signed it -- but the assets travel OUT of the
  // pool and INTO your wallet. Reading Account as outbound booked a 4,050 SOLO
  // withdrawal as a disposal: wrong sign, and wrong by twice the amount in any
  // net balance.
  assert.strictEqual(
    directionOf({ TransactionType: 'AMMWithdraw', Account: W }, W), 'in');
});

test('an AMMDeposit really is outbound', () => {
  assert.strictEqual(
    directionOf({ TransactionType: 'AMMDeposit', Account: W }, W), 'out');
});

test('someone else AMM transaction that merely touched us is neither', () => {
  assert.strictEqual(
    directionOf({ TransactionType: 'AMMWithdraw', Account: 'rOTHER' }, W), '—');
});

test('the self-payment and plain cases still hold', () => {
  assert.strictEqual(directionOf({ TransactionType: 'Payment', Account: W, Destination: W }, W), 'in');
  assert.strictEqual(directionOf({ TransactionType: 'Payment', Account: W, Destination: 'rO' }, W), 'out');
  assert.strictEqual(directionOf({ TransactionType: 'Payment', Account: 'rO', Destination: W }, W), 'in');
});

// ── routes: a burn is one-way ─────────────────────────────────────────────
const ISSUER = 'rISSUERofTHIStoken1111111111111111';
const LPISS  = 'rISSUERofTHElpTOKEN111111111111111';
const W2 = 'rTESTwa11etXRPL2222222222222222222';
const ctxOf = (inbound, issuers, own) => ({
  inboundFrom: new Set((inbound || []).map(a => W + '|' + a)),
  issuers: new Set(issuers || []),
  ownWallets: new Set(own || [W]),
});
const out = (over) => Object.assign(
  { dir: 'out', wallet: W, type: 'Payment', issuer: ISSUER, destination: '', selfPay: false }, over);

test('a one-way send to the issuer is still flagged as a possible burn', () => {
  const r = classifyRoutes(out({ destination: ISSUER }), ctxOf([], [ISSUER]));
  assert.match(r.disposal, /possible burn/);
});

test('REGRESSION: a token sent to an issuer that PAYS US BACK is not a burn', () => {
  // Measured on a real cache: 26 payments of XXX to the onexah XXX issuer were
  // reported as burns, while that same address had sent 87 Remits back. A burn
  // is one-way; an address you receive from is a counterparty.
  const r = classifyRoutes(out({ destination: ISSUER }), ctxOf([ISSUER], [ISSUER]));
  assert.match(r.disposal, /NOT a burn/);
  assert.doesNotMatch(r.disposal, /possible burn/);
});

test('REGRESSION: sending token X to the issuer of token Y is a protocol deposit', () => {
  // This is how an LP position is opened: 16 XXX payments went to the XLP
  // issuer, which mints LP tokens back. The old classifier called it
  // "sent to another address", which hid it completely.
  const r = classifyRoutes(out({ destination: LPISS }), ctxOf([LPISS], [ISSUER, LPISS]));
  assert.match(r.disposal, /protocol/);
});

test('an unknown address with no history is just another address', () => {
  const r = classifyRoutes(out({ destination: 'rSTRANGER11111111111111111111111' }), ctxOf([], [ISSUER]));
  assert.strictEqual(r.disposal, 'sent to another address');
});

test('a DEX sale outranks every destination rule', () => {
  const r = classifyRoutes(out({ type: 'OfferCreate', destination: ISSUER }), ctxOf([ISSUER], [ISSUER]));
  assert.strictEqual(r.disposal, 'sale (DEX)');
});

test('AMM legs get their own route, not a destination guess', () => {
  assert.strictEqual(classifyRoutes(out({ type: 'AMMDeposit' }), ctxOf()).disposal,
    'deposited to AMM pool');
  assert.strictEqual(classifyRoutes({ dir: 'in', wallet: W, type: 'AMMWithdraw', selfPay: false },
    ctxOf()).acquisition, 'withdrawn from AMM pool');
});

test('acquisitions keep their labels', () => {
  assert.strictEqual(classifyRoutes({ dir: 'in', wallet: W, type: 'Payment', selfPay: true },
    ctxOf()).acquisition, 'bought (cross-currency payment)');
  assert.strictEqual(classifyRoutes({ dir: 'in', wallet: W, type: 'Payment', selfPay: false },
    ctxOf()).acquisition, 'received');
});

test('a disposal never carries an acquisition route, or the reverse', () => {
  const d = classifyRoutes(out({ destination: ISSUER }), ctxOf([], [ISSUER]));
  assert.strictEqual(d.acquisition, '');
  const a = classifyRoutes({ dir: 'in', wallet: W, type: 'Payment', selfPay: false }, ctxOf());
  assert.strictEqual(a.disposal, '');
});


test('REGRESSION: a transfer between YOUR OWN wallets is not a disposal', () => {
  // WinDB writes a holder address into an issuer field often enough that the
  // main wallet landed in the issuer set, and 97 consolidation transfers were
  // relabelled "sent to the issuer of another token" -- i.e. as liquidity-pool
  // deposits. There is no realisation when a lot moves to yourself.
  const r = classifyRoutes(out({ destination: W2 }), ctxOf([], [ISSUER, W2], [W, W2]));
  assert.match(r.disposal, /NOT a disposal/);
});

test('REGRESSION: arriving from your own wallet is not an acquisition either', () => {
  const r = classifyRoutes({ dir: 'in', wallet: W, type: 'Payment', selfPay: false, source: W2 },
    ctxOf([], [], [W, W2]));
  assert.match(r.acquisition, /NOT an acquisition/);
});

test('the own-wallet rule outranks every issuer rule, in both orders', () => {
  // Own wallet that is ALSO recorded as this token issuer: still not a burn.
  const r = classifyRoutes(out({ destination: W2, issuer: W2 }), ctxOf([], [W2], [W, W2]));
  assert.match(r.disposal, /NOT a disposal/);
  assert.doesNotMatch(r.disposal, /burn/);
});

test('a genuine third party is unaffected by the own-wallet rule', () => {
  const r = classifyRoutes(out({ destination: LPISS }), ctxOf([LPISS], [ISSUER, LPISS], [W]));
  assert.match(r.disposal, /protocol/);
});

console.log('');
if (failures > 0) {
  console.log(`${failures} test(s) FAILED`);
  process.exit(1);
} else {
  console.log('All iou-inventory.js tests passed');
  process.exit(0);
}
