// ledger-rpc.js — the app's one read-only path to a live XRPL / Xahau node.
//
// WHY IT LIVES IN THE MAIN PROCESS
//
// The on-chain balance check needs what WinDB does not hold: an account's
// balance, trust lines and escrows as of a given ledger, and each
// transaction's metadata (the before/after balances the ledger itself
// recorded). Those come from a full-history node's JSON-RPC.
//
// The renderer's Content-Security-Policy pins its network access to WinDB
// (connect-src https://run.api.dhali.io) and that stays exactly as it is.
// Instead the renderer asks the main process, over one guarded IPC handler,
// to make a request, and this module decides whether the request is allowed:
//
//   * HOSTS. Only the servers listed below, over https. A page that somehow
//     ran injected script still cannot make this module talk to anywhere else.
//   * METHODS. Only read-only methods. Nothing here can submit, sign, or
//     change anything on any ledger; there is no method on the list that can.
//   * PAYMENT-CLAIM. Sent only to run.api.dhali.io, the provider it was
//     issued for. It is never sent to a public node, never logged, never put
//     in an error message, and never stored. Same rule as everywhere else in
//     this project.
//
// It answers with the node's `result` object, or one of three plain flags
// the caller can act on: notFound (the account does not exist at that
// ledger), ledgerNotFound (the node does not hold that ledger), or error.
'use strict';

const DEFAULT_ENDPOINTS = {
  XRPL: 'https://xrplcluster.com/',
  Xahau: 'https://xahau.network/',
};

// Full-history public servers, plus Dhali for the paid route. Adding a host
// here widens what the app can reach: do it on purpose, never as a fix for a
// failing call.
const ALLOWED_HOSTS = new Set([
  'xrplcluster.com',
  's2.ripple.com',
  'xahau.network',
  'run.api.dhali.io',
]);

const PAID_HOST = 'run.api.dhali.io';

// Read-only, every one of them. account_tx is the transaction walk; ledger is
// used to find which ledger closed at a given time.
const READ_ONLY_METHODS = new Set([
  'account_info',
  'account_lines',
  'account_objects',
  'account_tx',
  'amm_info',
  'ledger',
  'server_info',
]);

const RATE_LIMIT_ERRORS = new Set(['tooBusy', 'slowDown', 'noNetwork', 'noCurrent', 'tooManyRequests']);
const MAX_RETRIES = 6;
const TIMEOUT_MS = 45000;
const MAX_PARAMS_BYTES = 8192;

// Validate and normalise an endpoint. Returns the URL string or throws.
function resolveEndpoint(chain, endpoint) {
  const raw = String(endpoint || '').trim() || DEFAULT_ENDPOINTS[chain];
  if (!raw) throw new Error('ledger-rpc: unknown chain ' + JSON.stringify(chain));
  let u;
  try { u = new URL(raw); } catch (e) { throw new Error('ledger-rpc: not a valid URL'); }
  if (u.protocol !== 'https:') throw new Error('ledger-rpc: only https endpoints are allowed');
  if (!ALLOWED_HOSTS.has(u.hostname)) throw new Error('ledger-rpc: ' + u.hostname + ' is not an allowed ledger server');
  if (u.username || u.password) throw new Error('ledger-rpc: credentials in the URL are not allowed');
  if (u.hostname === PAID_HOST && !/^\/[0-9a-f-]{36}\/?$/i.test(u.pathname)) {
    throw new Error('ledger-rpc: a Dhali endpoint must be https://run.api.dhali.io/<api id>/');
  }
  // JSON-RPC posts to the root path; a trailing slash is what the public
  // nodes and Dhali both expect.
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  u.search = ''; u.hash = '';
  return u.toString();
}

function validateRequest(req) {
  if (!req || typeof req !== 'object') throw new Error('ledger-rpc: request must be an object');
  const chain = req.chain === 'Xahau' ? 'Xahau' : req.chain === 'XRPL' ? 'XRPL' : null;
  if (!chain) throw new Error('ledger-rpc: chain must be XRPL or Xahau');
  const method = String(req.method || '');
  if (!READ_ONLY_METHODS.has(method)) throw new Error('ledger-rpc: method ' + JSON.stringify(method) + ' is not allowed');
  const params = req.params == null ? {} : req.params;
  if (typeof params !== 'object' || Array.isArray(params)) throw new Error('ledger-rpc: params must be an object');
  const body = JSON.stringify({ method, params: [params] });
  if (body.length > MAX_PARAMS_BYTES) throw new Error('ledger-rpc: request too large');
  const url = resolveEndpoint(chain, req.endpoint);
  const host = new URL(url).hostname;
  const claim = typeof req.claim === 'string' ? req.claim.trim() : '';
  return { chain, method, url, body, sendClaim: host === PAID_HOST && claim ? claim : '' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function retryHintMs(message) {
  const m = /retry in ~?(\d+)\s*ms/i.exec(String(message || ''));
  if (!m) return null;
  const ms = parseInt(m[1], 10);
  return Number.isFinite(ms) ? ms : null;
}

// One request with retries. `fetchImpl` is injectable for the tests.
async function call(req, fetchImpl = globalThis.fetch) {
  const v = validateRequest(req);
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (v.sendClaim) headers['Payment-Claim'] = v.sendClaim;
      const res = await fetchImpl(v.url, { method: 'POST', headers, body: v.body, signal: ctrl.signal });
      if (res.status === 429 || res.status === 503) {
        lastErr = new Error('HTTP ' + res.status);
        await sleep((retryHintMs(res.headers && res.headers.get && res.headers.get('retry-after')) || 4000) + 500);
        continue;
      }
      if (res.status === 402) return { error: 'paymentRequired', error_message: 'the Payment-Claim was refused or has run out' };
      if (!res.ok) { lastErr = new Error('HTTP ' + res.status); if (attempt < MAX_RETRIES) await sleep(1500 * (attempt + 1)); continue; }
      const body = await res.json();
      const result = body && body.result;
      if (!result) return { error: 'badResponse', error_message: 'no result in the response' };
      const err = result.error;
      if (err === 'actNotFound') return { notFound: true };
      if (err === 'lgrNotFound' || err === 'lgrIdxsInvalid' || err === 'lgrIdxMalformed') return { ledgerNotFound: true, error: err };
      if (err && RATE_LIMIT_ERRORS.has(err)) {
        lastErr = new Error(err);
        await sleep((retryHintMs(result.error_message) || 8000) + 1000);
        continue;
      }
      if (err) return { error: String(err), error_message: String(result.error_message || '') };
      return result;
    } catch (e) {
      lastErr = e && e.name === 'AbortError' ? new Error('timed out') : e;
      if (attempt < MAX_RETRIES) await sleep(1500 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  // Never echo the request: it is harmless today, but the claim travels with
  // it and an error string is exactly what ends up in logs and screenshots.
  return { error: 'unreachable', error_message: lastErr ? String(lastErr.message || lastErr) : 'request failed' };
}

module.exports = { call, validateRequest, resolveEndpoint, DEFAULT_ENDPOINTS, ALLOWED_HOSTS, READ_ONLY_METHODS, PAID_HOST, retryHintMs };
