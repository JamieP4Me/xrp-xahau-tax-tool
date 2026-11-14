// test/trustlines.test.js — the pricing maths and the advice in
// scripts/trustlines.js. No network. Never put a real address in a test.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const t = require('../scripts/trustlines');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); }
  catch (e) { failures++; console.log(`  FAIL - ${name}\n    ${e.stack.split('\n').slice(0, 3).join('\n    ')}`); }
}
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const opts = { keepXrp: 5, reserveInc: 0.2, now: Date.parse('2026-11-14T00:00:00Z') };
const base = { lp: false, balance: 100, issuedByYou: false, frozenByIssuer: false, countsReserve: true,
               proceeds: 0, basisUsd: null, lastReceived: null, openOffers: 0 };

console.log('trustlines — pricing and advice');

test('selling into the bids walks the book, best price first, funded amounts win', () => {
  const offers = [
    { TakerGets: '2000000', TakerPays: { value: '10' } },                                  // 0.2 XRP each, 10 wanted
    { TakerGets: '5000000', TakerPays: { value: '100' }, taker_gets_funded: '1000000', taker_pays_funded: { value: '20' } }, // only 20 funded at 0.05
  ];
  const r = t.sellIntoBook(offers, 25);
  near(r.xrp, 2 + 15 * 0.05);
  near(r.filled, 25);
  near(r.bestPrice, 0.2);
  near(t.sellIntoBook(offers, 1000).filled, 30);   // the book runs out
  assert.strictEqual(t.sellIntoBook([], 5).xrp, 0);
});

test('selling into an AMM pool uses constant product after the fee, either side order', () => {
  const amm = { amount: '1000000000', amount2: { currency: 'ABC', issuer: 'rEXAMPLE', value: '1000' }, trading_fee: 1000 }; // 1000 XRP / 1000 ABC, 1%
  const r = t.sellIntoAmm(amm, 10);
  near(r.xrp, 1000 * 9.9 / (1000 + 9.9));
  const swapped = { amount: amm.amount2, amount2: amm.amount, trading_fee: 1000 };
  near(t.sellIntoAmm(swapped, 10).xrp, r.xrp);
  assert.strictEqual(t.sellIntoAmm({ amount: { value: '1' }, amount2: { value: '1' } }, 10).xrp, 0);   // no XRP side
});

test('an LP balance is valued as its share of both halves of the pool', () => {
  const amm = { amount: '200000000', amount2: { currency: 'ABC', issuer: 'rEXAMPLE', value: '400' }, lp_token: { value: '1000' } };
  const s = t.lpShare(amm, 100);
  near(s.share, 0.1);
  near(s.xrpValue, 40);           // 20 XRP + 40 ABC worth 20 XRP
  near(s.sides[0].qty, 20);
  near(s.sides[1].qty, 40);
  assert.ok(t.LP_RE.test('03' + 'A'.repeat(38)));
  assert.ok(!t.LP_RE.test('534F4C4F00000000000000000000000000000000'));
});

test('an LP token is never sent to the trasher', () => {
  const r = t.recommend({ ...base, lp: true, lpXrp: 40 }, opts);
  assert.strictEqual(r.action, 'KEEP — LP share');
  assert.match(r.why, /never|gives the pool your half/);
});

test('an empty line is removed, and says whether it frees reserve', () => {
  assert.strictEqual(t.recommend({ ...base, balance: 0 }, opts).action, 'REMOVE');
  assert.match(t.recommend({ ...base, balance: 0 }, opts).why, /frees 0.2 XRP/);
  assert.match(t.recommend({ ...base, balance: 0, countsReserve: false }, opts).why, /frees no reserve/);
});

