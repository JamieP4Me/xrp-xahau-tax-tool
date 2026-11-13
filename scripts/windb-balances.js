#!/usr/bin/env node
/**
 * What WinDB's balance tables say about ONE of your wallets, to settle how
 * they behave before the app builds on them:
 *   - is accounts.Balance in drops, and does it match the newest history row?
 *   - is account_balance_history one row per ACTIVE day (sparse), and is the
 *     Balance the end-of-day figure (LastActiveLedgerIndex closes that day)?
 *   - how does token_balance_history spell EVR (code vs hex) and its issuer?
 *   - will WinDB answer a two-wallet IN () on these tables (fewer queries)?
 * Read-only, a handful of tiny queries. Claim from the environment only:
 *
 *   npm run windb:balances -- --wallet <your address> [--wallet2 <another of yours>]
 */
'use strict';
const claim = process.env.DHALI_PAYMENT_CLAIM;
if (!claim) {
  console.error('\nDHALI_PAYMENT_CLAIM is not set. In zsh:\n');
  console.error('  read -rs "DHALI_PAYMENT_CLAIM?Paste the Payment-Claim and press Enter: "; echo; export DHALI_PAYMENT_CLAIM\n');
  process.exit(1);
}
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? String(process.argv[i + 1] || '') : ''; };
const W = arg('--wallet'), W2 = arg('--wallet2');
const ok = (a) => /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a);
if (!ok(W) || (W2 && !ok(W2))) { console.error('--wallet <r-address> is required (and --wallet2, if given, must be an r-address)'); process.exit(2); }
const mask = (s) => String(s).split(W).join(W.slice(0, 6) + '…').split(W2 || '\u0000').join((W2 || '').slice(0, 6) + '…');
const EP = 'https://run.api.dhali.io/8d0eb161-551f-4471-bae7-ff9ef205d62b/';
async function q(sql) {
  const res = await fetch(EP, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'Payment-Claim': claim }, body: sql.trim() + '\nFORMAT JSONEachRow' });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200).split(claim).join('<claim>')}`);
  return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
async function show(title, sql) {
  console.log(`\n-- ${title}`);
  try { const rows = await q(sql); console.log(rows.length ? rows.map((r) => '   ' + mask(JSON.stringify(r))).join('\n') : '   (no rows)'); return rows; }
  catch (e) { console.log('   ERROR ' + mask(e.message)); return null; }
}
(async () => {
  for (const db of ['xrpl', 'xahau']) {
    console.log(`\n${'='.repeat(60)}\n${db}\n${'='.repeat(60)}`);
    const acct = await show('accounts (current state)', `SELECT Balance, isActive, LastActiveLedgerIndex, LastActiveTimestamp FROM ${db}.accounts WHERE Account = '${W}'`);
    await show('account_balance_history: newest 6 rows', `SELECT Date, Balance, LastActiveLedgerIndex FROM ${db}.account_balance_history WHERE Account = '${W}' ORDER BY Date DESC LIMIT 6`);
    await show('account_balance_history: size and span', `SELECT count() AS rows, min(Date) AS first, max(Date) AS last, uniqExact(Date) AS days FROM ${db}.account_balance_history WHERE Account = '${W}'`);
    await show('newest history row: does its ledger close on its Date?',
      `SELECT h.Date, h.LastActiveLedgerIndex, l.Timestamp FROM (SELECT Date, LastActiveLedgerIndex FROM ${db}.account_balance_history WHERE Account = '${W}' ORDER BY Date DESC LIMIT 3) h LEFT JOIN ${db}.ledgers l ON l.LedgerIndex = h.LastActiveLedgerIndex`);
    if (acct && acct[0]) await show('ledger of the current state', `SELECT LedgerIndex, Timestamp FROM ${db}.ledgers WHERE LedgerIndex = ${Number(acct[0].LastActiveLedgerIndex) || 0}`);
    await show('token_balances (current), up to 10', `SELECT Issuer, Currency, Balance, LastActiveLedgerIndex FROM ${db}.token_balances WHERE Holder = '${W}' ORDER BY Balance DESC LIMIT 10`);
    await show('token_balance_history: newest 6 rows', `SELECT Date, Issuer, Currency, Balance, LastActiveLedgerIndex FROM ${db}.token_balance_history WHERE Holder = '${W}' ORDER BY Date DESC LIMIT 6`);
    await show('token_balance_history: size per currency', `SELECT Currency, Issuer, count() AS rows, min(Date) AS first, max(Date) AS last FROM ${db}.token_balance_history WHERE Holder = '${W}' GROUP BY Currency, Issuer ORDER BY rows DESC LIMIT 10`);
    if (W2) await show('two wallets in one IN () query', `SELECT Account, count() AS rows FROM ${db}.account_balance_history WHERE Account IN ('${W}', '${W2}') GROUP BY Account`);
  }
  console.log('\nPaste this back to Claude. Your address is shortened to its first six characters.\n');
})().catch((e) => { console.error('\n' + mask(e.message) + '\n'); process.exit(1); });
