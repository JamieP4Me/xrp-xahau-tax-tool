#!/usr/bin/env node
/**
 * What did each onexah LP token cost? Show the shape before building a rule.
 *
 * THE QUESTION
 *
 * Inbound Remits deliver tokens -- XXX, XLP, ELP, RLP, VLP, RVN, LXH, LEV,
 * EVR -- from onexah protocol addresses. A token received for depositing
 * into a pool, or for a swap, has a basis equal to what was GIVEN UP for it,
 * valued that day -- not its unit count times anything. Basis therefore
 * lives in a DIFFERENT transaction: the outbound deposit or payment that paid
 * for it. The Remit does not name that transaction.
 *
 * WHY THIS IS A PROBE AND NOT A RULE
 *
 * Nothing in this project yet says what an onexah deposit looks like in the
 * cache: an outbound Payment, an outbound Remit, or both; to the same address
 * that sends the token back, or another; seconds before the receipt, or
 * hours. A pairing rule written from a guess about that would be the same
 * mistake as the four amount bugs already fixed -- reading a field and
 * assuming what moved. So this measures first:
 *
 *   1. per counterparty: everything sent to it versus everything received
 *      from it. Robust to timing, and often enough on its own.
 *   2. per inbound token leg: the nearest preceding outbound transaction,
 *      and how far before. Shows whether a time window can pair them.
 *   3. what is left unmatched, so nothing is silently assigned.
 *
 * READONLY, always. It writes nothing and books nothing. No address is
 * written into this file; it discovers them from the cache.
 *
 *   npm run lp:pairing
 *   npm run lp:pairing -- --window 120      (minutes to look back, default 60)
 */
'use strict';

const { parseArgs, openCache, decodeCurrency } = require('./iou-inventory');

// The shared parseArgs exits on any flag it does not know, so hand it only
// what it understands and read ours separately.
let windowMin = 60;
const shared = [process.argv[0], process.argv[1]];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--window') windowMin = Number(process.argv[++i]) || 60;
  else if (a === '--db') { shared.push(a, process.argv[++i]); }
  else { console.error('Unknown argument: ' + a); process.exit(1); }
}
const args = parseArgs(shared);
const db = openCache(args.db);

const NUL = String.fromCharCode(0);
const clean = (v) => String(v == null ? '' : v).split(NUL).join('').trim();
// 10 characters, not 8: protocol addresses sharing a prefix (two pools both
// starting rLoA, say) printed identically at 8 and made the table ambiguous.
const short = (a) => a ? a.slice(0, 10) + '..' : '(none)';
const tsMs = (t) => Date.parse(String(t).replace(' ', 'T').slice(0, 23) + 'Z');
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const fmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 6 });
const amounts = (raw) => {
  let a = raw.Amounts;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch (e) { a = null; } }
  return Array.isArray(a) ? a : [];
};

// Every asset a transaction moved, as [{asset, qty}]. Native XAH is 'XAH'.
function legsOf(raw) {
  const out = [];
  const t = clean(raw.TransactionType);
  if (t === 'Remit') {
    for (const e of amounts(raw)) {
      if (!e || typeof e !== 'object') continue;
      const x = num(e.XRP);
      if (x > 0) { out.push({ asset: 'XAH', qty: x }); continue; }
      const q = num(e.token_value), c = decodeCurrency(clean(e.token_currency));
      if (q > 0 && c) out.push({ asset: c, qty: q, issuer: clean(e.token_issuer) });
    }
  } else {
    const x = num(raw.delivered_amount_XRP) || num(raw.Amount_XRP);
    if (x > 0) out.push({ asset: 'XAH', qty: x });
    const c = decodeCurrency(clean(raw.delivered_amount_currency) || clean(raw.Amount_currency));
    const q = num(raw.delivered_amount_value) || num(raw.Amount_value);
    if (c && q > 0) out.push({ asset: c, qty: q, issuer: clean(raw.Amount_issuer) });
  }
  return out;
}

// -- 1. which wallets receive Remits, and from whom -------------------------
const remitWallets = db.prepare(
  "SELECT DISTINCT wallet FROM raw_transactions WHERE chain = 'Xahau' AND tx_type = 'Remit'"
).all().map(r => r.wallet);
console.log(`cache: ${args.db}`);
console.log(`wallets with Remit activity: ${remitWallets.length}\n`);