test('a token with a buyer is sold first, never trashed', () => {
  const r = t.recommend({ ...base, proceeds: 0.5, basisUsd: 12 }, opts);
  assert.strictEqual(r.action, 'SELL then REMOVE');
  assert.match(r.why, /Schedule D loss/);
  assert.strictEqual(t.recommend({ ...base, proceeds: 7 }, opts).action, 'KEEP or SELL — your call');
  assert.strictEqual(t.recommend({ ...base, proceeds: 0.0001 }, opts).action, 'REMOVE (burn)');   // dust is not a buyer
  // No basis and pennies of proceeds: trash it, a sale only adds an 8949 line.
  const pennies = t.recommend({ ...base, proceeds: 0.3, basisUsd: 0 }, opts);
  assert.strictEqual(pennies.action, 'REMOVE (burn)');
  assert.match(pennies.why, /loses no deduction/);
  assert.strictEqual(t.recommend({ ...base, proceeds: 2, basisUsd: 0 }, opts).action, 'SELL then REMOVE');
  assert.strictEqual(t.recommend({ ...base, proceeds: 0.3, basisUsd: 4 }, opts).action, 'SELL then REMOVE');
});

test('no buyer: burning is fine without basis, and flagged when basis would be lost', () => {
  assert.match(t.recommend({ ...base, basisUsd: 0 }, opts).why, /nothing is lost/);
  const lost = t.recommend({ ...base, basisUsd: 30 }, opts);
  assert.strictEqual(lost.action, 'REMOVE (burn) — loss not deductible');
  assert.match(lost.why, /67\(g\)/);
  assert.match(t.recommend(base, opts).why, /If the app shows basis/);
});

test('open offers, a still-arriving token, a frozen line and your own issuance are called out', () => {
  assert.match(t.recommend({ ...base, balance: 0, openOffers: 2 }, opts).why, /cancel your 2 open offer/);
  assert.match(t.recommend({ ...base, balance: 0, lastReceived: '2026-11-01T00:00:00Z' }, opts).why, /still arriving/);
  assert.doesNotMatch(t.recommend({ ...base, balance: 0, lastReceived: '2025-01-01T00:00:00Z' }, opts).why, /still arriving/);
  assert.strictEqual(t.recommend({ ...base, frozenByIssuer: true }, opts).action, 'LEAVE — frozen');
  assert.strictEqual(t.recommend({ ...base, issuedByYou: true }, opts).action, 'LEAVE');
});

test('the Holdings CSV supplies basis per wallet and token, and the XRP price', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tl-')), 'h.csv');
  fs.writeFileSync(f, 'Wallet,Description,Type,Asset,Quantity,Cost Basis USD,Unit Price USD,Price As Of,Current Value USD\n' +
    'rEXAMPLE,"Main, active",active,XRP,10,5.00,2.250000,2026-11-13,22.50\n' +
    'rEXAMPLE,Main,active,abc,3,1.25,0,,0\n');
  const m = t.readHoldings(f);
  assert.deepStrictEqual(m.get('rEXAMPLE|ABC'), { basis: 1.25, qty: 3 });
  // One wallet's EVR row is XRPL + Xahau together: a dust line gets its share, not the lot.
  assert.ok(Math.abs(t.basisFor({ basis: 129, qty: 70000 }, 0.0000015) - 129 * 0.0000015 / 70000) < 1e-15);
  assert.strictEqual(t.basisFor({ basis: 5, qty: 2 }, 10), 5);
  assert.strictEqual(t.basisFor(undefined, 10), 0);
  assert.strictEqual(m.get('__XRPUSD'), 2.25);
  assert.throws(() => { fs.writeFileSync(f, 'a,b\n1,2\n'); t.readHoldings(f); }, /Holdings-By-Wallet/);
});

test('every request goes through ledger-rpc (the claim can only reach Dhali)', () => {
  const src = fs.readFileSync(require.resolve('../scripts/trustlines'), 'utf8');
  assert.ok(/ledger\.call\(/.test(src));
  assert.ok(!/\bfetch\(/.test(src), 'no direct fetch: everything must go through ledger-rpc');
  // The value may be read and passed to ledger.call — never handed to console or a file.
  for (const line of src.split('\n').filter((l) => /console\.|writeFileSync|csv\.push/.test(l))) {
    assert.ok(!/\$\{\s*claim\b|[(,+]\s*claim\s*[),+]/.test(line), 'the claim must never be printed or written: ' + line.trim());
  }
});

console.log('');
if (failures) { console.log(`${failures} trustlines test(s) FAILED`); process.exit(1); }
console.log('All trustlines tests passed');
