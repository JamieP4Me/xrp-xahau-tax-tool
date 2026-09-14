// test/curated-fetch.spec.js — the widened ("curated") WinDB fetch, and the
// explicit list of what it brings in that the tax engine still will not book.
//
// WHY THIS FILE EXISTS
//
// For most of this tool's life the WinDB fetch filtered to
// `TransactionType IN ('Payment','OfferCreate')` on both chains. Everything
// else was invisible — not excluded on a judgement call, just never asked
// for. Independent reconciliation against the ledger measured the damage:
// 1,179 XRPL transactions worth 81,385 XRP were missing across five wallets,
// 94% of that value in the AMM family alone.
//
// The fix was NOT "fetch everything". The same measurement on Xahau found
// 183,450 missing transactions worth 234 XAH — 99.99% dust, mostly URIToken
// traffic. Widening without discrimination would have added millions of rows
// to buy a rounding error. So the fetch is curated: types are on the list
// because they were measured to carry value.
//
// The second half of this file guards something more important than the
// first. Fetching a type does not mean the engine knows how to tax it, and
// several of these types carry NO amount in any WinDB column — the figure
// exists only in ledger metadata. The dangerous failure mode is a new row
// arriving, falling through every branch, and being booked at zero or not at
// all while the totals look complete. These tests assert the opposite: an
// unbookable transaction is recorded with a NULL amount and surfaced as an
// explicit "not on Form 8949" list. Silence becomes a list.
//
// Run headless-safe with: xvfb-run -a npx playwright test test/curated-fetch.spec.js

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_DIR = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(APP_DIR, 'renderer/index.html'), 'utf8');

// Synthetic, base58-valid, and deliberately not anyone's. Never put a real
// address in a test — this repo is public and the wallet list is personal data.
const W_XRPL  = 'rTESTwa11etXRPL1111111111111111111';
const W_XAHAU = 'rTESTwa11etXAHAU111111111111111111';
const OTHER   = 'rTESTcounterparty11111111111111111';

let app, window, userDataDir;

test.beforeAll(async () => {
  // Isolated HOME *and* --user-data-dir: HOME alone is not enough on Linux,
  // where Electron prefers XDG_CONFIG_HOME, which CI runners set.
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrp-xahau-curated-'));
  app = await electron.launch({
    args: [APP_DIR, '--user-data-dir=' + path.join(userDataDir, 'electron-profile')],
    cwd: APP_DIR,
    env: { ...process.env, HOME: userDataDir },
  });
  window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  // Let the startup scope check and silent cache rebuild finish before any
  // test touches the ledger. These tests call resetLedgerState() and the row
  // processors directly, and doing that underneath an in-flight build is the
  // same corruption two concurrent builds cause — with the added twist that
  // it leaves a promise pending, which hangs Playwright's worker teardown
  // rather than failing a test.
  await window.waitForFunction(() => typeof _ledgerBuildInFlight !== 'undefined' && _ledgerBuildInFlight === null,
    null, { timeout: 30000 });
});

