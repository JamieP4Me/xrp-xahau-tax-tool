#!/usr/bin/env node
/**
 * Which tables WinDB has besides xrpl.transactions and xahau.transactions.
 *
 * The on-chain check needs, per wallet, what the ledger itself recorded each
 * transaction did to the balance (including transactions where the wallet is
 * neither sender nor destination: a resting DEX offer filled by someone
 * else, a lease payment). The transactions table does not carry that. If
 * WinDB indexes balance changes or account state in another table, the app
 * can download it with the same Payment-Claim and run the whole check from
 * the local cache. This asks, rather than guessing a table name and
 * re-syncing overnight on the guess.
 *
 * Read-only and cheap: SHOW DATABASES / SHOW TABLES / DESCRIBE, no rows.
 * The Payment-Claim is read from the ENVIRONMENT only (zsh):
 *
 *   read -rs "DHALI_PAYMENT_CLAIM?Paste the Payment-Claim and press Enter: "; echo; export DHALI_PAYMENT_CLAIM
 *   npm run windb:tables
 */
'use strict';
const claim = process.env.DHALI_PAYMENT_CLAIM;
if (!claim) {
  console.error('\nDHALI_PAYMENT_CLAIM is not set. In zsh:\n');
  console.error('  read -rs "DHALI_PAYMENT_CLAIM?Paste the Payment-Claim and press Enter: "; echo; export DHALI_PAYMENT_CLAIM');
  console.error('  npm run windb:tables\n');
  process.exit(1);
}
const EP = 'https://run.api.dhali.io/8d0eb161-551f-4471-bae7-ff9ef205d62b/';
async function q(sql) {
  const res = await fetch(EP, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'Payment-Claim': claim },
    body: sql.trim() + '\nFORMAT JSONEachRow',
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200).split(claim).join('<claim>')}`);
  return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const INTERESTING = /balance|change|state|account|trust|line|object|meta|node|offer|amm|escrow|ledger|holding|token/i;
(async () => {
  let dbs = [];
  try { dbs = (await q('SHOW DATABASES')).map((r) => r.name || Object.values(r)[0]); }
  catch (e) { console.log('SHOW DATABASES refused (' + e.message + '); trying xrpl and xahau directly.'); dbs = ['xrpl', 'xahau']; }
  console.log('\nDatabases: ' + dbs.join(', '));
  for (const db of dbs) {
    if (/^(system|information_schema|INFORMATION_SCHEMA)$/.test(db)) continue;
    let tables = [];
    try { tables = (await q(`SHOW TABLES FROM ${db}`)).map((r) => r.name || Object.values(r)[0]); }
    catch (e) { console.log(`\n${db}: could not list tables (${e.message})`); continue; }
    console.log(`\n${'='.repeat(70)}\n${db}: ${tables.length} table(s)\n${'='.repeat(70)}`);
    for (const t of tables) {
      if (t === 'transactions') { console.log(`  ${t}  (already used by the app)`); continue; }
      let cols = [];
      try { cols = await q(`DESCRIBE TABLE ${db}.${t}`); } catch (e) { console.log(`  ${t}  (could not describe: ${e.message})`); continue; }
      const mark = INTERESTING.test(t) ? '  <-- candidate' : '';
      console.log(`\n  ${db}.${t}  ${cols.length} column(s)${mark}`);
      for (let i = 0; i < cols.length; i += 3) {
        console.log('    ' + cols.slice(i, i + 3).map((c) => `${c.name}:${c.type}`.padEnd(40)).join(''));
      }
    }
  }
  console.log('\nPaste this whole output back to Claude. It contains no wallet addresses.\n');
})().catch((e) => { console.error('\n' + e.message + '\n'); process.exit(1); });
