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
 * Usage — via npm, so the native module gets rebuilt for plain Node first
 * (see the ABI note below; a bare `node scripts/...` fails after a release
 * build, and says so):
 *
 *   npm run iou:inventory                     both chains, summary
 *   npm run iou:inventory -- --detail         every transaction, per asset
 *   npm run iou:inventory -- --chain XRPL
 *   npm run iou:inventory -- --out iou.csv    machine-readable
 *   npm run iou:inventory -- --db /path/to/tax-data.sqlite3
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// better-sqlite3 is a native module with ONE build at a time, and this repo
// needs two ABIs: Electron's (the app) and plain Node's (this script and the
// tests). Whichever ran last wins, so running `node scripts/iou-inventory.js`
// straight after `npm run dist:mac` throws ERR_DLOPEN_FAILED with a stack
// trace that says "recompile" without saying how.
//
// NOTE the binding loads LAZILY. `require('better-sqlite3')` succeeds; the
// throw happens inside `new Database(...)`. A first attempt at this guard
// wrapped the require and never fired once — which is why openCache() exists
// rather than a try around the import.
const Database = require('better-sqlite3');

function openCache(dbPath) {
  try {
    // readonly, always: this script audits tax data and must never alter it.
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (e) {
    if (e && e.code === 'ERR_DLOPEN_FAILED') {
      console.error('\nbetter-sqlite3 is currently built for Electron, not for plain Node.');
      console.error('(Whichever ran last wins; a release build leaves it on Electron.)\n');
      console.error('Run this instead \u2014 it rebuilds for Node first:\n');
      console.error('    npm run iou:inventory\n');
      console.error('...passing any flags after a double dash:\n');
      console.error('    npm run iou:inventory -- --detail\n');
      console.error('The app rebuilds itself the same way on the next `npm start` or `npm run dist:mac`.\n');
      process.exit(1);
    }
    throw e;
  }
}

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
  // `??` falls back only on null/undefined, and WinDB stores EMPTY STRINGS.
  // So `delivered_amount_currency ?? Amount_currency` keeps the empty string
  // and never reaches the fallback -- decodeCurrency('') returns '', and the
  // whole leg is silently discarded. This is the same bug shape as the
  // engine's own `delivered_amount_XRP ?? Amount_XRP`, copied here by
  // reflex. `pick` treats empty as absent, which is what was meant.
  const pick = (...v) => { for (const x of v) { const s = String(x ?? '').trim(); if (s) return s; } return ''; };
  const t = raw.TransactionType;
  if (t === 'Payment') {
    add(pick(raw.delivered_amount_currency, raw.Amount_currency),
        pick(raw.delivered_amount_issuer, raw.Amount_issuer),
        pick(raw.delivered_amount_value, raw.Amount_value), 'payment');
  } else if (t === 'OfferCreate') {
    add(raw.TakerGets_currency, raw.TakerGets_issuer, raw.TakerGets_value, 'sold (TakerGets)');
    add(raw.TakerPays_currency, raw.TakerPays_issuer, raw.TakerPays_value, 'bought (TakerPays)');
  } else {
    // Any other type that carries an Amount — AMM, escrow, check, remit.
    add(raw.Amount_currency, raw.Amount_issuer, raw.Amount_value, t);
  }
  return legs;
}

// Which way an asset actually moved.
//
// Signing a transaction is not the same as sending an asset. On an AMMWithdraw
// you are the Account -- you signed it -- but the assets travel OUT of the pool
// and INTO your wallet. Reading Account as "outbound" booked a 4,050 SOLO
// withdrawal as a disposal: wrong sign, and wrong by twice the amount in any
// net. Same failure as the cross-currency self-payment below, found the same
// way, by a balance that could not be true.
function directionOf(raw, wallet) {
  const t = raw.TransactionType;
  const isAccount = raw.Account === wallet;
  if (isAccount && t === 'AMMWithdraw') return 'in';
  if (isAccount && t === 'AMMDeposit') return 'out';
  // A cross-currency Payment to YOURSELF is how a token is bought with XRP
  // without placing a DEX offer: SendMax is XRP, Amount is the token,
  // Account === Destination === your own wallet. Testing Account first
  // labelled every one of those a DISPOSAL when it is an ACQUISITION.
  //
  // It also explains a finding that should have looked suspicious on its face:
  // "zero of 20,818 acquisitions were purchases". Purchases made this way were
  // in the data all along, filed under the wrong heading.
  if (isAccount && raw.Destination === wallet) return 'in';
  if (isAccount) return 'out';
  if (raw.Destination === wallet) return 'in';
  return '\u2014';
}