test.afterAll(async () => {
  if (app) await app.close();
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

// ── The fetch list itself ──────────────────────────────────────────────────

test('the types measured to carry value are all fetched', async () => {
  const { xrpl, xahau } = await window.evaluate(() => ({
    xrpl: FETCH_TYPES_XRPL, xahau: FETCH_TYPES_XAHAU,
  }));
  // The three types that account for 98.3% of the 81,385 missing XRP.
  for (const t of ['AMMDeposit', 'AMMWithdraw', 'NFTokenAcceptOffer']) {
    expect(xrpl, `${t} is most of the missing XRPL value`).toContain(t);
  }
  // Value-bearing on Xahau, and low volume.
  for (const t of ['Remit', 'Import']) {
    expect(xahau, `${t} moves real value on Xahau`).toContain(t);
  }
  // The original two must survive any future edit to these lists — dropping
  // one would silently empty Form 8949.
  for (const list of [xrpl, xahau]) {
    expect(list).toContain('Payment');
    expect(list).toContain('OfferCreate');
  }
});

test('the high-volume no-value types stay OUT of the fetch', async () => {
  const { xrpl, xahau } = await window.evaluate(() => ({
    xrpl: FETCH_TYPES_XRPL, xahau: FETCH_TYPES_XAHAU,
  }));
  // Measured: 155,998 URIToken transactions carrying 2.26 XAH in total.
  // Adding these would multiply the cache for a rounding error.
  for (const t of ['URITokenMint', 'URITokenCreateSellOffer', 'URITokenCancelSellOffer']) {
    expect(xahau, `${t} is 99.99% dust`).not.toContain(t);
  }
  // No value by construction: an Invoke calls a hook, it does not move XAH.
  expect(xahau, 'Invoke carries no value').not.toContain('Invoke');
  // URITokenBuy was on the list for exactly one real fetch. Measured across
  // these wallets: 749,529 of them, not one with a recoverable amount. It grew
  // the Xahau cache by about a third and buried the ~270 rows that matter.
  expect(xahau, 'URITokenBuy was measured at 749,529 rows and zero amounts').not.toContain('URITokenBuy');
  for (const t of ['TrustSet', 'OfferCancel', 'AccountSet', 'SetRegularKey',
                   'NFTokenMint', 'NFTokenCreateOffer', 'NFTokenCancelOffer']) {
    expect(xrpl.concat(xahau), `${t} moves nothing`).not.toContain(t);
  }
});

test('the inbound lists only contain types that HAVE a Destination', async () => {
  // The inbound pass matches on Destination. A type without one can never be
  // found that way, so listing it there would be a silent no-op that reads
  // like coverage.
  const { inX, inH, outX, outH } = await window.evaluate(() => ({
    inX: FETCH_TYPES_IN_XRPL, inH: FETCH_TYPES_IN_XAHAU,
    outX: FETCH_TYPES_XRPL, outH: FETCH_TYPES_XAHAU,
  }));
  const HAS_DESTINATION = new Set([
    'Payment', 'CheckCash', 'EscrowCreate', 'PaymentChannelCreate', 'Remit',
  ]);
  for (const t of inX) expect(HAS_DESTINATION.has(t), `${t} has no Destination field`).toBe(true);
  for (const t of inH) expect(HAS_DESTINATION.has(t), `${t} has no Destination field`).toBe(true);
  // An inbound type must also be fetched outbound, or the two passes disagree
  // about what exists.
  for (const t of inX) expect(outX).toContain(t);
  for (const t of inH) expect(outH).toContain(t);
});

test('every WinDB type filter is built from the lists, not hardcoded', async () => {
  // This is the regression that started all of it: the filter was a literal
  // `IN ('Payment','OfferCreate')` written out four times. Four copies is how
  // a list gets widened in three places and left behind in the fourth.
  const code = HTML.split('\n').filter(l => !l.trim().startsWith('//'));
  const hardcoded = code.filter(l => /IN\s*\(\s*'(Payment|OfferCreate)'/.test(l));
  expect(hardcoded, 'a literal type list is back in the SQL').toEqual([]);
  // Exactly four query sites: outbound and inbound, on each chain.
  const viaHelper = code.filter(l => /IN\s*\(\$\{sqlTypeList\(/.test(l));
  expect(viaHelper).toHaveLength(4);
});

test('sqlTypeList quotes every type', async () => {
  const out = await window.evaluate(() => sqlTypeList(['Payment', 'Remit']));
  expect(out).toBe("'Payment','Remit'");
});

// ── Reading a column the query never asked for ─────────────────────────────
//
// This project has now shipped that bug twice. First TakerPays_*, read by the
// Xahau DEX acquisition branches and absent from the SELECT, which left every
// DEX-acquired asset with no cost-basis lot and reported its eventual sale as
// 100% short-term gain. Then Asset_currency and win_Import_MintedXAH, read by
// derivableAmount() and absent from both SELECTs, so every AMMDeposit and
// Import reported "no amount" while the amount sat in the table.
//
// Neither fails loudly. `row.Asset_currency` on a row that was never asked for
// the column is just undefined, which reads as "this row has no value" — the
// most expensive possible way to be wrong quietly.

test('every column derivableAmount reads is actually fetched, on both chains', async () => {
  // Read the columns out of the function's own source rather than a
  // hand-maintained list. A new `row.X` added to derivableAmount without a
  // matching column in the query fails here, with no second list to remember.
  const reads = await window.evaluate(() =>
    [...new Set([...derivableAmount.toString().matchAll(/row\.([A-Za-z0-9_]+)/g)].map(m => m[1]))]);
  expect(reads.length).toBeGreaterThan(3);

  // TransactionType is the dispatch key, always selected.
  const needed = reads.filter(c => c !== 'TransactionType');
  // Columns every query already carries for the booked types.
  const COMMON = new Set(['Amount_XRP', 'Amount_value', 'Amount_currency', 'Amount_issuer',
    'delivered_amount_XRP', 'delivered_amount_value', 'delivered_amount_currency']);
  const extra = await window.evaluate(() => DERIVED_AMOUNT_COLS);

  for (const col of needed) {
    expect(COMMON.has(col) || extra.includes(col),
      `derivableAmount reads row.${col}, which is in neither the common columns nor DERIVED_AMOUNT_COLS`).toBe(true);
  }

  // And the shared list must actually reach both queries. Spliced, not
  // retyped: two copies is how the XRPL one gets updated and the Xahau one
  // does not.
  const splices = HTML.split('\n').filter(l => l.includes('...DERIVED_AMOUNT_COLS'));
  expect(splices, 'both the Xahau and XRPL column lists must splice in the shared list').toHaveLength(2);
});

test('DERIVED_AMOUNT_COLS carries nothing the function does not read', async () => {
  // The list is filtered against the live WinDB schema, so a stale name is
  // silently dropped rather than erroring — which makes dead entries
  // invisible. Keeping it honest is the only way it stays meaningful.
  const unused = await window.evaluate(() => {
    const src = derivableAmount.toString();
    return DERIVED_AMOUNT_COLS.filter(c => !src.includes(c));
  });
  expect(unused, 'columns fetched for a reader that does not exist').toEqual([]);
});

// ── Fetched but not booked ─────────────────────────────────────────────────

test('only the two types the engine actually books are treated as valued', async () => {
  const valued = await window.evaluate(() => [...VALUED_TYPES]);
  expect(valued.sort()).toEqual(['OfferCreate', 'Payment']);
});

test('every fetched type is either booked or has a stated reason', async () => {
  // No type may arrive in the cache and then be unexplained on screen. The
  // user is owed a reason, not a blank cell.
  const missing = await window.evaluate(() =>
    [...new Set([...FETCH_TYPES_XRPL, ...FETCH_TYPES_XAHAU])]
      .filter(t => !VALUED_TYPES.has(t) && !UNVALUED_REASON[t]));
  expect(missing, 'fetched types with no explanation').toEqual([]);
});

test('derivableAmount returns null only where the real rows genuinely have no amount', async () => {
  // Verified by dumping every populated column of real cached rows:
  // NFTokenAcceptOffer rows carry four columns and no amount at all (the
  // price is in the offer), and Remit carries only Flags. Returning 0 here
  // would print "0 XRP moved" — actively wrong rather than merely absent.
  const got = await window.evaluate(() => ({
    nft:       derivableAmount({ TransactionType: 'NFTokenAcceptOffer', Amount_XRP: '12' }),
    escrowFin: derivableAmount({ TransactionType: 'EscrowFinish', Amount_XRP: '9' }),
    remit:     derivableAmount({ TransactionType: 'Remit', Flags: '2147483648' }),
  }));
  expect(got.nft).toBeNull();
  expect(got.escrowFin).toBeNull();
  expect(got.remit).toBeNull();
});

test('AMMWithdraw DOES carry an amount — the earlier claim that it did not was wrong', async () => {
  // Documented for two versions as "amount is only in ledger metadata", on
  // the strength of a schema-level probe. The actual rows carry Amount_XRP,
  // one of them 23,537 XRP. This test exists so that claim cannot come back.
  const amt = await window.evaluate(() =>
    derivableAmount({ TransactionType: 'AMMWithdraw', Amount_XRP: '23537.805263' }));
  expect(amt).toBeCloseTo(23537.805263, 6);
});

test('a native AMMDeposit is valued even though Asset_currency is empty', async () => {
  // The regression that cost a full re-sync. WinDB leaves the currency blank
  // for native XRP rather than writing "XRP", so a guard requiring
  // Asset_currency === 'XRP' rejected every row it was meant to admit. The
  // real rows look exactly like this one: five columns, no Asset_currency.
  const got = await window.evaluate(() => ({
    real:      derivableAmount({ TransactionType: 'AMMDeposit', Amount_XRP: '992.165079' }),
    blankCcy:  derivableAmount({ TransactionType: 'AMMDeposit', Asset_currency: '', Amount_XRP: '47.714093' }),
  }));
  expect(got.real).toBeCloseTo(992.165079, 6);
  expect(got.blankCcy).toBeCloseTo(47.714093, 6);
});

test('an IOU-denominated row yields no amount, because Amount_XRP is how native is signalled', async () => {
  // The real EscrowCreate rows are token escrows: Amount_value +
  // Amount_currency (hex) + Amount_issuer, and no Amount_XRP. Reading the
  // token quantity as XRP would price 3,615 USDT0 at the XRP rate.
  const amt = await window.evaluate(() => derivableAmount({
    TransactionType: 'EscrowCreate',
    Amount_value: '3615',
    Amount_currency: '5553445430000000000000000000000000000000',
    Amount_issuer: 'rUNuVgEcbL5Po5RKGnq8DP1KukY6RkTSyz',
  }));
  expect(amt).toBeNull();
});

// ── Remit's nested payload ────────────────────────────────────────────────
//
// For two versions the engine reported `Remit | 173 | 0 with amount`, and the
// stated reason — "amounts are in a nested field" — was read as "the data is
// not here". It was here. A verbatim dump of the stored JSON showed all 174
// rows carrying a real array; what hid it was a probe that printed
// String(value), which renders both a live array and a dead
// "[object Object]" string identically.
//
// These fixtures are copied from that dump, not from the XLS-55d spec.

test('remitLegs reads the keys the cache actually uses, not the XRPL ones', async () => {
  const got = await window.evaluate(() => remitLegs(
    [{ XRP: 0, token_value: 999.997655, token_issuer: 'rTESTissuerXAHAU11111111111111111', token_currency: 'LXH' }]));
  expect(got.native).toBe(0);
  expect(got.tokens).toHaveLength(1);
  expect(got.tokens[0].currency).toBe('LXH');
  expect(got.tokens[0].qty).toBeCloseTo(999.997655, 6);
});

test('remitLegs sums EVERY entry — 36 real rows carry more than one', async () => {
  // 234 entries across 174 rows. Reading Amounts[0] drops 60 legs silently,
  // which is the failure mode this whole file exists to prevent.
  const got = await window.evaluate(() => remitLegs([
    { XRP: 606.5, token_value: 0, token_issuer: '', token_currency: '' },
    { XRP: 400.25, token_value: 0, token_issuer: '', token_currency: '' },
    { XRP: 0, token_value: 42.5, token_issuer: 'rTESTissuerXAHAU11111111111111111', token_currency: 'XXX' },
  ]));
  expect(got.native).toBeCloseTo(1006.75, 6);
  expect(got.tokens).toHaveLength(1);
});

test('a Remit token leg NEVER reaches derivableAmount', async () => {
  // derivableAmount's result is priced as XAH downstream. Returning a token
  // quantity here would report 999.997655 LXH as 999.997655 XAH — the same
  // mistake as the four amount bugs already fixed, in a new place.
  const got = await window.evaluate(() => derivableAmount({
    TransactionType: 'Remit',
    Amounts: [{ XRP: 0, token_value: 999.997655, token_issuer: 'rTESTissuerXAHAU11111111111111111', token_currency: 'LXH' }],
  }));
  expect(got, 'a token-only Remit moved no XAH, so there is no native amount to report').toBeNull();
});

test('a Remit native leg DOES reach derivableAmount, summed across entries', async () => {
  const got = await window.evaluate(() => derivableAmount({
    TransactionType: 'Remit',
    Amounts: [
      { XRP: 606.5, token_value: 0, token_issuer: '', token_currency: '' },
      { XRP: 400.25, token_value: 0, token_issuer: '', token_currency: '' },
    ],
  }));
  expect(got).toBeCloseTo(1006.75, 6);
});

test('a Remit from a pre-v1.9.0 cache row does not throw or invent an amount', async () => {
  const got = await window.evaluate(() => ({
    missing: derivableAmount({ TransactionType: 'Remit' }),
    nulled:  derivableAmount({ TransactionType: 'Remit', Amounts: null }),
    corpse:  derivableAmount({ TransactionType: 'Remit', Amounts: '[object Object]' }),
    empty:   derivableAmount({ TransactionType: 'Remit', Amounts: [] }),
  }));
  expect(got.missing).toBeNull();
  expect(got.nulled).toBeNull();
  expect(got.corpse, 'the stringified corpse must not become a phantom amount').toBeNull();
  expect(got.empty).toBeNull();
});

test('the Amounts column is actually fetched on the Xahau query, and asked for once', async () => {
  // 'Amounts' is named in the documented Xahau list AND arrives via
  // DERIVED_AMOUNT_COLS. Both are wanted; asking twice is not.
  // HTML is already read once at the top of this file.
  expect(HTML.includes("'Amounts',"), 'the Xahau column list must still document it').toBe(true);
  const deduped = await window.evaluate(() => DERIVED_AMOUNT_COLS.includes('Amounts'));
  expect(deduped, 'derivableAmount reads row.Amounts, so the shared list must carry it').toBe(true);
});

test('derivableAmount reads the right column for the types that do have one', async () => {
  const got = await window.evaluate(() => ({
    escrowCreate:  derivableAmount({ TransactionType: 'EscrowCreate', Amount_XRP: '40' }),
    channelCreate: derivableAmount({ TransactionType: 'PaymentChannelCreate', Amount_XRP: '11' }),
    checkCash:     derivableAmount({ TransactionType: 'CheckCash', delivered_amount_XRP: '7.25' }),
    importMint:    derivableAmount({ TransactionType: 'Import', win_Import_MintedXAH: '3.5' }),
    importEmpty:   derivableAmount({ TransactionType: 'Import' }),
  }));
  expect(got.escrowCreate).toBeCloseTo(40, 6);
  expect(got.channelCreate).toBeCloseTo(11, 6);
  expect(got.checkCash).toBeCloseTo(7.25, 6);
  expect(got.importMint).toBeCloseTo(3.5, 6);
  // The one real Import row has the column fetched and empty — genuinely
  // absent, not unfetched.
  expect(got.importEmpty).toBeNull();
});

test('an amount that is shown is never silently booked as a disposal', async () => {
  // Showing a figure and reporting it as a taxable sale are different acts.
  // AMMWithdraw now has an amount; it still must not reach Form 8949 until
  // the AMM treatment is a deliberate, switchable decision.
  const out = await window.evaluate((wallet) => {
    resetLedgerState();
    const before = allDisposalsHigh.length;
    processOneXRPLRow(
      { TransactionType: 'AMMWithdraw', TransactionResult: 'tesSUCCESS',
        Account: wallet, Destination: '', Timestamp: '2024-06-27 10:18:51',
        Amount_XRP: '23537.805263' },
      wallet, new Set([wallet]), 'out', { xrpBasisRate: 0.25 });
    return { qty: unvaluedRows[0].qty, booked: allDisposalsHigh.length - before,
             reason: unvaluedRows[0].reason };
  }, W_XRPL);
  expect(out.qty).toBeCloseTo(23537.805263, 6);
  expect(out.booked, 'a visible amount is not a booked disposal').toBe(0);
  // And the measurement travels with the number. Not "may differ" — 45 of 68
  // were measured to differ, in a known direction, so the reason says which
  // way and how the real figures can be obtained.
  expect(out.reason).toMatch(/REQUESTED/);
  expect(out.reason).toMatch(/MORE/);
  expect(out.reason).toMatch(/floor/);
  expect(out.reason).toMatch(/verify-xrpl\.js --amm/);
  // The figure quoted must be the corrected one. "45 of 68" was the count
  // produced by a summary bug that filed 21 uncomparable rows as differences.
  expect(out.reason, 'the superseded miscount must not reappear').not.toMatch(/45 of 68/);
  expect(out.reason, 'superseded: those 11 rows were never compared').not.toMatch(/18 of 29/);
  // Every withdrawal that could be compared was understated. A reason that
  // implies some were right invites treating the number as the figure.
  expect(out.reason).toMatch(/18 of 18/);
});

test('an empty amount column stays null, and is never booked at zero', async () => {
  // The single most important assertion in this file. Before the curated
  // fetch this row did not exist at all; the risk in making it exist is that
  // it quietly becomes a $0 disposal. An EMPTY Amount_XRP — not an absent
  // one — is the case that most invites a defaulted zero.
  const out = await window.evaluate((wallet) => {
    resetLedgerState();
    const before = allDisposalsHigh.length;
    processOneXRPLRow(
      { TransactionType: 'AMMWithdraw', TransactionResult: 'tesSUCCESS',
        Account: wallet, Destination: '', Timestamp: '2025-03-04 10:00:00',
        Amount_XRP: '' },
      wallet, new Set([wallet]), 'out',
      { xrpBasisRate: 0.25 });
    return {
      unvalued: unvaluedRows.map(r => ({ type: r.type, qty: r.qty, chain: r.chain, year: r.year, reason: r.reason })),
      newDisposals: allDisposalsHigh.length - before,
    };
  }, W_XRPL);

  expect(out.unvalued).toHaveLength(1);
  expect(out.unvalued[0].type).toBe('AMMWithdraw');
  expect(out.unvalued[0].chain).toBe('XRPL');
  expect(out.unvalued[0].year).toBe(2025);
  // null, not 0, not undefined.
  expect(out.unvalued[0].qty).toBeNull();
  // Every unvalued row carries a reason, whether or not it has a number.
  expect(out.unvalued[0].reason).toBeTruthy();
  // And it must not have become a disposal on the strength of a blank column.
  expect(out.newDisposals, 'an unvalued type was booked on Form 8949').toBe(0);
});

test('a Remit on Xahau is recorded unvalued rather than silently dropped', async () => {
  const out = await window.evaluate((args) => {
    resetLedgerState();
    const before = allDisposalsHigh.length;
    processOneXahauRow(
      { TransactionType: 'Remit', TransactionResult: 'tesSUCCESS',
        Account: args.other, Destination: args.wallet,
        Timestamp: '2025-06-11 08:30:00' },
      args.wallet, new Set([args.wallet]), 'in', makeXahauPriceHelpers());
    return {
      unvalued: unvaluedRows.map(r => ({ type: r.type, chain: r.chain, qty: r.qty })),
      newDisposals: allDisposalsHigh.length - before,
    };
  }, { wallet: W_XAHAU, other: OTHER });

  expect(out.unvalued).toHaveLength(1);
  expect(out.unvalued[0].type).toBe('Remit');
  expect(out.unvalued[0].chain).toBe('Xahau');
  expect(out.unvalued[0].qty).toBeNull();
  expect(out.newDisposals).toBe(0);
});

test('an AMMDeposit with a native leg keeps its amount', async () => {
  const qty = await window.evaluate((wallet) => {
    resetLedgerState();
    processOneXRPLRow(
      { TransactionType: 'AMMDeposit', TransactionResult: 'tesSUCCESS',
        Account: wallet, Destination: '', Timestamp: '2025-02-02 12:00:00',
        Asset_currency: 'XRP', Amount_XRP: '2500' },
      wallet, new Set([wallet]), 'out', { xrpBasisRate: 0.25 });
    return unvaluedRows.length === 1 ? unvaluedRows[0].qty : 'wrong count: ' + unvaluedRows.length;
  }, W_XRPL);
  expect(qty).toBeCloseTo(2500, 6);
});

test('Payment and OfferCreate never appear in the unvalued list', async () => {
  // They are booked, so listing them would tell the user their own reported
  // sales are missing from their own report.
  const n = await window.evaluate((args) => {
    resetLedgerState();
    processOneXRPLRow(
      { TransactionType: 'Payment', TransactionResult: 'tesSUCCESS',
        Account: args.wallet, Destination: args.other,
        Timestamp: '2025-04-01 09:00:00', Amount_XRP: '100' },
      args.wallet, new Set([args.wallet]), 'out', { xrpBasisRate: 0.25 });
    return unvaluedRows.length;
  }, { wallet: W_XRPL, other: OTHER });
  expect(n).toBe(0);
});

test('a failed transaction is not recorded as unvalued', async () => {
  // It never happened. Listing it would invite the preparer to research a
  // transaction that moved nothing.
  const n = await window.evaluate((wallet) => {
    resetLedgerState();
    processOneXRPLRow(
      { TransactionType: 'AMMWithdraw', TransactionResult: 'tecUNFUNDED',
        Account: wallet, Destination: '', Timestamp: '2025-03-04 10:00:00' },
      wallet, new Set([wallet]), 'out', { xrpBasisRate: 0.25 });
    return unvaluedRows.length;
  }, W_XRPL);
  expect(n).toBe(0);
});

test('a transaction involving neither side of this wallet is not recorded', async () => {
  const n = await window.evaluate((args) => {
    resetLedgerState();
    processOneXRPLRow(
      { TransactionType: 'AMMWithdraw', TransactionResult: 'tesSUCCESS',
        Account: args.other, Destination: args.other,
        Timestamp: '2025-03-04 10:00:00' },
      args.wallet, new Set([args.wallet]), 'out', { xrpBasisRate: 0.25 });
    return unvaluedRows.length;
  }, { wallet: W_XRPL, other: OTHER });
  expect(n).toBe(0);
});

test('rebuilding clears the list instead of doubling it', async () => {
  // walletFlowStats and myVolumeByMonth both had exactly this bug. A list
  // that accumulates across rebuilds shows the user twice the problem they
  // have, which is its own kind of wrong number.
  const counts = await window.evaluate((wallet) => {
    const run = () => {
      resetLedgerState();
      processOneXRPLRow(
        { TransactionType: 'AMMWithdraw', TransactionResult: 'tesSUCCESS',
          Account: wallet, Destination: '', Timestamp: '2025-03-04 10:00:00' },
        wallet, new Set([wallet]), 'out', { xrpBasisRate: 0.25 });
      return unvaluedRows.length;
    };
    return [run(), run(), run()];
  }, W_XRPL);
  expect(counts).toEqual([1, 1, 1]);
});

test('a cached row whose type is no longer fetched is read past, not listed', async () => {
  // Narrowing the fetch must take effect without wiping the cache. Before
  // this, dropping URITokenBuy left 749,529 already-cached rows still being
  // processed and still filling the "not on Form 8949" list.
  const out = await window.evaluate((args) => {
    resetLedgerState();
    const scannedBefore = transactionsScanned;
    processOneXahauRow(
      { TransactionType: 'URITokenBuy', TransactionResult: 'tesSUCCESS',
        Account: args.other, Destination: args.wallet,
        Timestamp: '2025-05-05 05:05:05' },
      args.wallet, new Set([args.wallet]), 'in', makeXahauPriceHelpers());
    return {
      unvalued: unvaluedRows.length,
      stale: rowsSkippedStaleType,
      scanned: transactionsScanned - scannedBefore,
      html: dataQualityHTML(),
    };
  }, { wallet: W_XAHAU, other: OTHER });

  expect(out.unvalued, 'a type we no longer fetch must not fill the list').toBe(0);
  expect(out.stale).toBe(1);
  // Not counted as scanned either — it is not part of this scope's history.
  expect(out.scanned).toBe(0);
  // But never silent. Being read past without being told is how this whole
  // class of problem started.
  expect(out.html).toContain('read past');
});

test('a stale-type row is skipped on XRPL too, and the counter resets per build', async () => {
  const counts = await window.evaluate((wallet) => {
    const run = () => {
      resetLedgerState();
      processOneXRPLRow(
        { TransactionType: 'TrustSet', TransactionResult: 'tesSUCCESS',
          Account: wallet, Destination: '', Timestamp: '2025-05-05 05:05:05' },
        wallet, new Set([wallet]), 'out', { xrpBasisRate: 0.25 });
      return rowsSkippedStaleType;
    };
    return [run(), run(), run()];
  }, W_XRPL);
  expect(counts, 'the counter must not accumulate across rebuilds').toEqual([1, 1, 1]);
});

test('every booked type is in its chain fetch set, or the build drops its own data', async () => {
  // The build-side filter is now authoritative. If Payment or OfferCreate ever
  // fell out of a fetch list, this filter would silently empty Form 8949 —
  // a far worse failure than the one it was added to fix.
  const ok = await window.evaluate(() =>
    [...VALUED_TYPES].every(t => FETCH_TYPE_SET.XRPL.has(t) && FETCH_TYPE_SET.Xahau.has(t)));
  expect(ok).toBe(true);
  // And the sets must be built from the lists, not typed out again.
  const same = await window.evaluate(() => ({
    x: FETCH_TYPES_XRPL.every(t => FETCH_TYPE_SET.XRPL.has(t)) && FETCH_TYPE_SET.XRPL.size === new Set(FETCH_TYPES_XRPL).size,
    h: FETCH_TYPES_XAHAU.every(t => FETCH_TYPE_SET.Xahau.has(t)) && FETCH_TYPE_SET.Xahau.size === new Set(FETCH_TYPES_XAHAU).size,
  }));
  expect(same).toEqual({ x: true, h: true });
});

// ── Surfacing it ───────────────────────────────────────────────────────────

test('the disclosure box appears only when there is something to disclose', async () => {
  const empty = await window.evaluate(() => { resetLedgerState(); return dataQualityHTML(); });
  expect(empty).not.toContain('NOT on Form 8949');

  const filled = await window.evaluate((wallet) => {
    resetLedgerState();
    processOneXRPLRow(
      { TransactionType: 'AMMWithdraw', TransactionResult: 'tesSUCCESS',
        Account: wallet, Destination: '', Timestamp: '2025-03-04 10:00:00' },
      wallet, new Set([wallet]), 'out', { xrpBasisRate: 0.25 });
    return dataQualityHTML();
  }, W_XRPL);
  expect(filled).toContain('NOT on Form 8949');
  expect(filled).toContain('AMMWithdraw');
  expect(filled).toContain('exportUnvaluedCSV()');
});

test('the CSV export exists and is covered by the privacy gate', async () => {
  expect(await window.evaluate(() => typeof exportUnvaluedCSV)).toBe('function');
  // It carries wallet addresses, counterparties and tx hashes, so it must
  // never be committable. Both the gate and .gitignore, because either one
  // alone has been enough to let an export through before.
  const gate = fs.readFileSync(path.join(APP_DIR, 'scripts/verify-clean.js'), 'utf8');
  expect(gate).toContain('Unvalued-Transactions');
  const ignore = fs.readFileSync(path.join(APP_DIR, '.gitignore'), 'utf8');
  expect(ignore).toContain('Unvalued-Transactions-*.csv');
});

test('the CSV leaves the amount blank rather than zero when it is unknown', async () => {
  // Reading this file in Excel, a 0 in the Amount column is a factual claim
  // that nothing moved. An empty cell is the truth: we do not know yet.
  const line = await window.evaluate((wallet) => {
    resetLedgerState();
    processOneXRPLRow(
      { TransactionType: 'AMMWithdraw', TransactionResult: 'tesSUCCESS',
        Account: wallet, Destination: '', Timestamp: '2025-03-04 10:00:00' },
      wallet, new Set([wallet]), 'out', { xrpBasisRate: 0.25 });
    // Capture what downloadCSV would have been handed, without downloading.
    let captured = null;
    const real = window.downloadCSV;
    window.downloadCSV = (lines) => { captured = lines; };
    try { exportUnvaluedCSV(); } finally { window.downloadCSV = real; }
    return captured;
  }, W_XRPL);

  expect(line[0]).toContain('Why not on Form 8949');
  expect(line).toHaveLength(2);
  const cells = line[1].split(',');
  // Date, Year, Chain, Type, Amount, Ticker, …
  expect(cells[2]).toBe('XRPL');
  expect(cells[3]).toBe('AMMWithdraw');
  expect(cells[4], 'unknown amount must be blank, not 0').toBe('');
  expect(cells[5], 'no ticker without an amount').toBe('');
});

// ── Making the widened fetch actually reach an existing cache ──────────────
//
// Everything above is worthless if the new types never arrive. The sync
// cursor says how far forward a wallet is synced and nothing says what was
// asked for, so an upgraded app would re-fetch nothing, find no AMM rows in a
// cache that was never allowed to hold any, and report "nothing is missing".

test('the fingerprint changes when the type lists change, and not otherwise', async () => {
  const out = await window.evaluate(() => {
    const a = fetchScopeFingerprint();
    const b = fetchScopeFingerprint();
    // Order within a list must not matter — a reordered list is the same
    // question, and re-syncing every wallet over a cosmetic edit is a cost
    // with no benefit.
    const saved = FETCH_TYPES_XRPL.slice();
    FETCH_TYPES_XRPL.reverse();
    const reordered = fetchScopeFingerprint();
    FETCH_TYPES_XRPL.length = 0; FETCH_TYPES_XRPL.push(...saved, 'SomeNewType');
    const widened = fetchScopeFingerprint();
    FETCH_TYPES_XRPL.length = 0; FETCH_TYPES_XRPL.push(...saved);
    return { a, b, reordered, widened, restored: fetchScopeFingerprint() };
  });
  expect(out.a).toBe(out.b);
  expect(out.reordered, 'reordering is not a scope change').toBe(out.a);
  expect(out.widened, 'adding a type must change the fingerprint').not.toBe(out.a);
  expect(out.restored).toBe(out.a);
});

test('the narrow scope every old cache was built with does NOT match today', async () => {
  // The precise upgrade this guard exists for.
  const narrow = await window.evaluate(() =>
    [['OfferCreate', 'Payment'], ['Payment'], ['OfferCreate', 'Payment'], ['Payment']]
      .map(l => l.join(',')).join('|'));
  const current = await window.evaluate(() => fetchScopeFingerprint());
  expect(current).not.toBe(narrow);
});

test('adding a fetched COLUMN invalidates the cache, not just a type', async () => {
  // A row cached without a column does not grow one on re-read. AMMDeposit
  // rows fetched without Asset_currency are permanently amountless until
  // they are pulled again, so a column change has to drop the cursors too.
  const out = await window.evaluate(() => {
    const before = fetchScopeFingerprint();
    DERIVED_AMOUNT_COLS.push('Asset2_currency');
    const after = fetchScopeFingerprint();
    DERIVED_AMOUNT_COLS.pop();
    return { before, after, restored: fetchScopeFingerprint() };
  });
  expect(out.after).not.toBe(out.before);
  expect(out.restored).toBe(out.before);
});

test('a cache with rows and no fingerprint is treated as stale and its cursors dropped', async () => {
  const out = await window.evaluate(async () => {
    const calls = [];
    try {
      await checkFetchScope({
        getMeta: async () => null,                       // pre-v1.3.0 cache
        setMeta: async (k, v) => { calls.push(['set', k, v]); },
        getStats: async () => ({ totalRows: 126886 }),   // and it has data
        forceFullResync: async () => { calls.push(['resync']); },
      });
      return { calls, stale: fetchScopeStale, html: dataQualityHTML() };
    } finally { fetchScopeStale = false; }
  });
  expect(out.calls).toContainEqual(['resync']);
  // Crucially NOT stamped here: a user who quits before fetching must be
  // warned again next time.
  expect(out.calls.filter(c => c[0] === 'set'), 'the scope must not be stamped before a fetch runs').toEqual([]);
  expect(out.stale).toBe(true);
  expect(out.html).toContain('built before this version widened what it asks for');
});

test('a genuinely first run is not treated as stale', async () => {
  const out = await window.evaluate(async () => {
    const calls = [];
    try {
      await checkFetchScope({
        getMeta: async () => null,
        setMeta: async (k, v) => { calls.push(['set', k, v]); },
        getStats: async () => ({ totalRows: 0 }),        // empty cache
        forceFullResync: async () => { calls.push(['resync']); },
      });
      return { calls, stale: fetchScopeStale, html: dataQualityHTML() };
    } finally { fetchScopeStale = false; }
  });
  expect(out.calls.filter(c => c[0] === 'resync'), 'nothing to re-sync on an empty cache').toEqual([]);
  expect(out.calls[0][0]).toBe('set');
  expect(out.stale).toBe(false);
  expect(out.html).not.toContain('built before this version widened');
});

test('a cache already on the current scope is left completely alone', async () => {
  const out = await window.evaluate(async () => {
    const calls = [];
    try {
      await checkFetchScope({
        getMeta: async () => fetchScopeFingerprint(),
        setMeta: async (k, v) => { calls.push(['set', k, v]); },
        getStats: async () => { calls.push(['stats']); return { totalRows: 5 }; },
        forceFullResync: async () => { calls.push(['resync']); },
      });
      return { calls, stale: fetchScopeStale };
    } finally { fetchScopeStale = false; }
  });
  // Not even a stats query: a matching scope must cost nothing at startup.
  expect(out.calls).toEqual([]);
  expect(out.stale).toBe(false);
});

test('a failure in the scope check does not stop the app or fake a clean result', async () => {
  const out = await window.evaluate(async () => {
    try {
      await checkFetchScope({
        getMeta: async () => { throw new Error('database is locked'); },
        setMeta: async () => {},
        getStats: async () => ({ totalRows: 1 }),
        forceFullResync: async () => { throw new Error('should not be reached'); },
      });
      return { stale: fetchScopeStale, ok: true };   // must not throw
    } catch (e) {
      return { ok: false, err: String(e) };
    } finally { fetchScopeStale = false; }
  });
  expect(out.ok, 'checkFetchScope must never throw into startup').toBe(true);
  // Leaving cursors untouched is the old behaviour, which is where the user
  // already was — not a new failure mode.
  expect(out.stale).toBe(false);
});

test('stampFetchScope records exactly the current fingerprint and clears the warning', async () => {
  const out = await window.evaluate(async () => {
    let stored = null;
    const store = {
      getMeta: async () => stored,
      setMeta: async (k, v) => { stored = v; },
      getStats: async () => ({ totalRows: 1 }),
      forceFullResync: async () => {},
    };
    try {
      fetchScopeStale = true;
      await stampFetchScope(store);
      const after = { stored, stale: fetchScopeStale };
      // And a second startup now sees a matching scope.
      await checkFetchScope(store);
      return { ...after, staleOnRestart: fetchScopeStale, expected: fetchScopeFingerprint() };
    } finally { fetchScopeStale = false; }
  });
  expect(out.stored).toBe(out.expected);
  expect(out.stale).toBe(false);
  expect(out.staleOnRestart).toBe(false);
});

test('dropping a type or column is a narrowing: no re-sync, no warning', async () => {
  // The rule that makes cleanup affordable. Asset_currency turned out to be
  // useless — empty on every native AMMDeposit — but under an all-or-nothing
  // fingerprint, deleting it would have cost a second multi-hour re-sync of
  // 6.3 million rows. A correctness guard that punishes corrections stops
  // being used.
  const out = await window.evaluate(async () => {
    const calls = [];
    // A stored scope that is a strict SUPERSET of today's.
    const wider = fetchScopeParts()
      .map((l, i) => [...l].sort().concat(i === 4 ? ['Asset_currency'] : []).sort().join(','))
      .join('|');
    try {
      await checkFetchScope({
        getMeta: async () => wider,
        setMeta: async (k, v) => { calls.push(['set', v]); },
        getStats: async () => ({ totalRows: 6332416 }),
        forceFullResync: async () => { calls.push(['resync']); },
      });
      return { calls, stale: fetchScopeStale, html: dataQualityHTML() };
    } finally { fetchScopeStale = false; fetchScopeAdded = []; }
  });

  expect(out.calls.filter(c => c[0] === 'resync'), 'a narrowing must never re-sync').toEqual([]);
  // The new, narrower scope is recorded so it is not re-evaluated every launch.
  expect(out.calls.find(c => c[0] === 'set')[1]).toBe(await window.evaluate(() => fetchScopeFingerprint()));
  expect(out.stale).toBe(false);
  expect(out.html).not.toContain('built before this version');
});

test('adding anything is a widening: re-sync, and the warning names what was added', async () => {
  const out = await window.evaluate(async () => {
    const calls = [];
    // A stored scope missing one column and one type.
    const narrower = fetchScopeParts()
      .map((l, i) => {
        const keep = [...l].sort();
        if (i === 4) return keep.filter(c => c !== 'win_Import_MintedXAH').join(',');
        if (i === 0) return keep.filter(c => c !== 'AMMWithdraw').join(',');
        return keep.join(',');
      }).join('|');
    try {
      await checkFetchScope({
        getMeta: async () => narrower,
        setMeta: async (k, v) => { calls.push(['set', v]); },
        getStats: async () => ({ totalRows: 100 }),
        forceFullResync: async () => { calls.push(['resync']); },
      });
      return { calls, stale: fetchScopeStale, added: [...fetchScopeAdded], html: dataQualityHTML() };
    } finally { fetchScopeStale = false; fetchScopeAdded = []; }
  });

  expect(out.calls).toContainEqual(['resync']);
  expect(out.calls.filter(c => c[0] === 'set'), 'not stamped until a fetch runs').toEqual([]);
  expect(out.stale).toBe(true);
  expect(out.added.sort()).toEqual(['AMMWithdraw', 'win_Import_MintedXAH']);
  // Naming it is what lets someone judge whether the fetch is worth its cost.
  expect(out.html).toContain('AMMWithdraw');
  expect(out.html).toContain('win_Import_MintedXAH');
});

test('a type moving between the outbound and inbound list counts as a widening', async () => {
  // The lists are compared position by position, not pooled. A type that is
  // fetched outbound but newly added inbound really does find rows the old
  // scope could not, so it is not a no-op.
  const added = await window.evaluate(() => {
    const parts = fetchScopeParts().map(l => [...l].sort().join(','));
    // Pretend the inbound XRPL list did not have CheckCash before.
    parts[1] = [...FETCH_TYPES_IN_XRPL].filter(t => t !== 'CheckCash').sort().join(',');
    return fetchScopeAdditions(parts.join('|'));
  });
  expect(added).toEqual(['CheckCash']);
});

test('an unreadable stored scope is treated as a widening, never as agreement', async () => {
  // Failing open here would mean silently deciding no fetch is needed, which
  // is the exact failure this whole mechanism exists to prevent.
  const out = await window.evaluate(() => ({
    missing: fetchScopeAdditions(null),
    garbage: (fetchScopeAdditions('not-a-scope') || []).length,
  }));
  expect(out.missing, 'no stored scope means we cannot prove it is current').toBeNull();
  expect(out.garbage, 'an unparseable scope must look like it is missing everything').toBeGreaterThan(0);
});

test('the stale warning names the measured cost, not a vague caveat', async () => {
  const html = await window.evaluate(() => {
    resetLedgerState();
    fetchScopeStale = true;
    const h = dataQualityHTML();
    fetchScopeStale = false;
    return h;
  });
  // A warning the user cannot size is a warning they will dismiss.
  expect(html).toContain('81,385 XRP');
  expect(html).toContain('Run a fetch');
  expect(html).toMatch(/nothing\s+cached was deleted/);
});

// ── Answering "why has this no amount?" from data, not from a hypothesis ───
//
// AMMDeposit reported no amount. The hypothesis was "the column is not
// fetched." The columns were added, the whole cache was re-pulled over several
// hours, and AMMDeposit still reported no amount. The hypothesis was wrong and
// it cost a full re-sync to find that out.
//
// These cover the diagnostic that replaces guessing: a few real rows are kept
// per unvalued type, so the next such question is answered from what is
// already in the cache — free, instant, no Payment-Claim — instead of from a
// theory that needs hours of fetching to test.

test('a row with no derivable amount is sampled, one with an amount is not', async () => {
  const out = await window.evaluate((wallet) => {
    resetLedgerState();
    // No amount anywhere — this is the one worth keeping.
    processOneXRPLRow(
      { TransactionType: 'AMMWithdraw', TransactionResult: 'tesSUCCESS',
        Account: wallet, Destination: '', Timestamp: '2025-03-04 10:00:00' },
      wallet, new Set([wallet]), 'out', { xrpBasisRate: 0.25 });
    // Amount known — nothing to diagnose, so it is not sampled.
    processOneXRPLRow(
      { TransactionType: 'PaymentChannelCreate', TransactionResult: 'tesSUCCESS',
        Account: wallet, Destination: '', Timestamp: '2025-03-05 10:00:00',
        Amount_XRP: '11' },
      wallet, new Set([wallet]), 'out', { xrpBasisRate: 0.25 });
    return Object.keys(unvaluedSamples);
  }, W_XRPL);
  expect(out).toEqual(['AMMWithdraw']);
});

test('a sample keeps only populated columns, and drops zeros and NUL padding', async () => {
  // WinDB returns TransactionHash as 64 NUL bytes on these types. Printing
  // that as a value sends the reader chasing a hash that does not exist.
  const sample = await window.evaluate((wallet) => {
    resetLedgerState();
    processOneXRPLRow(
      { TransactionType: 'AMMDeposit', TransactionResult: 'tesSUCCESS',
        Account: wallet, Destination: '', Timestamp: '2025-03-04 10:00:00',
        Asset_currency: 'XRP', Amount_XRP: '0', Amount_value: '',
        TakerGets_XRP: '0.000', TransactionHash: String.fromCharCode(0).repeat(64),
        Flags: '1048576' },
      wallet, new Set([wallet]), 'out', { xrpBasisRate: 0.25 });
    return unvaluedSamples.AMMDeposit[0];
  }, W_XRPL);

  expect(sample.Asset_currency).toBe('XRP');
  expect(sample.Flags).toBe('1048576');
  expect(Object.keys(sample), 'a zero is not a value').not.toContain('Amount_XRP');
  expect(Object.keys(sample), 'a zero is not a value').not.toContain('TakerGets_XRP');
  expect(Object.keys(sample), 'an empty string is not a value').not.toContain('Amount_value');
  expect(Object.keys(sample), '64 NUL bytes is not a hash').not.toContain('TransactionHash');
});

test('sampling is capped per type, so 39 rows do not become 39 screens', async () => {
  const n = await window.evaluate((wallet) => {
    resetLedgerState();
    for (let i = 0; i < 40; i++) {
      processOneXRPLRow(
        { TransactionType: 'AMMDeposit', TransactionResult: 'tesSUCCESS',
          Account: wallet, Destination: '',
          Timestamp: `2025-03-04 10:00:${String(i).padStart(2, '0')}`,
          Asset_currency: 'XRP' },
        wallet, new Set([wallet]), 'out', { xrpBasisRate: 0.25 });
    }
    return { samples: unvaluedSamples.AMMDeposit.length, rows: unvaluedRows.length };
  }, W_XRPL);
  expect(n.samples).toBe(3);
  expect(n.rows, 'every row is still counted; only the samples are capped').toBe(40);
});

test('samples clear with the rows they belong to', async () => {
  const counts = await window.evaluate((wallet) => {
    const run = () => {
      resetLedgerState();
      processOneXRPLRow(
        { TransactionType: 'AMMWithdraw', TransactionResult: 'tesSUCCESS',
          Account: wallet, Destination: '', Timestamp: '2025-03-04 10:00:00' },
        wallet, new Set([wallet]), 'out', { xrpBasisRate: 0.25 });
      return unvaluedSamples.AMMWithdraw.length;
    };
    return [run(), run(), run()];
  }, W_XRPL);
  expect(counts, 'stale samples would describe a previous build').toEqual([1, 1, 1]);
});

test('the diagnostic runs with no Payment-Claim and distinguishes empty from absent', async () => {
  const lines = await window.evaluate((wallet) => {
    resetLedgerState();
    processOneXRPLRow(
      { TransactionType: 'AMMDeposit', TransactionResult: 'tesSUCCESS',
        Account: wallet, Destination: '', Timestamp: '2025-03-04 10:00:00',
        Asset_currency: 'USD', Amount_XRP: '0' },
      wallet, new Set([wallet]), 'out', { xrpBasisRate: 0.25 });

    const el = document.getElementById('logSetup');
    el.innerHTML = '';
    inspectUnvaluedRows();          // no claim, no network
    return el.textContent;
  }, W_XRPL);

  expect(lines).toContain('AMMDeposit');
  // The distinction the whole diagnostic exists to draw: a column that arrived
  // and is empty, versus one that was never asked for.
  expect(lines).toContain('IS present: USD');
  expect(lines).toMatch(/Amount_XRP EMPTY or absent/);
});


// ── The reporting year the screen claims vs the one the figures are for ───
//
// Three year dropdowns took their initial value from the HTML alone, and only
// one of them carried `selected`. The other two fell back to their first
// option — 2026 — and nothing reconciled them until a FETCH completed. A
// cache rebuild, which is what happens at every launch, did not. So the Form
// 8949 tab read "2026 (in progress)" above 2025 figures.
//
// The numbers were right and the heading above them was wrong, which on a tax
// form is the more dangerous half to get wrong.

test('all three year selectors agree at startup, with the data year', async () => {
  const out = await window.evaluate(() => ({
    values: [...document.querySelectorAll('.taxYearSelect')].map(el => el.value),
    ids: [...document.querySelectorAll('.taxYearSelect')].map(el => el.id),
    taxYear: taxYear(),
    dflt: DEFAULT_TAX_YEAR,
  }));
  expect(out.ids.length, 'Setup, Form 8949 and Schedule D').toBe(3);
  expect(new Set(out.values).size, `selectors disagree: ${JSON.stringify(out.ids)} = ${JSON.stringify(out.values)}`).toBe(1);
  expect(Number(out.values[0])).toBe(out.dflt);
  // And the value the engine filters by is the value on screen.
  expect(out.taxYear).toBe(out.dflt);
});

test('the three selectors offer exactly the same years', async () => {
  // Divergent option lists are how they drifted in the first place: one had
  // `selected`, the others did not, and nobody noticed because the lists
  // otherwise looked identical.
  const lists = await window.evaluate(() =>
    [...document.querySelectorAll('.taxYearSelect')].map(el =>
      [...el.options].map(o => o.value).join(',')));
  expect(new Set(lists).size, `option lists differ: ${JSON.stringify(lists)}`).toBe(1);
});

test('no selector hardcodes a default in HTML — DEFAULT_TAX_YEAR is the source', async () => {
  // A `selected` attribute on one of three is exactly the bug. If a default
  // belongs anywhere it belongs in one place, applied to all three.
  const marked = HTML.match(/<option[^>]*\sselected[^>]*>/gi) || [];
  expect(marked, 'a year option is hardcoded as selected again').toEqual([]);
});

test('a rebuild re-asserts the year rather than letting the labels drift', async () => {
  const out = await window.evaluate(async () => {
    // Drive one selector out of agreement the way a stale HTML default did.
    document.getElementById('taxYear_form8949').value = '2026';
    const before = [...document.querySelectorAll('.taxYearSelect')].map(el => el.value);
    syncTaxYearSelects();
    const after = [...document.querySelectorAll('.taxYearSelect')].map(el => el.value);
    return { before, after, taxYear: taxYear() };
  });
  expect(new Set(out.before).size, 'precondition: they were out of sync').toBeGreaterThan(1);
  expect(new Set(out.after).size, 'the rebuild must bring them back into agreement').toBe(1);
  expect(Number(out.after[0])).toBe(out.taxYear);
});

test('taxYear() survives a missing selector instead of returning NaN', async () => {
  // parseInt(undefined) is NaN, and a NaN year silently filters every row out
  // of Form 8949 — an empty return that looks like a quiet year.
  const got = await window.evaluate(() => {
    const el = document.getElementById('taxYear');
    const parent = el.parentNode, next = el.nextSibling;
    el.remove();
    const y = taxYear();
    parent.insertBefore(el, next);
    return y;
  });
  expect(Number.isFinite(got)).toBe(true);
  expect(got).toBe(await window.evaluate(() => DEFAULT_TAX_YEAR));
});


// ── Basis that silently went to zero ──────────────────────────────────────
//
// When FIFO runs out of lots it falls back to $0 basis and a null acquisition
// date. That is not a neutral default: it reports 100% of proceeds as gain, at
// short-term rates, regardless of what the coins cost or how long they were
// held. It used to happen silently.
//
// The real case: an AMMWithdraw returned 24,101 XRP to a wallet, the engine
// does not book AMMWithdraw, so no lot was created. A later transfer of 10,000
// XRP to a Coinbase address found an empty ledger and produced four lots
// totalling 10,010 XRP at zero basis — about $4,800 of basis lost, and the
// holding period reset to short-term on coins held since 2020.

test('a FIFO shortfall is recorded, not just silently zeroed', async () => {
  const out = await window.evaluate((wallet) => {
    resetLedgerState();
    // A ledger with nothing in it, asked for 100 units.
    const consumed = ledgerFIFODetailed(wallet, 'XRP', 100);
    return { consumed, shortfalls: basisShortfalls.map(b => ({ ...b })) };
  }, W_XRPL);

  expect(out.consumed).toHaveLength(1);
  expect(out.consumed[0].unitCost, 'the fallback still books zero').toBe(0);
  expect(out.consumed[0].acqDate).toBeNull();
  // ...but it is no longer invisible.
  expect(out.shortfalls).toHaveLength(1);
  expect(out.shortfalls[0].ticker).toBe('XRP');
  expect(out.shortfalls[0].qty).toBeCloseTo(100, 6);
});

test('only the UNCOVERED remainder is reported as missing basis', async () => {
  // A partial shortfall is the dangerous one — most of the disposal looks
  // fine, and the hole is the part nobody notices.
  const out = await window.evaluate((wallet) => {
    resetLedgerState();
    ledgerAdd(wallet, 'XRP', '2021-05-01', 40, 0.75, 'test');
    const consumed = ledgerFIFODetailed(wallet, 'XRP', 100);
    return { consumed, shortfall: basisShortfalls[0] };
  }, W_XRPL);

  expect(out.consumed).toHaveLength(2);
  expect(out.consumed[0].qty).toBeCloseTo(40, 6);
  expect(out.consumed[0].unitCost).toBeCloseTo(0.75, 6);
  expect(out.shortfall.qty, 'only the 60 with no lot behind it').toBeCloseTo(60, 6);
});

test('a fully covered disposal reports no shortfall', async () => {
  const n = await window.evaluate((wallet) => {
    resetLedgerState();
    ledgerAdd(wallet, 'XRP', '2021-05-01', 500, 0.75, 'test');
    ledgerFIFODetailed(wallet, 'XRP', 100);
    return basisShortfalls.length;
  }, W_XRPL);
  expect(n, 'a false alarm here would train the reader to ignore the real one').toBe(0);
});

test('shortfalls clear between builds', async () => {
  const counts = await window.evaluate((wallet) => {
    const run = () => {
      resetLedgerState();
      ledgerFIFODetailed(wallet, 'XRP', 100);
      return basisShortfalls.length;
    };
    return [run(), run(), run()];
  }, W_XRPL);
  expect(counts).toEqual([1, 1, 1]);
});

test('the panel names the quantity, the wallet and the dollar cost', async () => {
  const html = await window.evaluate((wallet) => {
    resetLedgerState();
    ledgerFIFODetailed(wallet, 'XRP', 9873.6705);
    return dataQualityHTML();
  }, W_XRPL);

  expect(html).toContain('ZERO cost basis');
  expect(html).toContain('9,873.6705');
  expect(html).toContain(W_XRPL);
  // The consequence, not just the fact — this is what makes it actionable.
  expect(html).toMatch(/short-term rates/);
  expect(html).toContain('AMMWithdraw');
});

test('no shortfalls means no scary panel', async () => {
  const html = await window.evaluate(() => { resetLedgerState(); return dataQualityHTML(); });
  expect(html).not.toContain('ZERO cost basis');
});

// ═══════════════════════════════════════════════════════════════════════════
// LEDGER-VERIFIED AMM AMOUNTS
//
// WinDB's Amount_XRP on an AMM row is the amount the transaction REQUESTED.
// That is not what moved. Measured against a full-history node across one
// wallet's entire AMM history: of 47 rows carrying both figures, 24 disagreed,
// and every comparable AMMWithdraw — 18 of 18 — was understated, by 1,583 XRP
// in total and by 563 XRP in the worst single case. Deposits move the other
// way, by fractions of an XRP: see the note on amountForRow().
//
// The delivered figure is |balance delta + fee| from the transaction's own
// ledger metadata, which WinDB does not carry at all. scripts/verify-xrpl.js
// --amm sweeps account_tx to produce it and writes a CSV; these tests cover
// the path from that CSV to a booked amount.
//
// The pairing key is (wallet, type, timestamp) and NOT the transaction hash,
// because WinDB returns TransactionHash as 64 NUL bytes on every AMM row.
// That fact already cost one full rewrite of the verifier, which paired on
// hash and matched 0 of 73 rows.

const AMM_CSV_HEAD = 'Wallet,Type,Timestamp,LedgerHash,SubmittedAmount,LedgerDelta,Difference,Flags,Note';

// Every test here leaves the module state as it found it. These are globals
// the real build populates, and a leaked counter would show up as an
// unexplained disclosure panel in a completely unrelated test.
async function resetAmmState() {
  await window.evaluate(() => {
    ammDeltas.clear();
    ammLedgerUsed = 0; ammLedgerMissing = 0; ammLedgerUplift = 0; ammNoXrpLeg = 0;
  });
}

test.describe('AMM ledger CSV import', () => {
  test.afterEach(resetAmmState);

  test('parses the verifier CSV and separates paired rows from unpaired ones', async () => {
    const out = await window.evaluate(([head, wallet]) => {
      const text = [head,
        `${wallet},AMMWithdraw,2025-01-01 00:00:00.1,ABC123,100,663.231417,563.231417,262144,`,
        `${wallet},AMMDeposit,2024-05-01 00:00:00.2,DEF456,992.165079,992.165079,0.000000,1048576,`,
        // The protocol ignores the amount field in some withdrawal modes, so
        // no requested figure exists and none was delivered to compare.
        `${wallet},AMMWithdraw,2025-02-01 00:00:00.3,,,,,131072,nothing submitted to compare`,
      ].join('\n');
      return parseAmmLedgerCSV(text);
    }, [AMM_CSV_HEAD, W_XRPL]);

    expect(out.errors).toEqual([]);
    expect(out.stats.total).toBe(3);
    expect(out.stats.withDelivered).toBe(2);
    expect(out.stats.unpaired).toBe(1);
    expect(out.rows[0].delivered).toBeCloseTo(663.231417, 6);
    expect(out.rows[0].submitted).toBeCloseTo(100, 6);
    expect(out.rows[0].ledger_hash).toBe('ABC123');
    expect(out.rows[2].delivered).toBeNull();
  });

  test('a file that is not the verifier output is refused with the command that makes one', async () => {
    // Failing vaguely here means someone imports their Form 8949 export,
    // nothing happens, and the AMM rows stay quietly on the wrong figure.
    const out = await window.evaluate(() =>
      parseAmmLedgerCSV('Date,Year,Chain,Type,Amount\n2025-01-01,2025,XRPL,Payment,5'));
    expect(out.rows).toEqual([]);
    expect(out.errors.join(' ')).toContain('--amm');
    expect(out.errors.join(' ')).toContain('verify-xrpl.js');
  });

  test('column order does not matter; columns are matched by name', async () => {
    const out = await window.evaluate((wallet) => parseAmmLedgerCSV([
      'Note,LedgerDelta,Type,Timestamp,Wallet,Flags,SubmittedAmount,LedgerHash,Difference',
      `,663.231417,AMMWithdraw,2025-01-01 00:00:00.1,${wallet},262144,100,ABC123,563.231417`,
    ].join('\n')), W_XRPL);
    expect(out.errors).toEqual([]);
    expect(out.rows[0].delivered).toBeCloseTo(663.231417, 6);
    expect(out.rows[0].wallet).toBe(W_XRPL);
  });

  test('a bad row is an error naming the line, never a silent skip', async () => {
    // A dropped row here does not fail loudly later. It just leaves that
    // transaction on the understated WinDB figure, which is the exact failure
    // this import exists to end.
    const out = await window.evaluate(([head, wallet]) => parseAmmLedgerCSV([head,
      `${wallet},Payment,2025-01-01 00:00:00,H,1,1,0,0,`,
      `,AMMWithdraw,2025-01-02 00:00:00,H,1,1,0,0,`,
      `${wallet},AMMWithdraw,,H,1,1,0,0,`,
      `${wallet},AMMWithdraw,2025-01-03 00:00:00,H,1,1,0,0,`,
    ].join('\n')), [AMM_CSV_HEAD, W_XRPL]);

    expect(out.rows).toHaveLength(1);
    expect(out.errors).toHaveLength(3);
    expect(out.errors[0]).toContain('Line 2');
    expect(out.errors[0]).toContain('not an AMM type');
    expect(out.errors[1]).toContain('Line 3');
    expect(out.errors[2]).toContain('Line 4');
  });

  test('a duplicated key is rejected rather than letting the last row win silently', async () => {
    const out = await window.evaluate(([head, wallet]) => parseAmmLedgerCSV([head,
      `${wallet},AMMWithdraw,2025-01-01 00:00:00,H,1,100,0,0,`,
      `${wallet},AMMWithdraw,2025-01-01 00:00:00,H,1,999,0,0,`,
    ].join('\n')), [AMM_CSV_HEAD, W_XRPL]);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].delivered).toBeCloseTo(100, 6);
    expect(out.errors[0]).toContain('duplicate');
  });
});

test.describe('using the imported amounts', () => {
  // `store` is an injectable parameter throughout, because contextBridge
  // objects are non-configurable and cannot be stubbed.
  test.afterEach(resetAmmState);

  test('the ledger figure wins over the WinDB figure, and the gap is counted', async () => {
    const out = await window.evaluate(async (wallet) => {
      await loadAmmDeltas({ getAmmLedger: async () => [
        { wallet, tx_type: 'AMMWithdraw', timestamp: '2025-01-01 00:00:00.1',
          ledger_hash: 'ABC123', submitted: 100, delivered: 663.231417, flags: 262144, note: '' },
      ] });
      const row = { TransactionType: 'AMMWithdraw', Timestamp: '2025-01-01 00:00:00.1', Amount_XRP: '100' };
      return {
        submitted: derivableAmount(row),
        booked: amountForRow(wallet, row),
        used: ammLedgerUsed, missing: ammLedgerMissing, uplift: ammLedgerUplift,
      };
    }, W_XRPL);

    expect(out.submitted, 'derivableAmount still reports what was requested').toBeCloseTo(100, 6);
    expect(out.booked, 'the engine books what was delivered').toBeCloseTo(663.231417, 6);
    expect(out.uplift, 'and the difference is what a preparer needs to see').toBeCloseTo(563.231417, 6);
    expect(out.used).toBe(1);
    expect(out.missing).toBe(0);
  });

  test('an AMM row with no imported figure stays on the WinDB number and is COUNTED', async () => {
    // Silently falling back is how a report ends up mixing two conventions
    // with nothing on screen saying so.
    const out = await window.evaluate(async (wallet) => {
      await loadAmmDeltas({ getAmmLedger: async () => [] });
      const row = { TransactionType: 'AMMWithdraw', Timestamp: '2025-01-01 00:00:00.1', Amount_XRP: '100' };
      return { booked: amountForRow(wallet, row), used: ammLedgerUsed, missing: ammLedgerMissing };
    }, W_XRPL);
    expect(out.booked).toBeCloseTo(100, 6);
    expect(out.used).toBe(0);
    expect(out.missing).toBe(1);
  });

  test('the key is wallet + type + timestamp: none of the three may be ignored', async () => {
    const out = await window.evaluate(async ([wallet, other]) => {
      await loadAmmDeltas({ getAmmLedger: async () => [
        { wallet, tx_type: 'AMMWithdraw', timestamp: '2025-01-01 00:00:00.1',
          ledger_hash: 'ABC', submitted: 100, delivered: 663, flags: 0, note: '' },
      ] });
      const base = { TransactionType: 'AMMWithdraw', Timestamp: '2025-01-01 00:00:00.1', Amount_XRP: '100' };
      return {
        exact:       amountForRow(wallet, base),
        otherWallet: amountForRow(other, base),
        otherType:   amountForRow(wallet, { ...base, TransactionType: 'AMMDeposit' }),
        otherTime:   amountForRow(wallet, { ...base, Timestamp: '2025-01-01 00:00:00.2' }),
      };
    }, [W_XRPL, OTHER]);

    expect(out.exact).toBeCloseTo(663, 6);
    // Each of these must fall back rather than borrow another transaction's
    // figure. Booking one withdrawal's amount against a different one is worse
    // than booking the understated figure.
    expect(out.otherWallet).toBeCloseTo(100, 6);
    expect(out.otherType).toBeCloseTo(100, 6);
    expect(out.otherTime).toBeCloseTo(100, 6);
  });

  test('a non-AMM type is never touched by any of this', async () => {
    const out = await window.evaluate(async (wallet) => {
      await loadAmmDeltas({ getAmmLedger: async () => [
        { wallet, tx_type: 'AMMWithdraw', timestamp: '2025-01-01 00:00:00.1',
          ledger_hash: 'ABC', submitted: 1, delivered: 999, flags: 0, note: '' },
      ] });
      const row = { TransactionType: 'EscrowCreate', Timestamp: '2025-01-01 00:00:00.1', Amount_XRP: '5' };
      return { booked: amountForRow(wallet, row), used: ammLedgerUsed, missing: ammLedgerMissing };
    }, W_XRPL);
    expect(out.booked).toBeCloseTo(5, 6);
    expect(out.used).toBe(0);
    expect(out.missing, 'not an AMM row, so not a missing AMM figure').toBe(0);
  });

  test('an imported row with no delivered figure does not override with zero', async () => {
    // Returning 0 here would read as "nothing moved", which is the one answer
    // that is actively wrong rather than merely absent.
    const out = await window.evaluate(async (wallet) => {
      await loadAmmDeltas({ getAmmLedger: async () => [
        { wallet, tx_type: 'AMMWithdraw', timestamp: '2025-01-01 00:00:00.1',
          ledger_hash: '', submitted: null, delivered: null, flags: 131072, note: 'unpaired' },
      ] });
      const row = { TransactionType: 'AMMWithdraw', Timestamp: '2025-01-01 00:00:00.1', Amount_XRP: '100' };
      return { booked: amountForRow(wallet, row), missing: ammLedgerMissing };
    }, W_XRPL);
    expect(out.booked).toBeCloseTo(100, 6);
    expect(out.missing).toBe(1);
  });

  test('a store with no AMM support at all is survivable, not an exception', async () => {
    const n = await window.evaluate(() => loadAmmDeltas({}));
    expect(n).toBe(0);
  });

  test('the import restores the real transaction hash the cache does not have', async () => {
    // WinDB returns 64 NUL bytes for an AMM hash, so these rows otherwise get
    // a synthetic "<timestamp>_<wallet>" id that no explorer can resolve — on
    // transactions that end up on a tax return.
    const out = await window.evaluate(async (wallet) => {
      resetLedgerState();
      await loadAmmDeltas({ getAmmLedger: async () => [
        { wallet, tx_type: 'AMMWithdraw', timestamp: '2025-01-01 00:00:00.1',
          ledger_hash: 'A1B2C3D4', submitted: 100, delivered: 663, flags: 262144, note: '' },
      ] });
      const nul = String.fromCharCode(0).repeat(64);
      processOneXRPLRow({ TransactionType: 'AMMWithdraw', Timestamp: '2025-01-01 00:00:00.1',
        TransactionHash: nul, Account: wallet, Destination: '', Amount_XRP: '100',
        TransactionResult: 'tesSUCCESS' }, wallet, new Set([wallet]), 'out',
        { xrpBasisRate: 0.5 });
      return unvaluedRows.map(r => ({ hash: r.hash, qty: r.qty, amountSrc: r.amountSrc, submitted: r.submitted }));
    }, W_XRPL);

    expect(out).toHaveLength(1);
    expect(out[0].hash, 'the real hash, not a synthetic id').toBe('A1B2C3D4');
    expect(out[0].qty).toBeCloseTo(663, 6);
    expect(out[0].amountSrc).toBe('ledger');
    expect(out[0].submitted).toBeCloseTo(100, 6);
  });
});

test.describe('AMM disclosure panel', () => {
  test.afterEach(resetAmmState);

  test('AMM rows valued from WinDB alone raise a warning naming the fix', async () => {
    const html = await window.evaluate(() => {
      resetLedgerState();
      ammLedgerMissing = 34;
      return dataQualityHTML();
    });
    expect(html).toContain('34');
    expect(html).toContain('requested');
    expect(html).toContain('--amm');
  });

  test('verified rows say so, and name the size of the correction', async () => {
    const html = await window.evaluate(() => {
      resetLedgerState();
      ammLedgerUsed = 29;
      ammLedgerMissing = 5;
      ammLedgerUplift = 1583.472978;
      return dataQualityHTML();
    });
    expect(html).toContain('29');
    expect(html).toContain('1,583.472978');
    // The unverified remainder must not disappear into the good news.
    expect(html).toMatch(/remain on the requested amount/);
  });

  test('no AMM activity means no AMM panel either way', async () => {
    const html = await window.evaluate(() => { resetLedgerState(); return dataQualityHTML(); });
    expect(html).not.toContain('valued from XRP Ledger metadata');
    expect(html).not.toContain('valued at the amount requested');
  });
});

test.describe('a measured zero is an answer, not a gap', () => {
  // Found by running the parser against the REAL verifier output rather than a
  // fixture: three AMMWithdraw rows carry a measured XRP delta of exactly zero.
  // They are tfOneAssetWithdrawAll withdrawals of the pool's OTHER asset. The
  // ledger was asked and answered; nothing is missing.
  //
  // The first version of this feature treated a zero as "no figure" and fell
  // through to the WinDB number. That is the wrong answer twice over: it
  // invents an XRP amount the ledger says did not move, and it hides the fact
  // that value left the pool in an asset this tool does not track at all.
  test.afterEach(resetAmmState);

  const ZERO_ROW = (wallet) => ({ getAmmLedger: async () => [
    { wallet, tx_type: 'AMMWithdraw', timestamp: '2025-08-27 22:56:01.819000025',
      ledger_hash: 'F00D', submitted: null, delivered: 0, flags: 262144,
      note: 'nothing submitted to compare' },
  ] });

  test('a zero delta books no amount and never falls back to the WinDB figure', async () => {
    const out = await window.evaluate(async (wallet) => {
      await loadAmmDeltas({ getAmmLedger: async () => [
        { wallet, tx_type: 'AMMWithdraw', timestamp: '2025-08-27 22:56:01.819000025',
          ledger_hash: 'F00D', submitted: null, delivered: 0, flags: 262144, note: '' },
      ] });
      // A WinDB figure IS present here, which is the case the fallback would
      // fire on. It must not.
      const row = { TransactionType: 'AMMWithdraw', Timestamp: '2025-08-27 22:56:01.819000025', Amount_XRP: '250' };
      return { booked: amountForRow(wallet, row), used: ammLedgerUsed, missing: ammLedgerMissing, noLeg: ammNoXrpLeg };
    }, W_XRPL);

    expect(out.booked, 'null, not 0 — 0 would be booked as a real quantity').toBeNull();
    expect(out.used, 'it WAS valued from the ledger').toBe(1);
    expect(out.missing, 'and it is not a missing figure').toBe(0);
    expect(out.noLeg).toBe(1);
  });

  test('the row says WHY it has no amount, naming the untracked asset', async () => {
    const out = await window.evaluate(async (wallet) => {
      resetLedgerState();
      await loadAmmDeltas({ getAmmLedger: async () => [
        { wallet, tx_type: 'AMMWithdraw', timestamp: '2025-08-27 22:56:01.819000025',
          ledger_hash: 'F00D', submitted: null, delivered: 0, flags: 262144, note: '' },
      ] });
      processOneXRPLRow({ TransactionType: 'AMMWithdraw', Timestamp: '2025-08-27 22:56:01.819000025',
        TransactionHash: '', Account: wallet, Destination: '', Amount_XRP: '',
        TransactionResult: 'tesSUCCESS' }, wallet, new Set([wallet]), 'out', { xrpBasisRate: 0.5 });
      return unvaluedRows.map(r => ({ qty: r.qty, amountSrc: r.amountSrc, reason: r.reason, hash: r.hash }));
    }, W_XRPL);

    expect(out).toHaveLength(1);
    expect(out[0].qty).toBeNull();
    expect(out[0].amountSrc, 'the ledger answered, so the source is the ledger').toBe('ledger');
    expect(out[0].reason).toMatch(/no XRP moved/);
    expect(out[0].reason).toMatch(/OTHER asset/);
    expect(out[0].hash).toBe('F00D');
  });

  test('the panel reports them separately from rows with no figure at all', async () => {
    // Folding these into "still on the requested amount" would tell the user to
    // go and fetch a figure that has already been fetched and is zero.
    const html = await window.evaluate(() => {
      resetLedgerState();
      ammLedgerUsed = 31; ammLedgerMissing = 5; ammLedgerUplift = 1583.47; ammNoXrpLeg = 3;
      return dataQualityHTML();
    });
    expect(html).toMatch(/3 withdrawal\(s\) moved no XRP at all/);
    expect(html).toMatch(/OTHER asset/);
    expect(html).toMatch(/not in any figure on this page/);
    // And the genuinely-missing ones still say so, separately.
    expect(html).toMatch(/remain on the requested amount/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AMM TAX TREATMENT
//
// There is no IRS guidance on liquidity pool deposits. Two positions are in
// general use and they put income in different years, so the tool cannot have
// an opinion by accident: the position is an explicit setting, it defaults to
// OFF, and it is named on every report produced under it.
//
// The tests below cover three things in order of importance:
//   1. The default books nothing. A software update must never adopt a tax
//      position on a taxpayer's behalf.
//   2. Treatment A never books from an unverified amount. A basis lot built on
//      WinDB's requested figure would be up to 563 XRP short and would look
//      exactly as settled on Form 8949 as a correct one.
//   3. It actually cures the zero-basis chain, which is the whole reason the
//      question came up.

async function setTreatment(value) {
  await window.evaluate((v) => { ammTreatment = v; }, value);
}

async function resetAmmBuild() {
  await window.evaluate(() => {
    resetLedgerState();
    ammDeltas.clear();
    ammLedgerUsed = 0; ammLedgerMissing = 0; ammLedgerUplift = 0; ammNoXrpLeg = 0;
    ammBookedDeposits = 0; ammBookedWithdrawals = 0; ammSkippedUnverified = 0;
    ammBookedDepositQty = 0; ammBookedWithdrawQty = 0;
    ammTreatment = AMM_TREATMENT_DEFAULT;
  });
}

// One AMM row as the cache holds it: no Destination, and a hash of NUL bytes.
function ammRowFor(wallet, type, ts, requested) {
  return {
    TransactionType: type, Timestamp: ts, TransactionResult: 'tesSUCCESS',
    TransactionHash: '', Account: wallet, Destination: '',
    Amount_XRP: requested == null ? '' : String(requested),
  };
}

test.describe('the treatment setting itself', () => {
  test.afterEach(resetAmmBuild);

  test('the default is to book nothing', async () => {
    // The single most important assertion in this file. Adopting a tax
    // position is the taxpayer's decision, made with whoever signs the return.
    // Shipping it on by default would make it a decision nobody made.
    const out = await window.evaluate(() => ({
      dflt: AMM_TREATMENT_DEFAULT,
      current: ammTreatment,
      options: Object.keys(AMM_TREATMENTS),
    }));
    expect(out.dflt).toBe('none');
    expect(out.current).toBe('none');
    expect(out.options).toContain('A');
  });

  test('an unrecognised stored value falls back to the default, not to whatever it is', async () => {
    // A typo in localStorage must never leave the app quietly booking a
    // position nobody chose.
    const out = await window.evaluate(() => {
      const before = ammTreatment;
      try { localStorage.setItem('ammTreatment', 'TreatmentQ'); } catch (e) {}
      loadAmmTreatment();
      const afterGarbage = ammTreatment;
      try { localStorage.setItem('ammTreatment', 'A'); } catch (e) {}
      loadAmmTreatment();
      const afterValid = ammTreatment;
      try { localStorage.removeItem('ammTreatment'); } catch (e) {}
      loadAmmTreatment();
      const afterMissing = ammTreatment;
      ammTreatment = before;
      return { afterGarbage, afterValid, afterMissing };
    });
    expect(out.afterGarbage).toBe('none');
    expect(out.afterValid, 'a valid stored value is still honoured').toBe('A');
    expect(out.afterMissing).toBe('none');
  });

  test('Treatment B is absent rather than offered and broken', async () => {
    // Not an oversight. Treatment B needs a deposit lot to hand back for every
    // withdrawal, and this taxpayer withdrew 2.84x what went in. Listing it
    // greyed out would imply it is a matter of effort.
    const opts = await window.evaluate(() => Object.keys(AMM_TREATMENTS));
    expect(opts).not.toContain('B');
  });
});

test.describe('Treatment A — what it books', () => {
  test.afterEach(resetAmmBuild);

  test('with the default setting, an AMM row is disclosed and NOT booked', async () => {
    const out = await window.evaluate((wallet) => {
      resetLedgerState();
      ammDeltas.set(ammDeltaKey(wallet, 'AMMWithdraw', '2025-01-01 00:00:00.1'),
        { delivered: 663.23, submitted: 100, hash: 'ABC', flags: 262144, note: '' });
      processOneXRPLRow({ TransactionType: 'AMMWithdraw', Timestamp: '2025-01-01 00:00:00.1',
        TransactionResult: 'tesSUCCESS', TransactionHash: '', Account: wallet, Destination: '',
        Amount_XRP: '100' }, wallet, new Set([wallet]), 'out', { xrpBasisRate: 0.5 });
      return {
        disposals: allDisposalsHigh.length,
        lots: (walletLedger[wallet] && walletLedger[wallet].XRP || []).length,
        disclosed: unvaluedRows.length,
        booked: ammBookedWithdrawals,
      };
    }, W_XRPL);

    expect(out.disposals).toBe(0);
    expect(out.lots).toBe(0);
    expect(out.disclosed, 'still on the not-on-8949 list').toBe(1);
    expect(out.booked).toBe(0);
  });

  test('a deposit becomes a disposal on Form 8949, consuming FIFO lots', async () => {
    const out = await window.evaluate((wallet) => {
      resetLedgerState();
      ammTreatment = 'A';
      // 1,000 XRP bought at $0.50 well before the deposit.
      ledgerAdd(wallet, 'XRP', '2021-05-01', 1000, 0.50, 'test');
      ammDeltas.set(ammDeltaKey(wallet, 'AMMDeposit', '2024-05-24 13:01:32.755'),
        { delivered: 992.165079, submitted: 992.165079, hash: 'DEP1', flags: 1048576, note: '' });
      processOneXRPLRow({ TransactionType: 'AMMDeposit', Timestamp: '2024-05-24 13:01:32.755',
        TransactionResult: 'tesSUCCESS', TransactionHash: '', Account: wallet, Destination: '',
        Amount_XRP: '992.165079' }, wallet, new Set([wallet]), 'out', { xrpBasisRate: 0.5 });
      const lots = walletLedger[wallet].XRP;
      return {
        rows: allDisposalsHigh.map(r => ({
          qty: r.qty, basis: r.basis, term: r.term, hash: r.txHash,
          desc: r.description, year: r.year, proceedsH: r.proceedsH,
        })),
        remaining: lots.reduce((a, l) => a + l.remaining, 0),
        booked: ammBookedDeposits,
        shortfalls: basisShortfalls.length,
      };
    }, W_XRPL);

    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].qty).toBeCloseTo(992.165079, 6);
    // Basis came from the real 2021 lot, so the holding period is long-term.
    // Money is rounded to the cent when the row is built, so the basis here
    // is 496.08 and not 992.165079 x 0.50 = 496.0825395. That is the point:
    // a fraction of a cent carried into column (e) is what made the printed
    // Part I, Part II and Schedule D totals disagree with their own rows.
    // See the `cents` note in pushDisposal().
    const expectedBasis = Math.round(992.165079 * 0.50 * 100) / 100;
    expect(out.rows[0].basis).toBeCloseTo(expectedBasis, 2);
    expect(out.rows[0].basis * 100, 'basis carried a fraction of a cent')
      .toBeCloseTo(Math.round(out.rows[0].basis * 100), 6);
    expect(out.rows[0].term).toBe('LT');
    expect(out.rows[0].year).toBe(2024);
    expect(out.rows[0].desc).toContain('deposited to AMM pool');
    expect(out.rows[0].hash, 'the real ledger hash, not a synthetic id').toBe('DEP1');
    expect(out.rows[0].proceedsH).toBeGreaterThan(0);
    expect(out.remaining).toBeCloseTo(1000 - 992.165079, 6);
    expect(out.booked).toBe(1);
    expect(out.shortfalls, 'the lot covered it, so nothing was zero-based').toBe(0);
  });

  test('a withdrawal becomes an acquisition lot at that day\'s price', async () => {
    const out = await window.evaluate((wallet) => {
      resetLedgerState();
      ammTreatment = 'A';
      ammDeltas.set(ammDeltaKey(wallet, 'AMMWithdraw', '2025-01-01 00:00:00.1'),
        { delivered: 663.231417, submitted: 100, hash: 'WD1', flags: 262144, note: '' });
      processOneXRPLRow({ TransactionType: 'AMMWithdraw', Timestamp: '2025-01-01 00:00:00.1',
        TransactionResult: 'tesSUCCESS', TransactionHash: '', Account: wallet, Destination: '',
        Amount_XRP: '100' }, wallet, new Set([wallet]), 'out', { xrpBasisRate: 0.5 });
      const lots = walletLedger[wallet].XRP || [];
      return {
        lots: lots.map(l => ({ qty: l.qty, date: l.date, unitCost: l.unitCost, source: l.source })),
        expectedPrice: lookupPrice(XRP_PRICES, 'XRP', '2025-01-01', 'high'),
        disposals: allDisposalsHigh.length,
        booked: ammBookedWithdrawals,
        qty: ammBookedWithdrawQty,
      };
    }, W_XRPL);

    expect(out.lots).toHaveLength(1);
    // The DELIVERED figure, not the 100 XRP the transaction requested.
    expect(out.lots[0].qty).toBeCloseTo(663.231417, 6);
    expect(out.lots[0].date).toBe('2025-01-01');
    expect(out.lots[0].unitCost).toBeCloseTo(out.expectedPrice, 8);
    expect(out.lots[0].source).toBe('amm_withdrawal');
    expect(out.disposals, 'an acquisition is not a disposal').toBe(0);
    expect(out.booked).toBe(1);
    expect(out.qty).toBeCloseTo(663.231417, 6);
  });

  test('a booked row LEAVES the not-on-Form-8949 list', async () => {
    // Reporting a transaction and also listing it as omitted would be a worse
    // disclosure than either alone.
    const out = await window.evaluate((wallet) => {
      resetLedgerState();
      ammTreatment = 'A';
      ammDeltas.set(ammDeltaKey(wallet, 'AMMWithdraw', '2025-01-01 00:00:00.1'),
        { delivered: 663.23, submitted: 100, hash: 'WD1', flags: 262144, note: '' });
      processOneXRPLRow({ TransactionType: 'AMMWithdraw', Timestamp: '2025-01-01 00:00:00.1',
        TransactionResult: 'tesSUCCESS', TransactionHash: '', Account: wallet, Destination: '',
        Amount_XRP: '100' }, wallet, new Set([wallet]), 'out', { xrpBasisRate: 0.5 });
      return { disclosed: unvaluedRows.length, booked: ammBookedWithdrawals };
    }, W_XRPL);
    expect(out.booked).toBe(1);
    expect(out.disclosed).toBe(0);
  });
});

test.describe('Treatment A — what it refuses to book', () => {
  test.afterEach(resetAmmBuild);

  test('an UNVERIFIED amount is never booked, and the refusal is counted', async () => {
    // The most consequential rule here. WinDB's figure is what the transaction
    // REQUESTED; every comparable withdrawal measured was short, by up to 563
    // XRP. A basis lot built on it would be wrong and would look exactly as
    // settled as a correct one. Skipping is visible; a wrong lot is not.
    const out = await window.evaluate((wallet) => {
      resetLedgerState();
      ammTreatment = 'A';
      // No entry in ammDeltas at all — nothing imported for this row.
      processOneXRPLRow({ TransactionType: 'AMMWithdraw', Timestamp: '2025-01-01 00:00:00.1',
        TransactionResult: 'tesSUCCESS', TransactionHash: '', Account: wallet, Destination: '',
        Amount_XRP: '100' }, wallet, new Set([wallet]), 'out', { xrpBasisRate: 0.5 });
      return {
        lots: (walletLedger[wallet] && walletLedger[wallet].XRP || []).length,
        booked: ammBookedWithdrawals,
        skipped: ammSkippedUnverified,
        disclosed: unvaluedRows.length,
      };
    }, W_XRPL);

    expect(out.lots, 'no basis lot from a requested figure').toBe(0);
    expect(out.booked).toBe(0);
    expect(out.skipped).toBe(1);
    expect(out.disclosed, 'and it stays on the disclosure list').toBe(1);
  });

  test('a withdrawal that moved no XRP creates no lot', async () => {
    // The pool's other asset changed hands. There is no XRP acquisition to
    // record, and a zero-quantity lot would be noise.
    const out = await window.evaluate((wallet) => {
      resetLedgerState();
      ammTreatment = 'A';
      ammDeltas.set(ammDeltaKey(wallet, 'AMMWithdraw', '2025-08-27 22:56:01.819'),
        { delivered: 0, submitted: null, hash: 'F00D', flags: 262144, note: '' });
      processOneXRPLRow({ TransactionType: 'AMMWithdraw', Timestamp: '2025-08-27 22:56:01.819',
        TransactionResult: 'tesSUCCESS', TransactionHash: '', Account: wallet, Destination: '',
        Amount_XRP: '' }, wallet, new Set([wallet]), 'out', { xrpBasisRate: 0.5 });
      return {
        lots: (walletLedger[wallet] && walletLedger[wallet].XRP || []).length,
        booked: ammBookedWithdrawals,
        noLeg: ammNoXrpLeg,
        reason: unvaluedRows.length ? unvaluedRows[0].reason : null,
      };
    }, W_XRPL);

    expect(out.lots).toBe(0);
    expect(out.booked).toBe(0);
    expect(out.noLeg).toBe(1);
    expect(out.reason, 'and it explains itself').toMatch(/OTHER asset/);
  });

  test('only the submitting account books it, so nothing is counted twice', async () => {
    // If the same transaction were processed from a second wallet's
    // perspective, the deposit would be disposed of twice and the proceeds
    // doubled on Form 8949.
    const out = await window.evaluate(([wallet, other]) => {
      resetLedgerState();
      ammTreatment = 'A';
      ammDeltas.set(ammDeltaKey(other, 'AMMDeposit', '2024-05-24 13:01:32.755'),
        { delivered: 992.17, submitted: 992.17, hash: 'DEP1', flags: 1048576, note: '' });
      // `other` submitted it; we are looking at it from `wallet`'s perspective.
      processOneXRPLRow({ TransactionType: 'AMMDeposit', Timestamp: '2024-05-24 13:01:32.755',
        TransactionResult: 'tesSUCCESS', TransactionHash: '', Account: other, Destination: '',
        Amount_XRP: '992.17' }, wallet, new Set([wallet, other]), 'out', { xrpBasisRate: 0.5 });
      return { disposals: allDisposalsHigh.length, booked: ammBookedDeposits };
    }, [W_XRPL, OTHER]);

    expect(out.disposals).toBe(0);
    expect(out.booked).toBe(0);
  });
});

test.describe('Treatment A cures the zero-basis chain', () => {
  // This is why the question came up at all.
  //
  // The real sequence: an AMMWithdraw returned 24,101 XRP to a wallet; the
  // engine did not book AMMWithdraw, so no lot was created; a later transfer
  // to a Coinbase address found an empty ledger and produced lots at ZERO
  // basis with a NULL acquisition date. On a sale that reports 100% of
  // proceeds as gain, and all of it short-term, because a null date fails
  // every long-term test.
  test.afterEach(resetAmmBuild);

  // Inlined into each test rather than shared through a helper: the two runs
  // differ only in the treatment, and seeing both sequences in full is the
  // point of the pair.
  const SEQUENCE = (wallet, treatment) => {
    resetLedgerState();
    ammTreatment = treatment;
    ammDeltas.set(ammDeltaKey(wallet, 'AMMWithdraw', '2024-06-27 10:18:00.5'),
      { delivered: 24101.03668, submitted: 24000, hash: 'WD24K', flags: 262144, note: '' });
    processOneXRPLRow({ TransactionType: 'AMMWithdraw', Timestamp: '2024-06-27 10:18:00.5',
      TransactionResult: 'tesSUCCESS', TransactionHash: '', Account: wallet, Destination: '',
      Amount_XRP: '24000' }, wallet, new Set([wallet]), 'out', { xrpBasisRate: 0.5 });
    const consumed = ledgerFIFODetailed(wallet, 'XRP', 10000);
    return {
      consumed: consumed.map(c => ({ qty: c.qty, unitCost: c.unitCost, acqDate: c.acqDate })),
      shortfalls: basisShortfalls.map(b => ({ ticker: b.ticker, qty: b.qty })),
      basis: consumed.reduce((a, c) => a + c.qty * c.unitCost, 0),
    };
  };

  test('WITHOUT a treatment, the disposal falls through to zero basis and a null date', async () => {
    const out = await window.evaluate(([wallet, src]) => {
      const run = new Function('return ' + src)();
      return run(wallet, 'none');
    }, [W_XRPL, SEQUENCE.toString()]);

    expect(out.consumed).toHaveLength(1);
    expect(out.consumed[0].unitCost, 'the defect').toBe(0);
    expect(out.consumed[0].acqDate, 'and it cannot establish a holding period').toBeNull();
    expect(out.shortfalls).toHaveLength(1);
    expect(out.shortfalls[0].qty).toBeCloseTo(10000, 6);
    expect(out.basis).toBe(0);
  });

  test('WITH Treatment A, the disposal draws on a real, dated lot and nothing is zero-based', async () => {
    const out = await window.evaluate(([wallet, src]) => {
      const run = new Function('return ' + src)();
      return run(wallet, 'A');
    }, [W_XRPL, SEQUENCE.toString()]);

    expect(out.consumed).toHaveLength(1);
    expect(out.consumed[0].qty).toBeCloseTo(10000, 6);
    expect(out.consumed[0].unitCost, 'a real price, not zero').toBeGreaterThan(0);
    expect(out.consumed[0].acqDate, 'and a date, so the holding period is knowable').toBe('2024-06-27');
    expect(out.shortfalls, 'nothing fell through').toEqual([]);
    expect(out.basis).toBeGreaterThan(0);
  });
});

test.describe('the position is stated on the report', () => {
  test.afterEach(resetAmmBuild);

  test('the panel names the treatment and what it booked', async () => {
    // A position adopted where no guidance exists is defensible largely
    // because it was chosen deliberately and applied consistently. A reader
    // cannot verify either of those from a number alone.
    const html = await window.evaluate(() => {
      resetLedgerState();
      ammTreatment = 'A';
      ammBookedDeposits = 39; ammBookedDepositQty = 19990.20;
      ammBookedWithdrawals = 29; ammBookedWithdrawQty = 56803.37;
      return dataQualityHTML();
    });
    expect(html).toContain('Treatment A');
    expect(html).toMatch(/no IRS guidance/i);
    expect(html).toContain('39');
    expect(html).toContain('19,990.2');
    expect(html).toContain('56,803.37');
    // The limit has to travel with the claim.
    expect(html).toMatch(/Only the XRP leg is booked/);
  });

  test('skipped rows are named in the same panel, not left to be inferred', async () => {
    const html = await window.evaluate(() => {
      resetLedgerState();
      ammTreatment = 'A';
      ammBookedWithdrawals = 29; ammSkippedUnverified = 5;
      return dataQualityHTML();
    });
    expect(html).toMatch(/5 AMM transaction\(s\) were NOT booked/);
    expect(html).toMatch(/never used to build a basis lot/);
  });

  test('with the default treatment the panel does not appear at all', async () => {
    const html = await window.evaluate(() => {
      resetLedgerState();
      ammBookedDeposits = 0; ammBookedWithdrawals = 0; ammSkippedUnverified = 0;
      return dataQualityHTML();
    });
    expect(html).not.toContain('Tax position applied');
  });
});

test.describe('the treatment comparison', () => {
  // Measures, never changes. The setting it finds is the setting it leaves,
  // and nothing is written to storage — a tool for deciding whether to adopt
  // a tax position must not adopt one as a side effect of being consulted.
  test.afterEach(resetAmmBuild);

  test('the snapshot splits ST and LT and totals gain per year', async () => {
    const snap = await window.evaluate((wallet) => {
      resetLedgerState();
      ledgerAdd(wallet, 'XRP', '2021-05-01', 1000, 0.50, 'test');
      ledgerAdd(wallet, 'XRP', '2025-01-02', 500, 2.00, 'test');
      // Long-term: drawn from the 2021 lot.
      pushDisposal(wallet, 'XRP', 100, '2025-06-01', '2025-06-01', 2025, 'H1', 3.00, 2.80, '', '');
      // Short-term: 2021 lot is now partly spent, but FIFO still reaches it,
      // so force a second year to prove years are kept apart.
      pushDisposal(wallet, 'XRP', 50, '2024-06-01', '2024-06-01', 2024, 'H2', 1.00, 0.90, '', '');
      return treatmentSnapshot();
    }, W_XRPL);

    expect(Object.keys(snap.byYear).sort()).toEqual(['2024', '2025']);
    expect(snap.byYear['2025'].ltProceeds).toBeCloseTo(300, 4);
    expect(snap.byYear['2025'].ltBasis).toBeCloseTo(50, 4);
    expect(snap.byYear['2024'].rows).toBe(1);
  });

  test('the snapshot follows a manual ST/LT override, because that is what gets reported', async () => {
    // Built on r.term instead, the comparison would diff a classification the
    // return does not use.
    const out = await window.evaluate((wallet) => {
      resetLedgerState();
      ledgerAdd(wallet, 'XRP', '2021-05-01', 1000, 0.50, 'test');
      pushDisposal(wallet, 'XRP', 100, '2025-06-01', '2025-06-01', 2025, 'H1', 3.00, 2.80, '', '');
      const auto = treatmentSnapshot().byYear['2025'];
      const key = allDisposalsHigh[0].rowKey;
      termOverrides[key] = 'ST';
      const overridden = treatmentSnapshot().byYear['2025'];
      delete termOverrides[key];
      return { autoLT: auto.ltProceeds, autoST: auto.stProceeds,
               ovLT: overridden.ltProceeds, ovST: overridden.stProceeds };
    }, W_XRPL);

    expect(out.autoLT).toBeCloseTo(300, 4);
    expect(out.autoST).toBe(0);
    expect(out.ovST, 'the override moved it').toBeCloseTo(300, 4);
    expect(out.ovLT).toBe(0);
  });

  test('the zero-basis shortfall is what the comparison reports as cured', async () => {
    const out = await window.evaluate((wallet) => {
      resetLedgerState();
      ledgerFIFODetailed(wallet, 'XRP', 9873.6705);   // nothing to draw on
      const withGap = treatmentSnapshot();
      resetLedgerState();
      ledgerAdd(wallet, 'XRP', '2024-06-27', 24101.03668, 0.48, 'amm_withdrawal');
      ledgerFIFODetailed(wallet, 'XRP', 9873.6705);   // now covered
      const cured = treatmentSnapshot();
      return { before: withGap.zero.byTicker.XRP || 0, after: cured.zero.byTicker.XRP || 0,
               beforeRows: withGap.shortRows, afterRows: cured.shortRows,
               beforeUsd: withGap.zero.usd, afterUsd: cured.zero.usd };
    }, W_XRPL);

    expect(out.before).toBeCloseTo(9873.6705, 4);
    expect(out.after).toBe(0);
    expect(out.beforeUsd, 'and it is priced, not left as a bare quantity').toBeGreaterThan(0);
    expect(out.afterUsd).toBe(0);
    expect(out.beforeRows).toBe(1);
    expect(out.afterRows).toBe(0);
  });

  test('the rendered comparison names the direction and does not bury the skipped rows', async () => {
    const html = await window.evaluate(() => {
      const mk = (gainY) => ({
        byYear: { '2024': { rows: 10, stProceeds: gainY, stBasis: 0, ltProceeds: 0, ltBasis: 0 } },
        zero: { byTicker: {}, usd: 0, rows: 0 }, shortRows: 0, booked: 0, skipped: 0, unvalued: 40,
      });
      const before = mk(1000);
      const after = { ...mk(11556.83), booked: 68, skipped: 5, unvalued: 5, zero: { byTicker: {}, usd: 0, rows: 0 }, shortRows: 0 };
      before.zero = { byTicker: { XRP: 10010 }, usd: 13613.60, rows: 4 }; before.shortRows = 4;
      return renderTreatmentCompare(before, after);
    });

    expect(html).toContain('2024');
    // The change in gain, not just the two totals.
    expect(html).toMatch(/\+\$10,556\.83/);
    expect(html).toMatch(/10,010 XRP/);
    expect(html, 'the dollar figure is present as sizing').toMatch(/\$13,613\.60/);
    // ...but explicitly NOT as a tax figure. A quantity priced today and a
    // change in reported gain measure different things; the panel said
    // "$18,908.93 of overstated gain" on a real run, which invites adding it
    // to the +$3,005.73 in the table above. They must never be combined.
    expect(html, 'must disclaim itself as sizing, not tax').toMatch(/NOT a tax figure/);
    expect(html).toMatch(/at today.s prices/);
    expect(html).toMatch(/5 skipped/);
    expect(html).toMatch(/A rise in reported gain is the expected direction/);
    // The decision it hands back rather than makes.
    expect(html).toMatch(/your preparer/);
  });

  test('a year present under one treatment and absent under the other still appears', async () => {
    // Treatment A can create the first disposal in a year that previously had
    // none. Iterating only the "before" years would hide exactly that.
    const html = await window.evaluate(() => renderTreatmentCompare(
      { byYear: {}, zero: { byTicker: {}, usd: 0, rows: 0 }, shortRows: 0, booked: 0, skipped: 0, unvalued: 39 },
      { byYear: { '2024': { rows: 39, stProceeds: 10556.83, stBasis: 4000, ltProceeds: 0, ltBasis: 0 } },
        zero: { byTicker: {}, usd: 0, rows: 0 }, shortRows: 0, booked: 39, skipped: 0, unvalued: 0 }));
    expect(html).toContain('2024');
    expect(html).toMatch(/0 → 39/);
  });

  test('the CSV carries both treatments per year, and refuses when nothing has been run', async () => {
    const out = await window.evaluate(() => {
      const saved = _lastTreatmentCompare;
      _lastTreatmentCompare = null;
      let refused = false;
      const realAlert = window.alert;
      window.alert = () => { refused = true; };
      exportTreatmentCompareCSV();
      window.alert = realAlert;
      _lastTreatmentCompare = saved;
      return refused;
    });
    expect(out, 'exporting before running would write an empty file').toBe(true);
  });
});