for (const wallet of remitWallets) {
  const rows = db.prepare(
    "SELECT timestamp, raw_json FROM raw_transactions " +
    "WHERE wallet = ? AND chain = 'Xahau' AND tx_type IN ('Payment','Remit','OfferCreate') " +
    "AND timestamp >= '2026-01-01' ORDER BY timestamp"
  ).all(wallet);

  const events = [];
  for (const r of rows) {
    let raw; try { raw = JSON.parse(r.raw_json); } catch (e) { continue; }
    if (clean(raw.TransactionResult) && clean(raw.TransactionResult) !== 'tesSUCCESS') continue;
    const legs = legsOf(raw);
    if (!legs.length) continue;
    const dir = raw.Account === wallet && raw.Destination !== wallet ? 'out'
              : raw.Destination === wallet && raw.Account !== wallet ? 'in' : 'self';
    if (dir === 'self') continue;
    events.push({ ms: tsMs(r.timestamp), ts: String(r.timestamp).slice(0, 19),
                  type: clean(raw.TransactionType), dir,
                  peer: dir === 'out' ? raw.Destination : raw.Account, legs });
  }

  // The protocol set: anyone who sent this wallet a Remit carrying a token.
  const protocol = new Set(events.filter(e => e.dir === 'in' && e.type === 'Remit' &&
                                             e.legs.some(l => l.asset !== 'XAH')).map(e => e.peer));
  console.log(`=== wallet ${short(wallet)}: ${events.length} 2026 value-moving rows, ` +
              `${protocol.size} protocol counterparties ===\n`);

  // -- 2. per counterparty: given versus received ---------------------------
  console.log('--- per counterparty: everything SENT to it vs everything RECEIVED from it ---');
  for (const p of protocol) {
    const sent = {}, recv = {};
    let ns = 0, nr = 0, types = new Set();
    for (const e of events.filter(x => x.peer === p)) {
      const bag = e.dir === 'out' ? sent : recv;
      e.dir === 'out' ? ns++ : nr++;
      types.add(e.dir + ':' + e.type);
      for (const l of e.legs) bag[l.asset] = (bag[l.asset] || 0) + l.qty;
    }
    const show = (b) => Object.keys(b).length
      ? Object.entries(b).map(([k, v]) => fmt(v) + ' ' + k).join(', ') : '(nothing)';
    console.log(`  ${short(p)}  sent ${ns} tx: ${show(sent)}`);
    console.log(`  ${' '.repeat(10)}  recv ${nr} tx: ${show(recv)}`);
    console.log(`  ${' '.repeat(10)}  via ${[...types].join(', ')}\n`);
  }

  // -- 3. per inbound token leg: the nearest outbound before it -------------
  // Looks back up to `windowMin` minutes for the nearest outbound row of any
  // kind, and reports whether it went to the same counterparty, another
  // protocol address, or elsewhere. Distance is shown, never used to assign.
  const outs = events.filter(e => e.dir === 'out');
  const receipts = [];
  for (const e of events.filter(x => x.dir === 'in' && x.type === 'Remit')) {
    for (const l of e.legs) if (l.asset !== 'XAH') receipts.push({ ...e, leg: l });
  }
  const W = windowMin * 60 * 1000;
  const buckets = { '<= 1 min': 0, '<= 10 min': 0, ['<= ' + windowMin + ' min']: 0, 'none in window': 0 };
  const rel = { same: 0, otherProtocol: 0, elsewhere: 0 };
  const unmatched = {};
  const samples = [];
  for (const rc of receipts) {
    let best = null;
    for (const o of outs) {
      if (o.ms > rc.ms) break;
      if (rc.ms - o.ms <= W) {
        // Nearest preceding, full stop. An earlier version also claimed to
        // prefer the same counterparty, but the nearest-in-time test overwrote
        // that preference -- a rule that says one thing and does another. The
        // relationship is REPORTED below instead of used to choose.
        if (!best || o.ms > best.ms) best = o;
      }
    }
    if (!best) {
      buckets['none in window']++;
      unmatched[rc.leg.asset] = (unmatched[rc.leg.asset] || 0) + 1;
      continue;
    }
    const dt = (rc.ms - best.ms) / 1000;
    if (dt <= 60) buckets['<= 1 min']++; else if (dt <= 600) buckets['<= 10 min']++;
    else buckets['<= ' + windowMin + ' min']++;
    if (best.peer === rc.peer) rel.same++; else if (protocol.has(best.peer)) rel.otherProtocol++; else rel.elsewhere++;
    if (samples.length < 18) samples.push({ rc, best, dt });
  }

  console.log(`--- ${receipts.length} inbound token legs: how soon before each was there an outbound? ---`);
  for (const [k, v] of Object.entries(buckets)) console.log(`  ${k.padEnd(16)} ${String(v).padStart(5)}`);
  console.log(`  nearest outbound went to: the same counterparty ${rel.same}, ` +
              `another protocol address ${rel.otherProtocol}, somewhere else ${rel.elsewhere}`);

  console.log('\n--- sample: receipt  <-  nearest preceding outbound ---');
  for (const s of samples) {
    const got = fmt(s.rc.leg.qty) + ' ' + s.rc.leg.asset;
    const gave = s.best.legs.map(l => fmt(l.qty) + ' ' + l.asset).join(' + ');
    const where = s.best.peer === s.rc.peer ? 'same peer' : (protocol.has(s.best.peer) ? 'other protocol' : 'ELSEWHERE');
    console.log(`  ${s.rc.ts}  got ${got.padEnd(22)} from ${short(s.rc.peer)}  <- ${String(Math.round(s.dt)).padStart(5)}s  ` +
                `gave ${gave} via ${s.best.type} to ${short(s.best.peer)} (${where})`);
  }

  console.log('\n--- receipts with NO outbound in the window (these cannot be paired by time) ---');
  if (!Object.keys(unmatched).length) console.log('  (none)');
  for (const [k, v] of Object.entries(unmatched).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(6)} ${v}`);
  console.log();
}

db.close();
