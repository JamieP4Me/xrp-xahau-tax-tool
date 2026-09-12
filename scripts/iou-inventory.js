#!/usr/bin/env node
/**
 * Every asset in the cache that is NOT XRP, XAH or EVR.
 *
 * WHY THIS EXISTS
 *
 * The tax engine books three assets. XRP on the XRPL side, XAH and EVR on the
 * Xahau side. Every other token — and a Xaman wallet can easily hold half a
 * dozen — falls through both the booking path and the disclosure path:
 *
 *   BOOKING     the Payment branch reads `delivered_amount_XRP ?? Amount_XRP`.
 *               On an IOU both are empty, parseFloat gives NaN, the `> 0` test
 *               fails, and nothing is booked. It is not even counted as dust.
 *
 *   DISCLOSURE  recordUnvalued() returns early for Payment and OfferCreate,
 *               because those types are in VALUED_TYPES. So unlike the AMM
 *               rows, which at least land on the "not on Form 8949" list,
 *               these appear on no report at all.
 *
 * That second half is what makes this worth a separate tool. A transaction the
 * engine cannot value is a known unknown; a transaction that leaves no trace
 * anywhere is not. The whole point of the disclosure list is that silence
 * becomes a list, and for IOUs the silence was never broken.
 *
 * This reads the cache (READONLY, always) and inventories what is actually
 * there, so the question "does any of this matter for tax" can be answered
 * from measurement instead of from the balances a wallet app happens to show.
 * A current balance says nothing about whether a token was disposed of in a
 * reporting year; only the transaction history does.
 *
 * It books nothing and decides nothing. It tells you what is missing.
 *
 * Usage:
 *   node scripts/iou-inventory.js                 both chains, summary
 *   node scripts/iou-inventory.js --detail        every transaction, per asset
 *   node scripts/iou-inventory.js --chain XRPL
 *   node scripts/iou-inventory.js --out iou.csv   machine-readable
 *   node scripts/iou-inventory.js --db /path/to/tax-data.sqlite3
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

// The three the engine actually books. Everything else is what this reports.
const BOOKED = new Set(['XRP', 'XAH', 'EVR']);

function defaultDbPath() {
  const name = 'XRP & Xahau Tax Tool';
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', name, 'tax-data.sqlite3');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), name, 'tax-data.sqlite3');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name, 'tax-data.sqlite3');
}

// XRPL currency codes are either a 3-character code ("USD", "EVR") or a
// 40-character hex blob holding up to 20 bytes of ASCII, right-padded with
// NULs. Xaman shows the decoded name; the cache stores the hex. Without this
// the inventory would be a list of unreadable hex strings, which is how a
// token worth real money gets ignored as noise.
function decodeCurrency(raw) {
  const c = String(raw || '').trim();
  if (!c) return '';
  if (!/^[0-9A-Fa-f]{40}$/.test(c)) return c.toUpperCase();
  let out = '';
  for (let i = 0; i < 40; i += 2) {
    const b = parseInt(c.slice(i, i + 2), 16);
    if (b === 0) continue;               // NUL padding
    if (b < 0x20 || b > 0x7e) return c;  // not printable ASCII — show the hex
    out += String.fromCharCode(b);
  }
  return out.trim() || c;
}

function parseArgs(argv) {
  const out = { db: defaultDbPath(), chain: null, detail: false, csv: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') out.db = argv[++i];
    else if (a === '--chain') out.chain = argv[++i];
    else if (a === '--detail') out.detail = true;
    else if (a === '--out') out.csv = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
      process.exit(0);
    } else { console.error('Unknown argument: ' + a); process.exit(1); }
  }
  return out;
}

// One transaction's worth of non-native movement, or null.
//
// Deliberately covers both sides of an OfferCreate. A DEX trade that sells one
// IOU for another has no native leg at all, so reading only the "Amount"
// fields would miss the entire transaction.
function nonNativeLegs(raw) {
  const legs = [];
  const add = (cur, iss, val, role) => {
    const c = decodeCurrency(cur);
    if (!c || BOOKED.has(c.toUpperCase())) return;
    const v = parseFloat(val);
    legs.push({ currency: c, issuer: String(iss || '').trim(), qty: Number.isFinite(v) ? v : null, role });
  };
  const t = raw.TransactionType;
  if (t === 'Payment') {
    add(raw.delivered_amount_currency ?? raw.Amount_currency,
        raw.delivered_amount_issuer ?? raw.Amount_issuer,
        raw.delivered_amount_value ?? raw.Amount_value, 'payment');
  } else if (t === 'OfferCreate') {
    add(raw.TakerGets_currency, raw.TakerGets_issuer, raw.TakerGets_value, 'sold (TakerGets)');
    add(raw.TakerPays_currency, raw.TakerPays_issuer, raw.TakerPays_value, 'bought (TakerPays)');
  } else {
    // Any other type that carries an Amount — AMM, escrow, check, remit.
    add(raw.Amount_currency, raw.Amount_issuer, raw.Amount_value, t);
  }
  return legs;
}

function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(args.db)) {
    console.error(`\nNo cache found at:\n    ${args.db}\n\nPass --db /path/to/tax-data.sqlite3 if it lives elsewhere.\n`);
    process.exit(1);
  }
  // readonly, always: this script audits tax data and must never alter it.
  const db = new Database(args.db, { readonly: true, fileMustExist: true });

  const chains = args.chain ? [args.chain] : ['XRPL', 'Xahau'];
  const rows = [];
  const byAsset = new Map();
  let scanned = 0, failedSkipped = 0;

  for (const chain of chains) {
    const stmt = db.prepare(
      'SELECT wallet, timestamp, raw_json FROM raw_transactions WHERE chain = ? ORDER BY timestamp');
    for (const r of stmt.iterate(chain)) {
      scanned++;
      let raw;
      try { raw = JSON.parse(r.raw_json); } catch (e) { continue; }
      // A failed transaction moved nothing. Same rule the engine and the AMM
      // reconciler now use — see the tesSUCCESS note in verify-xrpl.js.
      if (raw.TransactionResult && raw.TransactionResult !== 'tesSUCCESS') { failedSkipped++; continue; }
      for (const leg of nonNativeLegs(raw)) {
        const dir = raw.Account === r.wallet ? 'out' : (raw.Destination === r.wallet ? 'in' : '—');
        const key = `${chain}|${leg.currency}|${leg.issuer}`;
        let e = byAsset.get(key);
        if (!e) {
          e = { chain, currency: leg.currency, issuer: leg.issuer, n: 0, qtyIn: 0, qtyOut: 0,
                noQty: 0, wallets: new Set(), first: r.timestamp, last: r.timestamp, years: new Set() };
          byAsset.set(key, e);
        }
        e.n++;
        e.wallets.add(r.wallet);
        e.years.add(String(r.timestamp).slice(0, 4));
        if (r.timestamp < e.first) e.first = r.timestamp;
        if (r.timestamp > e.last) e.last = r.timestamp;
        if (leg.qty == null) e.noQty++;
        else if (dir === 'in') e.qtyIn += leg.qty;
        else if (dir === 'out') e.qtyOut += leg.qty;
        rows.push({ chain, wallet: r.wallet, timestamp: r.timestamp, type: raw.TransactionType,
                    role: leg.role, dir, currency: leg.currency, issuer: leg.issuer, qty: leg.qty });
      }
    }
  }

  const assets = [...byAsset.values()].sort((a, b) => b.n - a.n);

  console.log('');
  console.log('Assets in the cache that the tax engine does NOT book');
  console.log('='.repeat(78));
  console.log(`Scanned ${scanned.toLocaleString()} cached transaction(s)` +
              `${failedSkipped ? `, skipping ${failedSkipped.toLocaleString()} that failed on-chain` : ''}.`);
  console.log('');

  if (!assets.length) {
    console.log('No non-XRP/XAH/EVR assets found. Nothing is being missed on this front.');
    db.close();
    return;
  }

  console.log(`${assets.length} distinct asset(s) found across ${new Set(rows.map(r => r.wallet)).size} wallet(s).`);
  console.log('');
  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  const rpad = (s, n) => String(s).padStart(n);
  console.log(pad('Asset', 14) + pad('Chain', 7) + rpad('Txs', 6) + rpad('Received', 18) +
              rpad('Sent', 18) + '  Years');
  console.log('-'.repeat(78));
  for (const a of assets) {
    const q = (v) => v ? v.toLocaleString(undefined, { maximumFractionDigits: 6 }) : '—';
    console.log(pad(a.currency, 14) + pad(a.chain, 7) + rpad(a.n, 6) +
                rpad(q(a.qtyIn), 18) + rpad(q(a.qtyOut), 18) + '  ' +
                [...a.years].sort().join(', '));
    if (a.noQty) {
      console.log(pad('', 27) + `${a.noQty} row(s) carry no quantity`);
    }
  }

  console.log('');
  console.log('WHAT THIS DOES AND DOES NOT TELL YOU');
  console.log('-'.repeat(78));
  console.log('These transactions are in your cache and are NOT on Form 8949, and were not on');
  console.log('the "not on Form 8949" disclosure list either — the engine drops them silently.');
  console.log('');
  console.log('A "Sent" figure is the one that may matter: disposing of a token is a taxable');
  console.log('event whatever the token is. A "Received" figure may be ordinary income at fair');
  console.log('market value if it was an airdrop or a reward, or a purchase if you paid for it.');
  console.log('');
  console.log('This tool does NOT price any of it. Most of these tokens have thin or no market,');
  console.log('and a made-up price is worse than no price. Take the quantities and dates to');
  console.log('whoever prepares the return, and decide asset by asset what is material.');
  console.log('');
  console.log('Run again with --detail for every transaction, or --out FILE.csv to export.');

  if (args.detail) {
    console.log('');
    console.log('DETAIL');
    console.log('='.repeat(78));
    for (const a of assets) {
      console.log('');
      console.log(`${a.currency}  (${a.chain}${a.issuer ? ', issuer ' + a.issuer.slice(0, 12) + '…' : ''})`);
      for (const r of rows.filter(r => r.currency === a.currency && r.chain === a.chain)) {
        console.log(`  ${String(r.timestamp).slice(0, 19)}  ${pad(r.type, 16)} ${pad(r.dir, 4)} ` +
                    `${rpad(r.qty == null ? '—' : r.qty, 18)}  ${r.wallet.slice(0, 12)}…`);
      }
    }
  }

  if (args.csv) {
    const cell = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = ['Chain,Wallet,Timestamp,Type,Role,Direction,Asset,Issuer,Quantity',
      ...rows.map(r => [r.chain, r.wallet, r.timestamp, r.type, r.role, r.dir,
                        r.currency, r.issuer, r.qty == null ? '' : r.qty].map(cell).join(','))];
    fs.writeFileSync(args.csv, lines.join('\n'));
    console.log('');
    console.log(`Wrote ${rows.length.toLocaleString()} row(s) to ${args.csv}`);
    console.log('NOTE: that file contains wallet addresses. It is gitignored; keep it local.');
  }

  db.close();
}

if (require.main === module) main();

module.exports = { decodeCurrency, nonNativeLegs, BOOKED, parseArgs };
