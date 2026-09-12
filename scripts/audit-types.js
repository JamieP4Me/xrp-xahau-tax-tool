#!/usr/bin/env node
/**
 * Every transaction type in the cache, and what the inventory does with it.
 *
 * WHY THIS EXISTS
 *
 * Three bugs in one day, all the same species:
 *
 *   AMMWithdraw          read Account as "sender", so a withdrawal INTO the
 *                        wallet was booked as a disposal.
 *   cross-currency self  Account === Destination === you is a PURCHASE, and
 *                        testing Account first called every one a disposal.
 *   EscrowCreate         names a Destination and carries an Amount but
 *                        delivers nothing; nine were reported as income.
 *
 * Each time the tool read an `Amount` field and assumed the value moved the
 * way the field names implied. Three for three is not bad luck, it is a
 * design flaw: nonNativeLegs() has a catch-all `else` branch that trusts
 * Amount_* for EVERY type it does not specifically handle.
 *
 * So: stop guessing. This enumerates every type actually present, shows which
 * amount-bearing keys it populates, where the wallet sits in it, and what the
 * inventory currently extracts — so each one can be judged against the
 * protocol reference instead of against its field names.
 *
 * READONLY. Reports; changes nothing.
 *
 *   npm run audit:types
 *   npm run audit:types -- --type NFTokenAcceptOffer     full raw samples
 */
'use strict';

const { parseArgs, openCache, nonNativeLegs, NON_DELIVERY } = require('./iou-inventory');

let want = null;
const argv = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--type') { want = String(process.argv[++i] || ''); continue; }
  argv.push(process.argv[i]);
}
const args = parseArgs(argv);
const db = openCache(args.db);
const chains = args.chain ? [args.chain] : ['XRPL', 'Xahau'];

// How the inventory decides direction today, mirrored here so the report
// shows what it ACTUALLY does rather than what it ought to.
function seat(raw, wallet) {
  const a = raw.Account === wallet, d = raw.Destination === wallet;
  if (a && d) return 'BOTH (self)';
  if (a) return 'Account';
  if (d) return 'Destination';
  return 'neither';
}

for (const chain of chains) {
  const byType = new Map();
  for (const r of db.prepare(
    'SELECT wallet, timestamp, raw_json FROM raw_transactions WHERE chain = ?').iterate(chain)) {
    let raw; try { raw = JSON.parse(r.raw_json); } catch (e) { continue; }
    if (raw.TransactionResult && raw.TransactionResult !== 'tesSUCCESS') continue;
    const t = raw.TransactionType || '(none)';
    if (want && t !== want) continue;
    let e = byType.get(t);
    if (!e) {
      e = { n: 0, keys: new Map(), seats: new Map(), legs: 0, legQty: 0, pending: 0,
            noQty: 0, samples: [] };
      byType.set(t, e);
    }
    e.n++;
    for (const k of Object.keys(raw)) {
      if (!/amount|currency|issuer|value|taker|delivered|balance/i.test(k)) continue;
      const s = String(raw[k] == null ? '' : raw[k]).trim();
      if (!s || s === '0') continue;               // 0 carries no information here
      e.keys.set(k, (e.keys.get(k) || 0) + 1);
    }
    const st = seat(raw, r.wallet);
    e.seats.set(st, (e.seats.get(st) || 0) + 1);
    const legs = nonNativeLegs(raw);
    for (const l of legs) {
      e.legs++;
      if (l.pending) e.pending++;
      if (l.qty == null) e.noQty++; else e.legQty += l.qty;
    }
    if (e.samples.length < (want ? 3 : 1) && legs.length) {
      e.samples.push({ ts: r.timestamp, seat: st, raw });
    }
  }
  if (!byType.size) continue;
  console.log('');
  console.log('='.repeat(78));
  console.log(`${chain} — ${byType.size} transaction type(s)`);
  console.log('='.repeat(78));
  for (const [t, e] of [...byType].sort((a, b) => b[1].n - a[1].n)) {
    console.log('');
    console.log(`### ${t}   ${e.n.toLocaleString()} successful row(s)`);
    console.log(`    the wallet sits as: ` +
      [...e.seats].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  '));
    console.log(`    amount-bearing keys populated:`);
    if (!e.keys.size) console.log('        (none — this type carries no amount in the cache)');
    for (const [k, v] of [...e.keys].sort((a, b) => b[1] - a[1])) {
      console.log(`        ${String(v).padStart(9)}  ${k}`);
    }
    const handled = t === 'Payment' ? 'Payment branch (delivered ?? Amount)'
      : t === 'OfferCreate' ? 'OfferCreate branch (BOTH TakerGets and TakerPays)'
      : NON_DELIVERY.has(t) ? 'NON_DELIVERY — flagged, excluded from totals'
      : 'CATCH-ALL else branch (trusts Amount_*)';
    console.log(`    inventory treats it via: ${handled}`);
    console.log(`    -> ${e.legs} non-native leg(s), ${e.pending} flagged pending, ` +
                `${e.noQty} with no quantity, total qty ${e.legQty.toLocaleString(undefined, {maximumFractionDigits: 4})}`);
    for (const s of e.samples) {
      console.log(`\n    sample ${String(s.ts).slice(0, 19)}  (wallet is ${s.seat})`);
      for (const k of Object.keys(s.raw)) {
        const v = String(s.raw[k] == null ? '' : s.raw[k]);
        if (!v.trim() || v === '0') continue;
        console.log(`        ${k}: ${v.length > 80 ? v.slice(0, 80) + '...' : v}`);
      }
    }
  }
}
db.close();