// What LEAVING meant, and what ARRIVING meant.
//
// This used to read a destination equal to the issuer as a burn, full stop,
// and a burn has a specific and painful tax consequence: a section 165
// abandonment loss is a miscellaneous itemized deduction, disallowed
// permanently now that OBBBA made the section 67(g) repeal permanent. So the
// label is not cosmetic -- it decides whether a loss is claimable.
//
// It was also wrong. Measured on a real cache: 42 payments of XXX to onexah
// protocol addresses were reported as burns. They are liquidity-pool deposits.
// Sending XXX to the XLP issuer is how LP tokens are MINTED. The tax question
// there is a section 1001 exchange, not an abandonment -- a different analysis
// with a different answer, reached by guessing from an address.
//
// The fix is not a list of protocol addresses; that would rot. It is a
// property already in the data: A BURN IS ONE-WAY. If an address has ever sent
// this wallet an asset, it is a counterparty you transact with, not a sink you
// abandon tokens into. ctx.inboundFrom holds exactly that, built from every
// cached transaction -- including the Remits whose amounts WinDB dropped,
// because who sent them survived even though what they sent did not.
function classifyRoutes(row, ctx) {
  const out = { disposal: '', acquisition: '' };
  const inboundFrom = (ctx && ctx.inboundFrom) || new Set();
  const issuers = (ctx && ctx.issuers) || new Set();
  const own = (ctx && ctx.ownWallets) || new Set();

  if (row.dir === 'in') {
    out.acquisition = own.has(row.source || '') ? 'moved in from your own wallet (NOT an acquisition)'
      : row.selfPay ? 'bought (cross-currency payment)'
      : row.type === 'AMMWithdraw' ? 'withdrawn from AMM pool'
      : 'received';
    return out;
  }
  if (row.dir !== 'out') return out;
  if (row.type === 'AMMDeposit') { out.disposal = 'deposited to AMM pool'; return out; }
  if (row.type === 'OfferCreate') { out.disposal = 'sale (DEX)'; return out; }

  const dest = row.destination || '';
  if (!dest) return out;
  // Moving a token from one of YOUR wallets to another of YOUR wallets is not
  // a disposal at all -- there is no realisation, the lot just changes hands
  // with itself. This has to be tested BEFORE any issuer rule, because WinDB
  // sometimes records a holder's own address in an issuer field, which put
  // rG9RH into the issuer set and relabelled 97 consolidation transfers as
  // liquidity-pool deposits. One stray row poisoned the whole set.
  if (own.has(dest)) {
    out.disposal = 'moved to your own wallet (NOT a disposal)';
    return out;
  }
  const roundTrip = inboundFrom.has(row.wallet + '|' + dest);

  if (row.issuer && dest === row.issuer) {
    out.disposal = roundTrip
      ? 'returned to issuer (round-trip \u2014 NOT a burn)'
      : 'sent to issuer (possible burn)';
    return out;
  }
  // Sending token X to the address that ISSUES token Y is the signature of a
  // protocol deposit: it is how a liquidity position is opened and how a
  // receipt token gets minted back to you.
  if (issuers.has(dest)) {
    out.disposal = roundTrip
      ? 'to protocol (issues another token, round-trip)'
      : 'sent to the issuer of another token';
    return out;
  }
  out.disposal = roundTrip ? 'sent to a known counterparty' : 'sent to another address';
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(args.db)) {
    console.error(`\nNo cache found at:\n    ${args.db}\n\nPass --db /path/to/tax-data.sqlite3 if it lives elsewhere.\n`);
    process.exit(1);
  }
  const db = openCache(args.db);

  const chains = args.chain ? [args.chain] : ['XRPL', 'Xahau'];
  const rows = [];
  const byAsset = new Map();
  let scanned = 0, failedSkipped = 0;
  const inboundFrom = new Set();   // wallet|counterparty that ever PAID us
  const issuers = new Set();       // every issuing address seen anywhere
  const ownWallets = new Set();    // every wallet in the cache is one of ours

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
      // Built from EVERY transaction, not only ones with a token leg. The 171
      // Remits carry no amounts at all -- WinDB's flattened export has one
      // scalar Amount slot and Remit's payload is an ARRAY -- but they still
      // record who paid whom, and that is all this needs.
      if (raw.Destination === r.wallet && raw.Account && raw.Account !== r.wallet) {
        inboundFrom.add(r.wallet + '|' + raw.Account);
      }
      ownWallets.add(r.wallet);
      for (const leg of nonNativeLegs(raw)) {
        if (leg.issuer) issuers.add(leg.issuer);
        // A cross-currency Payment to YOURSELF is how a token is bought with
        // XRP without placing a DEX offer: SendMax is XRP, Amount is the
        // token, Account === Destination === your own wallet. Testing Account
        // first labelled every one of those a DISPOSAL when it is an
        // ACQUISITION -- wrong sign, and wrong by twice the amount in any net.
        //
        // It also explains a finding that should have looked suspicious on its
        // face: "zero of 20,818 acquisitions were purchases". Purchases made
        // this way were in the data all along, filed under the wrong heading.
        const selfPay = raw.Account === r.wallet && raw.Destination === r.wallet;
        const dir = directionOf(raw, r.wallet);
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
        const dest = raw.Destination || '';
        // The counterparty, and the single most diagnostic field here. A token
        // arriving from ONE address on a 24-hour cadence is a scheduled
        // distribution -- a reward, ordinary income at FMV on receipt. The
        // same token arriving from many addresses at random is something else.
        // Measured on a real cache: nine of the top fourteen assets arrive on
        // a median gap of exactly 24.0 hours, up to 99% of gaps clustered
        // there. That is not a purchase pattern and it is not spam.
        const src = raw.Account || '';
        // Routes are assigned AFTER the scan, not here: whether a destination
        // is a burn sink or a counterparty depends on transactions that may
        // not have been read yet.
        rows.push({ chain, wallet: r.wallet, timestamp: r.timestamp, type: raw.TransactionType,
                    role: leg.role, dir, selfPay, currency: leg.currency, issuer: leg.issuer,
                    qty: leg.qty, source: src, destination: dest,
                    disposal: '', acquisition: '' });
      }
    }
  }

  // Now that every counterparty and issuer is known, label the movements.
  // A wallet of ours is never treated as a token issuer: WinDB writes a
  // holder address into that field often enough to matter, and the issuer
  // rules are what decide burn-versus-deposit.
  for (const w of ownWallets) issuers.delete(w);
  const ctx = { inboundFrom, issuers, ownWallets };
  for (const row of rows) {
    const c = classifyRoutes(row, ctx);
    row.disposal = c.disposal;
    row.acquisition = c.acquisition;
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
  const tickerCount = new Map();
  for (const a of assets) tickerCount.set(a.currency, (tickerCount.get(a.currency) || 0) + 1);
  const dupTickers = new Set([...tickerCount].filter(([, n]) => n > 1).map(([c]) => c));
  const rpad = (s, n) => String(s).padStart(n);
  // Widths measured against the real run: a 40-char hex currency code and an
  // 11-figure quantity both overran and collided with the next column, which
  // is how "ShibaNFT XRPL 23711,471,732,749" ends up on screen.
  console.log(pad('Asset', 16) + pad('Chain', 7) + rpad('Txs', 6) + rpad('Received', 22) +
              rpad('Sent', 22) + '  Years');
  console.log('-'.repeat(96));
  for (const a of assets) {
    const q = (v) => v ? v.toLocaleString(undefined, { maximumFractionDigits: 6 }) : '—';
    console.log(pad(a.currency, 16) + pad(a.chain, 7) + rpad(a.n, 6) +
                rpad(q(a.qtyIn), 22) + rpad(q(a.qtyOut), 22) + '  ' +
                [...a.years].sort().join(', '));
    // Same ticker, different issuer, is a DIFFERENT ASSET. Three "LUC" rows
    // are not a duplicate-row bug; saying so stops them being ignored as one.
    if (dupTickers.has(a.currency)) {
      console.log(pad('', 16) + `issuer ${a.issuer.slice(0, 20)}…  (same ticker, different issuer)`);
    }
    if (a.noQty) {
      console.log(pad('', 29) + `${a.noQty} row(s) carry no quantity`);
    }
  }

  // The split that decides whether a loss is usable at all.
  const disposals = rows.filter(r => r.disposal);
  if (disposals.length) {
    const route = new Map();
    for (const r of disposals) route.set(r.disposal, (route.get(r.disposal) || 0) + 1);
    console.log('');
    console.log('HOW THE DISPOSALS LEFT — this decides whether a loss is deductible');
    console.log('-'.repeat(78));
    for (const [k, v] of [...route].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(v).padStart(5)}  ${k}`);
    }
    console.log('');
    console.log('  A SALE (including a DEX sale for a trivial amount) is a capital loss on');
    console.log('  Schedule D. A BURN is a section 165 abandonment loss, which is a');
    console.log('  miscellaneous itemized deduction -- disallowed by section 67(g), which');
    console.log('  OBBBA made PERMANENT. Same economics, and only one of them counts.');
    console.log('');
    console.log('  A ROUND-TRIP is NEITHER. If the destination has ever paid this wallet,');
    console.log('  it is a counterparty, not a sink -- typically a liquidity pool, a stake');
    console.log('  or a loan. Sending a token to the issuer of a DIFFERENT token is how an');
    console.log('  LP position is opened and how the receipt token is minted back to you.');
    console.log('  Those are section 1001 exchanges, analysed like an AMM deposit; calling');
    console.log('  one an abandonment reaches the opposite answer.');
    console.log('');
    console.log('  Either way a loss needs BASIS: a token airdropped free, with no income');
    console.log('  ever recognised on it, has none, and produces no loss however it leaves.');
  }

  // Arrival cadence, because it answers the question that decides the tax
  // treatment: was this bought, or was it paid to you?
  const arrivals = new Map();
  for (const r of rows) {
    if (r.dir !== 'in') continue;
    const k = r.chain + '|' + r.currency;
    if (!arrivals.has(k)) arrivals.set(k, { currency: r.currency, times: [], senders: new Set() });
    const e = arrivals.get(k);
    e.times.push(Date.parse(String(r.timestamp).slice(0, 19).replace(' ', 'T') + 'Z'));
    e.senders.add(r.source);
  }
  const scheduled = [];
  for (const e of arrivals.values()) {
    if (e.times.length < 20) continue;
    const t2 = e.times.slice().sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < t2.length; i++) gaps.push(t2[i] - t2[i - 1]);
    const sorted = gaps.slice().sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    if (!med) continue;
    const near = gaps.filter(g => g >= 0.5 * med && g <= 1.5 * med).length / gaps.length;
    if (near > 0.6) scheduled.push({ currency: e.currency, n: e.times.length,
                                     hours: med / 3600000, near, senders: e.senders.size });
  }
  if (scheduled.length) {
    scheduled.sort((a, b) => b.n - a.n);
    console.log('');
    console.log('ARRIVING ON A SCHEDULE — these look like REWARDS, not purchases');
    console.log('-'.repeat(78));
    for (const s of scheduled.slice(0, 20)) {
      console.log(`  ${s.currency.slice(0, 14).padEnd(15)}${String(s.n).padStart(6)} receipts, ` +
                  `every ${s.hours.toFixed(1)}h (${(s.near * 100).toFixed(0)}% regular), ` +
                  `${s.senders} sender(s)`);
    }
    if (scheduled.length > 20) console.log(`  ...and ${scheduled.length - 20} more.`);
    console.log('');
    console.log('  A token paid to you on a fixed cadence is a reward or distribution, and a');
    console.log('  reward is ORDINARY INCOME at fair market value on the date you received it');
    console.log('  -- not a purchase, and not a tax-free airdrop. That income also becomes');
    console.log('  your BASIS, so the later disposal produces a real gain or loss rather than');
    console.log('  a zero-basis one. Both halves have to be reported, or neither is coherent.');
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
    const lines = ['Chain,Wallet,Timestamp,Type,Role,Direction,Asset,Issuer,Quantity,Source,Destination,Disposal Route,Acquisition Route',
      ...rows.map(r => [r.chain, r.wallet, r.timestamp, r.type, r.role, r.dir,
                        r.currency, r.issuer, r.qty == null ? '' : r.qty,
                        r.source, r.destination, r.disposal, r.acquisition].map(cell).join(','))];
    fs.writeFileSync(args.csv, lines.join('\n'));
    console.log('');
    console.log(`Wrote ${rows.length.toLocaleString()} row(s) to ${args.csv}`);
    console.log('NOTE: that file contains wallet addresses. It is gitignored; keep it local.');
  }

  db.close();
}

if (require.main === module) main();

module.exports = { decodeCurrency, nonNativeLegs, BOOKED, parseArgs, openCache,
                   directionOf, classifyRoutes };
