// test/verify-xrpl.test.js — plain Node tests for the balance-delta maths in
// scripts/verify-xrpl.js. No Electron, no network.
//
// The network half of that script cannot be tested offline, and mocking a
// remote node would only prove the mock works. What CAN be wrong, silently,
// is the arithmetic that turns ledger metadata into "how much XRP did this
// account actually gain or lose" — and if that is wrong the verifier reports
// confident nonsense, which is worse than not having a verifier at all.
//
// The fixtures below are shaped like real rippled metadata: drops as strings,
// AffectedNodes wrappers, PreviousFields only present on fields that changed.

const assert = require('assert');
const { xrpDeltaFor, feeXrp, rippleTimeToIso, cachedAmountXrp, REAL_HASH } = require('../scripts/verify-xrpl');

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${e.stack.split('\n').slice(0, 4).join('\n    ')}`);
  }
}

const ME = 'rMyAccountXXXXXXXXXXXXXXXXXXXXXXXX';
const THEM = 'rOtherAccountXXXXXXXXXXXXXXXXXXXXX';

const modified = (account, prevDrops, finalDrops, extra = {}) => ({
  ModifiedNode: {
    LedgerEntryType: 'AccountRoot',
    FinalFields: { Account: account, Balance: String(finalDrops), ...extra },
    PreviousFields: prevDrops == null ? {} : { Balance: String(prevDrops) },
  },
});

console.log('verify-xrpl.js — ledger balance-delta tests');

// ── The ordinary cases ────────────────────────────────────────────────────

test('an inbound payment is the recipient balance increase', () => {
  const meta = { AffectedNodes: [
    modified(THEM, 100_000_000, 89_999_988),   // sender: -10 XRP - 12 drops fee
    modified(ME,    50_000_000, 60_000_000),   // me: +10 XRP
  ] };
  assert.strictEqual(xrpDeltaFor(meta, ME), 10);
});

test('an outbound payment includes the fee, and adding it back gives the amount sent', () => {
  const tx = { Fee: '12' };                    // 12 drops = 0.000012 XRP
  const meta = { AffectedNodes: [
    modified(ME,   100_000_000, 89_999_988),   // -10.000012 XRP
    modified(THEM,  50_000_000, 60_000_000),
  ] };
  const delta = xrpDeltaFor(meta, ME);
  assert.ok(Math.abs(delta - -10.000012) < 1e-9, `delta was ${delta}`);
  // This is the comparison the script makes for an outbound row. Without the
  // fee add-back EVERY outbound payment would be reported as a mismatch.
  const amountSent = -(delta + feeXrp(tx));
  assert.ok(Math.abs(amountSent - 10) < 1e-9, `amountSent was ${amountSent}`);
});

test('only the requested account is counted, however many were touched', () => {
  const meta = { AffectedNodes: [
    modified('rThirdPartyAAAAAAAAAAAAAAAAAAAAAAA', 1_000_000, 9_000_000),
    modified(ME, 5_000_000, 7_500_000),
    modified(THEM, 8_000_000, 1_000_000),
  ] };
  assert.strictEqual(xrpDeltaFor(meta, ME), 2.5);
});

// ── The cases that silently corrupt a delta if mishandled ─────────────────

test('a ModifiedNode with no Balance change contributes nothing', () => {
  // Real metadata modifies AccountRoot for a sequence bump alone. Treating a
  // missing PreviousFields.Balance as "previous balance 0" would report the
  // account's ENTIRE balance as a gain on that transaction.
  const meta = { AffectedNodes: [
    { ModifiedNode: {
        LedgerEntryType: 'AccountRoot',
        FinalFields: { Account: ME, Balance: '75000000', Sequence: 42 },
        PreviousFields: { Sequence: 41 },
    } },
  ] };
  assert.strictEqual(xrpDeltaFor(meta, ME), 0);
});

test('a CreatedNode counts its whole starting balance', () => {
  // The account did not exist before, so there is no PreviousFields at all.
  const meta = { AffectedNodes: [
    { CreatedNode: {
        LedgerEntryType: 'AccountRoot',
        NewFields: { Account: ME, Balance: '20000000' },
    } },
    modified(THEM, 100_000_000, 79_999_988),
  ] };
  assert.strictEqual(xrpDeltaFor(meta, ME), 20);
});

test('a DeletedNode is a negative delta of what the account last held', () => {
  const meta = { AffectedNodes: [
    { DeletedNode: {
        LedgerEntryType: 'AccountRoot',
        FinalFields: { Account: ME, Balance: '0' },
        PreviousFields: { Balance: '13000000' },
    } },
  ] };
  assert.strictEqual(xrpDeltaFor(meta, ME), -13);
});

test('non-AccountRoot entries are ignored', () => {
  // A trustline (RippleState) moving an issued currency changes no XRP.
  const meta = { AffectedNodes: [
    { ModifiedNode: {
        LedgerEntryType: 'RippleState',
        FinalFields: { Balance: { currency: 'USD', value: '500' }, Account: ME },
        PreviousFields: { Balance: { currency: 'USD', value: '100' } },
    } },
    modified(ME, 10_000_000, 9_999_988),   // just the fee
  ] };
  const delta = xrpDeltaFor(meta, ME);
  assert.ok(Math.abs(delta - -0.000012) < 1e-9, `delta was ${delta}`);
});

// ── Refusing to guess ─────────────────────────────────────────────────────

test('an account absent from the metadata returns null, not zero', () => {
  // Zero would read as "verified, no movement". Null means "cannot verify",
  // and the script skips the row instead of asserting a false match.
  const meta = { AffectedNodes: [modified(THEM, 1_000_000, 2_000_000)] };
  assert.strictEqual(xrpDeltaFor(meta, ME), null);
});

test('missing or malformed metadata returns null', () => {
  assert.strictEqual(xrpDeltaFor(null, ME), null);
  assert.strictEqual(xrpDeltaFor({}, ME), null);
  assert.strictEqual(xrpDeltaFor({ AffectedNodes: 'nope' }, ME), null);
  assert.strictEqual(xrpDeltaFor({ AffectedNodes: [] }, ME), null);
});

test('a missing fee is treated as zero rather than NaN', () => {
  // NaN would propagate into the comparison and flag every row.
  assert.strictEqual(feeXrp({}), 0);
  assert.strictEqual(feeXrp(null), 0);
  assert.strictEqual(feeXrp({ Fee: 'not-a-number' }), 0);
  assert.strictEqual(feeXrp({ Fee: '10' }), 0.00001);
});

// ── Precision ─────────────────────────────────────────────────────────────

test('drops convert exactly at the scale that actually occurs', () => {
  // The bug this project has already had was a factor-of-a-million units
  // error, so the large end matters: 12,000 XRP must not become 0.012.
  const meta = { AffectedNodes: [modified(ME, 0, 12_000_000_000)] };
  assert.strictEqual(xrpDeltaFor(meta, ME), 12000);

  // And one drop, the smallest representable amount, must survive.
  const oneDrop = { AffectedNodes: [modified(ME, 1_000_000, 1_000_001)] };
  assert.ok(Math.abs(xrpDeltaFor(oneDrop, ME) - 0.000001) < 1e-12);
});

// ── Identifiers and dates ─────────────────────────────────────────────────

test('a real ledger hash is distinguishable from a synthetic cache id', () => {
  // Rows with a synthetic id cannot be matched to the ledger, and the report
  // has to say so rather than quietly pass.
  assert.ok(REAL_HASH.test('A'.repeat(64)));
  assert.ok(REAL_HASH.test('0123456789ABCDEF'.repeat(4)));
  assert.ok(!REAL_HASH.test('2025-03-05 100000_rWALLET'.replace(/[^a-zA-Z0-9_]/g, '')));
  assert.ok(!REAL_HASH.test('a'.repeat(64)), 'lowercase is not the stored form');
  assert.ok(!REAL_HASH.test('A'.repeat(63)));
  assert.ok(!REAL_HASH.test('A'.repeat(65)));
});

test('ripple time converts from the 2000-01-01 epoch, not the Unix one', () => {
  // Getting this wrong shifts every reported date by just over 30 years.
  assert.strictEqual(rippleTimeToIso(0), '2000-01-01 00:00:00');
  assert.strictEqual(rippleTimeToIso(795_000_000), '2025-03-11 09:20:00');
  // The offset stated the other way round: ripple second 0 is exactly
  // 946,684,800 seconds after the Unix epoch. Anchoring on a calendar date
  // here is how I got it wrong the first time — leap days make 30 "years" of
  // seconds land on 2029-12-31, not 2030-01-01.
  assert.strictEqual(rippleTimeToIso(0), new Date(946_684_800 * 1000).toISOString().replace('T', ' ').slice(0, 19));
  // And it must advance one-for-one with real seconds.
  assert.strictEqual(rippleTimeToIso(61), '2000-01-01 00:01:01');
  assert.strictEqual(rippleTimeToIso(undefined), '');
});

test('the cached amount is read the same way the app books it', () => {
  // processOneXRPLRow prefers delivered_amount_XRP. Partial payments deliver
  // less than Amount, and reading Amount there would overstate the disposal.
  assert.strictEqual(cachedAmountXrp({ delivered_amount_XRP: '250.5', Amount_XRP: '999' }), 250.5);
  assert.strictEqual(cachedAmountXrp({ Amount_XRP: '42' }), 42);
  assert.strictEqual(cachedAmountXrp({}), null);
  assert.strictEqual(cachedAmountXrp({ Amount_XRP: '' }), null);
});


// ── Rate-limit handling ───────────────────────────────────────────────────
// The cluster refuses with a JSON-RPC error at HTTP 200 and tells you exactly
// how long to wait. The first version checked only status codes, so it never
// saw these, burned its retries on a guessed backoff, and gave up — on the two
// BUSIEST wallets, while reporting a confident result for the small ones.

const { retryHintMs, RATE_LIMIT_ERRORS, ledgerHashOf, decodeDoubled, DOUBLED_HASH, toSecond } = require('../scripts/verify-xrpl');

test('the retry hint is read out of the error message', () => {
  assert.strictEqual(retryHintMs('tooBusy: rate limit: units quota (2000 per 10s) exhausted, retry in ~5293ms'), 5293);
  assert.strictEqual(retryHintMs('slowDown: rate limit: units quota (10000 per 60s) exhausted, retry in ~16248ms'), 16248);
  assert.strictEqual(retryHintMs('retry in 900ms'), 900);
  assert.strictEqual(retryHintMs('no hint here'), null);
  assert.strictEqual(retryHintMs(null), null);
  assert.strictEqual(retryHintMs(undefined), null);
});

test('the errors the cluster uses to throttle are all treated as retryable', () => {
  // Observed in a real run against xrplcluster.com.
  assert.ok(RATE_LIMIT_ERRORS.has('tooBusy'));
  assert.ok(RATE_LIMIT_ERRORS.has('slowDown'));
  // And a genuine data error must NOT be retried — retrying it just wastes
  // the quota that the real work needs.
  assert.ok(!RATE_LIMIT_ERRORS.has('actNotFound'));
  assert.ok(!RATE_LIMIT_ERRORS.has('invalidParams'));
});


// ── Double-encoded ids ────────────────────────────────────────────────────
// makeTxHash() maps each CHARACTER of WinDB's TransactionHash through
// charCodeAt and re-hexes it. That is right when WinDB returns 32 raw bytes
// and doubles the length to 128 when WinDB returns the hash as text that is
// already hexadecimal.
//
// The first real run hit exactly this: a wallet whose 140 rows all looked
// "synthetic", so all 146 of its ledger transactions were reported missing —
// on a wallet whose cached and ledger date ranges matched to the day. A
// matcher that cannot recognise the ids in its own database does not find
// missing data, it manufactures it.

const REAL = '032F38BCDECDFBAB8E12F738222B5C7924AD6989816E4DBD6052EEFA01EDA12A';
const asDoubled = (h) => [...h].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').toUpperCase();

test('a double-encoded hash is recognised and decoded back to the ledger hash', () => {
  const doubled = asDoubled(REAL);
  assert.strictEqual(doubled.length, 128);
  assert.ok(DOUBLED_HASH.test(doubled));
  assert.strictEqual(decodeDoubled(doubled), REAL);
  assert.strictEqual(ledgerHashOf(doubled), REAL);
});

test('a plain ledger hash still passes through untouched', () => {
  assert.strictEqual(ledgerHashOf(REAL), REAL);
  assert.strictEqual(ledgerHashOf(REAL.toLowerCase()), REAL);
});

test('a synthetic id yields no hash rather than a wrong one', () => {
  // Returning something plausible here would silently match the wrong
  // transaction, which is worse than admitting the row cannot be checked.
  assert.strictEqual(ledgerHashOf('2020-08-30 193622_rB519yod'.replace(/[^a-zA-Z0-9_]/g, '')), null);
  assert.strictEqual(ledgerHashOf(''), null);
  assert.strictEqual(ledgerHashOf(null), null);
  // 128 characters that are hex but do not decode to a valid hash.
  assert.strictEqual(ledgerHashOf('F'.repeat(128)), null);
});


// ── Timestamp fallback ────────────────────────────────────────────────────
// WinDB does not always return TransactionHash. On a real wallet ZERO of 140
// rows had one, so hash matching found nothing and the tool reported all 146
// ledger transactions — 435,663 XRP — as missing from a cache whose date range
// matched the ledger to the day. The synthetic id still carries the timestamp,
// so completeness stays answerable at second resolution.

test('a WinDB timestamp truncates to the second the ledger records', () => {
  // The real stored form, taken from an actual cache id: nanoseconds.
  assert.strictEqual(toSecond('2020-08-30 19:35:20.367000023'), '2020-08-30 19:35:20');
  assert.strictEqual(toSecond('2020-08-30T19:35:20Z'), '2020-08-30 19:35:20');
  assert.strictEqual(toSecond('2020-08-30 19:35:20'), '2020-08-30 19:35:20');
});

test('an unusable timestamp yields no key rather than a truncated wrong one', () => {
  // A partial key would collide with real seconds and silently pair unrelated
  // transactions, which is worse than declining to match.
  assert.strictEqual(toSecond('2020-08-30'), '');
  assert.strictEqual(toSecond(''), '');
  assert.strictEqual(toSecond(null), '');
  assert.strictEqual(toSecond(undefined), '');
});

test('same-second transactions are compared by count, not paired arbitrarily', () => {
  // The rule the matcher applies: only the SURPLUS in a second is missing.
  // Ledger 3, cache 2 means one missing — not three, and not zero.
  const surplus = (ledgerCount, cachedCount) => Math.max(0, ledgerCount - cachedCount);
  assert.strictEqual(surplus(3, 2), 1);
  assert.strictEqual(surplus(1, 1), 0);
  assert.strictEqual(surplus(1, 0), 1);
  // A cache holding MORE than the ledger in one second is not negative-missing.
  assert.strictEqual(surplus(2, 5), 0);
});


// ── --amm and the paid endpoint ───────────────────────────────────────────

const fs = require('fs');

test('--amm is parsed, and is off unless asked for', () => {
  const { parseArgs } = require('../scripts/verify-xrpl');
  assert.strictEqual(parseArgs(['node', 'x']).amm, false);
  assert.strictEqual(parseArgs(['node', 'x', '--amm']).amm, true);
  // It must compose with the filters, or checking one wallet means checking all.
  const a = parseArgs(['node', 'x', '--amm', '--wallet', 'rEXAMPLE', '--out', 'f.csv']);
  assert.strictEqual(a.amm, true);
  assert.strictEqual(a.wallet, 'rEXAMPLE');
  assert.strictEqual(a.csv, 'f.csv');
});

test('the Payment-Claim is read from the environment, never from argv', () => {
  // A claim on the command line ends up in shell history and the process
  // list. There must be no flag that accepts one.
  const src = fs.readFileSync(require.resolve('../scripts/verify-xrpl'), 'utf8');
  assert.ok(/process\.env\.DHALI_PAYMENT_CLAIM/.test(src), 'claim must come from the environment');
  assert.ok(!/--claim|--payment-claim/i.test(src.replace(/DHALI_PAYMENT_CLAIM/g, '')),
    'no CLI flag may accept a Payment-Claim');
});

test('the Payment-Claim is never printed, logged, or written to CSV', () => {
  const src = fs.readFileSync(require.resolve('../scripts/verify-xrpl'), 'utf8');
  // Every use of the claim variable, other than reading it and setting the
  // header, is a leak. Two references: the assignment and the header.
  // Assert on what each use DOES, not on how many there are — a count breaks
  // on a harmless refactor and passes on a harmful one.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const lines = code.split('\n').filter((l) => /(?<!DHALI_)\bPAYMENT_CLAIM\b/.test(l));
  assert.ok(lines.length > 0, 'the claim should be used somewhere');
  const ALLOWED = [
    /^const PAYMENT_CLAIM = process\.env\.DHALI_PAYMENT_CLAIM \|\| '';$/,  // read it
    /^const PAID = !!PAYMENT_CLAIM;$/,                                      // test it
    /headers\['Payment-Claim'\] = PAYMENT_CLAIM;$/,                         // send it
  ];
  for (const line of lines) {
    const t = line.trim();
    assert.ok(ALLOWED.some((re) => re.test(t)),
      'a Payment-Claim may only be read, tested and sent — never printed or stored: ' + t);
  }
  // Naming the environment variable in help text is fine and useful; printing
  // its VALUE is not. The per-line check above already covers the difference,
  // so this only guards the obvious spelling.
  assert.ok(!/console\.\w+\([^)]*(?<!DHALI_)\bPAYMENT_CLAIM\b/.test(code),
    'the claim value must never be printed');
});

test('paid mode only changes pacing, never what is verified', () => {
  const src = fs.readFileSync(require.resolve('../scripts/verify-xrpl'), 'utf8');
  // PAID may gate the header and the delay. If it ever gates a comparison,
  // a paid run and a free run would produce different findings.
  const gated = src.match(/if \(PAID\)[^\n]*/g) || [];
  assert.ok(gated.length > 0, 'PAID should gate something');
  for (const line of gated) {
    assert.ok(/PAUSE_MS|Payment-Claim/.test(line),
      'PAID must only affect pacing and the auth header, not verification: ' + line);
  }
});

test('the database is still opened readonly on the --amm path', () => {
  // --amm reaches the cache through loadCache() like every other mode. If it
  // ever opened its own handle, the readonly guarantee would have a hole.
  const src = fs.readFileSync(require.resolve('../scripts/verify-xrpl'), 'utf8');
  const opens = src.match(/new Database\([^)]*\)/g) || [];
  assert.strictEqual(opens.length, 1, 'exactly one place may open the database');
  assert.ok(/readonly: true/.test(opens[0]), 'it must be readonly');
  assert.ok(/reconcileAmm[\s\S]*?loadCache\(dbPath\)/.test(src), '--amm must go through loadCache');
});

// ── AMM mode flags ────────────────────────────────────────────────────────
//
// The entire conclusion about which withdrawals are understated rests on
// decoding these bits correctly. Values are from the XRPL protocol reference.

test('AMM flag bits match the protocol reference', () => {
  const { AMM_FLAGS } = require('../scripts/verify-xrpl');
  const SPEC = {
    tfLPToken:             0x00010000,
    tfWithdrawAll:         0x00020000,
    tfOneAssetWithdrawAll: 0x00040000,
    tfSingleAsset:         0x00080000,
    tfTwoAsset:            0x00100000,
    tfOneAssetLPToken:     0x00200000,
    tfLimitLPToken:        0x00400000,
  };
  const got = Object.fromEntries(AMM_FLAGS.map(([bit, name]) => [name, bit]));
  assert.deepStrictEqual(got, SPEC);
});

test('ammMode decodes the modes seen in the real run', () => {
  const { ammMode } = require('../scripts/verify-xrpl');
  // These five are what a real 68-transaction reconciliation actually produced.
  assert.strictEqual(ammMode(0x00200000), 'tfOneAssetLPToken');
  assert.strictEqual(ammMode(0x00040000), 'tfOneAssetWithdrawAll');
  assert.strictEqual(ammMode(0x00010000), 'tfLPToken');
  assert.strictEqual(ammMode(0x00020000), 'tfWithdrawAll');
  assert.strictEqual(ammMode(0x00100000), 'tfTwoAsset');
});

test('tfFullyCanonicalSig is ignored — it says nothing about the mode', () => {
  const { ammMode } = require('../scripts/verify-xrpl');
  // Universal signing flag. Letting it through would split every mode into two
  // rows in the breakdown and hide the pattern the whole table exists to show.
  assert.strictEqual(ammMode(0x80000000), '(no mode flag)');
  assert.strictEqual(ammMode(0x80000000 | 0x00200000), 'tfOneAssetLPToken');
  assert.strictEqual(ammMode(0), '(no mode flag)');
});

test('an unknown flag is shown as hex, never silently as "no mode"', () => {
  const { ammMode } = require('../scripts/verify-xrpl');
  // A future mode must be visible as unrecognised rather than pooled with the
  // flagless rows, which would quietly corrupt the breakdown.
  assert.strictEqual(ammMode(0x00800000), '0x800000');
});

console.log('');
if (failures) {
  console.log(`${failures} verify-xrpl test(s) FAILED`);
  process.exit(1);
}
console.log('All verify-xrpl.js tests passed');
