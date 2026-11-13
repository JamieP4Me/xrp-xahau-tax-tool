// test/ledger-rpc.test.js — the main process's read-only ledger route.
//
// What this pins, because each one is a security property rather than a
// convenience: only the listed hosts, only https, only read-only methods, and
// the Payment-Claim travels to Dhali and nowhere else. Plus the retry
// behaviour the on-chain check depends on to survive a busy public node.

const assert = require('assert');
const rpc = require('../ledger-rpc');

let failures = 0;
const pending = [];
function test(name, fn) {
  const run = async () => {
    try { await fn(); console.log(`  ok - ${name}`); }
    catch (e) { failures++; console.log(`  FAIL - ${name}\n    ${String(e.message).split('\n').join('\n    ')}`); }
  };
  pending.push(run);
}

const DHALI = 'https://run.api.dhali.io/8d0eb161-551f-4471-bae7-ff9ef205d62b/';

function fakeFetch(responses, seen) {
  let i = 0;
  return async (url, opts) => {
    seen.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return {
      status: r.status || 200,
      ok: (r.status || 200) < 400,
      headers: { get: (k) => (r.headers || {})[k.toLowerCase()] || null },
      json: async () => r.body,
    };
  };
}

console.log('ledger-rpc — hosts, methods, and where the claim may go');

test('defaults to the public full-history node for each chain', () => {
  assert.strictEqual(rpc.resolveEndpoint('XRPL', ''), 'https://xrplcluster.com/');
  assert.strictEqual(rpc.resolveEndpoint('Xahau', null), 'https://xahau.network/');
});

test('refuses any host not on the list, and anything but https', () => {
  for (const bad of ['https://evil.example/', 'http://xrplcluster.com/', 'https://xrplcluster.com.evil.example/',
                     'https://user:pw@xrplcluster.com/', 'file:///etc/passwd', 'not a url']) {
    assert.throws(() => rpc.resolveEndpoint('XRPL', bad), /ledger-rpc/, bad);
  }
});

test('a Dhali endpoint must name an API id', () => {
  assert.throws(() => rpc.resolveEndpoint('XRPL', 'https://run.api.dhali.io/'), /api id/);
  assert.strictEqual(rpc.resolveEndpoint('XRPL', DHALI.slice(0, -1)), DHALI);
});

test('only read-only methods are accepted', () => {
  for (const m of ['submit', 'sign', 'sign_for', 'submit_multisigned', 'wallet_propose', 'channel_authorize', 'stop', 'ledger_accept', '']) {
    assert.throws(() => rpc.validateRequest({ chain: 'XRPL', method: m, params: {} }), /not allowed/, m);
  }
  for (const m of ['account_info', 'account_lines', 'account_objects', 'account_tx', 'amm_info', 'ledger']) {
    assert.ok(rpc.validateRequest({ chain: 'XRPL', method: m, params: {} }));
  }
});

test('the chain must be named, and params must be a small object', () => {
  assert.throws(() => rpc.validateRequest({ chain: 'ETH', method: 'account_info' }), /chain/);
  assert.throws(() => rpc.validateRequest({ chain: 'XRPL', method: 'account_info', params: [1] }), /params/);
  assert.throws(() => rpc.validateRequest({ chain: 'XRPL', method: 'account_info', params: { x: 'y'.repeat(9000) } }), /too large/);
});

test('the Payment-Claim is sent to Dhali only', async () => {
  const seen = [];
  const ok = { body: { result: { status: 'success', ledger_index: 5 } } };
  await rpc.call({ chain: 'XRPL', method: 'ledger', params: {}, claim: 'SECRET-CLAIM' }, fakeFetch([ok], seen));
  await rpc.call({ chain: 'Xahau', method: 'ledger', params: {}, endpoint: 'https://xahau.network/', claim: 'SECRET-CLAIM' }, fakeFetch([ok], seen));
  await rpc.call({ chain: 'XRPL', method: 'ledger', params: {}, endpoint: DHALI, claim: 'SECRET-CLAIM' }, fakeFetch([ok], seen));
  assert.strictEqual(seen[0].headers['Payment-Claim'], undefined, 'claim sent to a public node');
  assert.strictEqual(seen[1].headers['Payment-Claim'], undefined, 'claim sent to a public node');
  assert.strictEqual(seen[2].headers['Payment-Claim'], 'SECRET-CLAIM');
  assert.strictEqual(seen[2].url, DHALI);
  assert.deepStrictEqual(seen[2].body, { method: 'ledger', params: [{}] });
});

test('maps the node answers the check acts on', async () => {
  const seen = [];
  assert.deepStrictEqual(await rpc.call({ chain: 'XRPL', method: 'account_info', params: {} },
    fakeFetch([{ body: { result: { error: 'actNotFound' } } }], seen)), { notFound: true });
  const lgr = await rpc.call({ chain: 'XRPL', method: 'account_info', params: {} },
    fakeFetch([{ body: { result: { error: 'lgrNotFound' } } }], seen));
  assert.strictEqual(lgr.ledgerNotFound, true);
  const paid = await rpc.call({ chain: 'XRPL', method: 'ledger', params: {}, endpoint: DHALI, claim: 'C' },
    fakeFetch([{ status: 402, body: {} }], seen));
  assert.strictEqual(paid.error, 'paymentRequired');
});

test('waits as told on tooBusy and then succeeds', async () => {
  const seen = [];
  const t0 = Date.now();
  const out = await rpc.call({ chain: 'XRPL', method: 'ledger', params: {} }, fakeFetch([
    { body: { result: { error: 'tooBusy', error_message: 'retry in ~10ms' } } },
    { body: { result: { ledger_index: 9 } } },
  ], seen));
  assert.strictEqual(out.ledger_index, 9);
  assert.strictEqual(seen.length, 2);
  assert.ok(Date.now() - t0 >= 1000, 'did not back off');
});

test('an error message never carries the claim', async () => {
  const seen = [];
  const out = await rpc.call({ chain: 'XRPL', method: 'ledger', params: {}, endpoint: DHALI, claim: 'SECRET-CLAIM' },
    fakeFetch([{ body: { result: { error: 'internal', error_message: 'boom' } } }], seen));
  assert.ok(!JSON.stringify(out).includes('SECRET-CLAIM'));
});

(async () => {
  for (const run of pending) await run();
  if (failures) { console.log(`\n${failures} test(s) FAILED`); process.exit(1); }
  console.log('\nAll ledger-rpc tests passed');
})();
