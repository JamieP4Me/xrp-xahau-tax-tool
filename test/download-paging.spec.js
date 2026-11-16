// test/download-paging.spec.js — the download must not be able to skip a row
// (1.10.16), plus the three things shipped with it.
//
//   Paging   The download paged with LIMIT n OFFSET k. OFFSET is only right
//            if the result is identical from one query to the next, and a
//            database that merges duplicates in the background, or returns
//            rows sharing a timestamp in no fixed order, does not promise
//            that. A row that slides across a page boundary between two
//            queries is returned by neither, and it is older than the sync
//            cursor from then on, so no later download asks for it. The
//            first test shows the old method losing rows against exactly
//            that kind of server; the rest show the new one does not.
//   Queries  Only an address or a timestamp may be written into a query.
//   PDF      The Form 8949 description wraps instead of being cut off.
//   LP       An LP row names its pool ("LP XRP/ABC") instead of a hash.
//   Bridge   The panel never offers an address it would refuse.
//
// Never put a real address in a test.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_DIR = path.join(__dirname, '..');
const W = 'rTESTpagingMain11111111111111111';
const W2 = 'rTESTpagingSecond111111111111111';
const OTHER = 'rTESTpagingStranger1111111111111';
const MINTER = 'rTESTpagingMinter111111111111111';
const POOL = 'rTESTpagingPoo1Account1111111111';
const H = (c) => c.repeat(64);
const LP = '03' + 'AB'.repeat(19);

let app, window, userDataDir;

test.beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrp-xahau-paging-'));
  app = await electron.launch({
    args: [APP_DIR, '--user-data-dir=' + path.join(userDataDir, 'electron-profile')],
    cwd: APP_DIR,
    env: { ...process.env, HOME: userDataDir },
  });
  window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.waitForFunction(() => typeof _ledgerBuildInFlight !== 'undefined' && _ledgerBuildInFlight === null && !_ledgerLockHeld,
    null, { timeout: 30000 });
  await window.evaluate(() => {
    // A stand-in for WinDB that behaves the way a real one is allowed to:
    //   • rows sharing a timestamp come back in a different order each query;
    //   • `vanish` rows are duplicates that a background merge removes after
    //     the first query has seen them.
    // The "SQL" is a JSON description of the question, so the fake answers
    // the same question the real query would ask.
    window.fakeWinDb = (rows, opts = {}) => {
      let seed = 7, calls = 0;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      const log = [];
      const query = async (sql) => {
        const q = JSON.parse(sql);
        calls++;
        let live = rows.filter((r) => !(r._vanishAfter && calls > r._vanishAfter));
        if (q.from) live = live.filter((r) => String(r.Timestamp) >= q.from);
        const keyed = live.map((r) => ({ r, k: opts.stable ? 0 : rnd() }));
        keyed.sort((a, b) => (a.r.Timestamp < b.r.Timestamp ? -1 : a.r.Timestamp > b.r.Timestamp ? 1 : a.k - b.k));
        log.push(q);
        return keyed.slice(q.offset, q.offset + q.limit).map(({ r }) => { const o = { ...r }; delete o._vanishAfter; return o; });
      };
      return { query, log, calls: () => calls };
    };
    window.asQuestion = (offset, limit, from) => JSON.stringify({ offset, limit, from: from || null });
    window.ts = (n) => new Date(Date.UTC(2024, 0, 1) + n * 1000).toISOString().slice(0, 19).replace('T', ' ') + '.000000000';
    window.drain = async (it) => { const out = []; for await (const step of it) out.push(...step.rows); return out; };
    // The old method, kept here only to show what it loses.
    window.offsetPaging = async (query, page) => {
      const out = [];
      for (let offset = 0; ;) { const got = await query(asQuestion(offset, page, null)); out.push(...got); offset += got.length; if (got.length < page) break; }
      return out;
    };
    window.realWindbQuery = windbQuery;
  });
});

test.afterAll(async () => {
  if (app) await app.close();
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

test.afterEach(async () => { await window.evaluate(() => { window.windbQuery = window.realWindbQuery; abortFlag = false; }); });

// ── Paging ─────────────────────────────────────────────────────────────

test('a duplicate that is merged away mid-download costs the old paging a row, and the new paging none', async () => {
  const out = await window.evaluate(async () => {
    // 2,500 real rows. One early row is held twice until the first query has run.
    const make = () => {
      const rows = [];
      for (let i = 0; i < 2500; i++) rows.push({ Timestamp: ts(i), TransactionHash: 'T' + i, n: i });
      rows.push({ Timestamp: ts(10), TransactionHash: 'T10', n: 10, _vanishAfter: 1 });
      return rows;
    };
    const want = new Set(Array.from({ length: 2500 }, (_, i) => 'T' + i));
    const old = await offsetPaging(fakeWinDb(make(), { stable: true }).query, 1000);
    const oldSeen = new Set(old.map((r) => r.TransactionHash));
    const db = fakeWinDb(make(), { stable: true });
    window.windbQuery = db.query;
    const rows = await drain(keysetRows({ claim: 'x', buildSql: asQuestion, page: 1000 }));
    const seen = new Set(rows.map((r) => r.TransactionHash));
    return { oldMissing: [...want].filter((h) => !oldSeen.has(h)), missing: [...want].filter((h) => !seen.has(h)), queries: db.calls(),
             offsets: db.log.map((q) => q.offset), froms: db.log.map((q) => q.from) };
  });
  expect(out.oldMissing).toEqual(['T999']);            // slid across the first page boundary, returned by neither query
  expect(out.missing).toEqual([]);
  expect(out.offsets.every((o) => o === 0)).toBe(true);   // never counts from the start
  expect(out.froms[0]).toBe(null);
  expect(out.froms[1]).toMatch(/^2024-01-01 00:16:3\d\.000000000$/);
  expect(out.queries).toBe(3);                         // no more queries than before
});

test('rows that share a timestamp across a page boundary, in a different order every query, are each returned exactly once', async () => {
  const out = await window.evaluate(async () => {
    const rows = [];
    for (let i = 0; i < 3200; i++) {
      // Blocks of rows on one timestamp, placed over both page boundaries.
      const t = (i >= 990 && i < 1012) ? 990 : (i >= 1995 && i < 2030) ? 1995 : i;
      rows.push({ Timestamp: ts(t), TransactionHash: 'T' + i, n: i });
    }
    const db = fakeWinDb(rows);
    window.windbQuery = db.query;
    const steps = [];
    const got = [];
    for await (const step of keysetRows({ claim: 'x', buildSql: asQuestion, page: 1000 })) { steps.push([step.rows.length, step.received]); got.push(...step.rows); }
    const counts = new Map();
    for (const r of got) counts.set(r.TransactionHash, (counts.get(r.TransactionHash) || 0) + 1);
    return { total: got.length, distinct: counts.size, twice: [...counts.values()].filter((n) => n > 1).length, steps };
  });
  expect(out.total).toBe(3200);
  expect(out.distinct).toBe(3200);
  expect(out.twice).toBe(0);
  expect(out.steps[1][1]).toBeGreaterThan(out.steps[1][0]);   // the boundary rows were asked for again, and dropped
});

test('more rows on one timestamp than fit in a page: the page grows until it can move on', async () => {
  const out = await window.evaluate(async () => {
    const rows = [];
    for (let i = 0; i < 500; i++) rows.push({ Timestamp: ts(i), TransactionHash: 'A' + i });
    for (let i = 0; i < 2600; i++) rows.push({ Timestamp: ts(500), TransactionHash: 'B' + i });
    for (let i = 0; i < 300; i++) rows.push({ Timestamp: ts(600 + i), TransactionHash: 'C' + i });
    const db = fakeWinDb(rows);
    window.windbQuery = db.query;
    const got = await drain(keysetRows({ claim: 'x', buildSql: asQuestion, page: 1000 }));
    // Two different rows on one timestamp with nothing else to tell them apart are both kept.
    const twins = [{ Timestamp: ts(1), a: 1 }, { Timestamp: ts(1), a: 2 }, { Timestamp: ts(1), a: 3 }, { Timestamp: ts(2), a: 4 }];
    window.windbQuery = fakeWinDb(twins).query;
    const kept = await drain(keysetRows({ claim: 'x', buildSql: asQuestion, page: 2 }));
    // A wall of rows that never ends is an error, not an endless loop.
    const wall = Array.from({ length: 70 }, (_, i) => ({ Timestamp: ts(5), TransactionHash: 'W' + i }));
    window.windbQuery = fakeWinDb(wall).query;
    let err = '';
    try { await drain(keysetRows({ claim: 'x', buildSql: asQuestion, page: 4, maxLimit: 16 })); } catch (e) { err = e.message; }
    return { total: got.length, distinct: new Set(got.map((r) => r.TransactionHash)).size, limits: [...new Set(db.log.map((q) => q.limit))],
             kept: kept.map((r) => r.a).sort(), err, cap: KEYSET_MAX_LIMIT };
  });
  expect(out.total).toBe(3400);
  expect(out.distinct).toBe(3400);
  expect(out.limits).toEqual([1000, 2000, 4000]);
  expect(out.kept).toEqual([1, 2, 3, 4]);
  expect(out.err).toMatch(/more than 16 rows share the timestamp/);
  expect(out.cap).toBe(64000);
});

test('timestamps in a form this version does not know: the pass says so and pages the old way instead of failing', async () => {
  const out = await window.evaluate(async () => {
    const rows = Array.from({ length: 2300 }, (_, i) => ({ Timestamp: String(1700000000 + i), TransactionHash: 'E' + i }));
    const db = fakeWinDb(rows, { stable: true });
    window.windbQuery = db.query;
    let said = 0;
    const got = await drain(keysetRows({ claim: 'x', buildSql: asQuestion, page: 1000, onFallback: () => { said++; } }));
    return { total: got.length, distinct: new Set(got.map((r) => r.TransactionHash)).size, said, offsets: db.log.map((q) => q.offset), froms: db.log.map((q) => q.from) };
  });
  expect(out.total).toBe(2300);
  expect(out.distinct).toBe(2300);
  expect(out.said).toBe(1);
  expect(out.offsets).toEqual([0, 1000, 2000]);
  expect(out.froms).toEqual([null, null, null]);       // nothing unreadable was written into a query
});

test('a whole pass lands in the cache once, reports what it fetched, and stops cleanly on an error', async () => {
  const out = await window.evaluate(async ({ W }) => {
    const rows = [];
    for (let i = 0; i < 2100; i++) {
      const t = (i >= 995 && i < 1005) ? 995 : i;
      rows.push({ Timestamp: ts(t), TransactionHash: i.toString(16).toUpperCase().padStart(64, '0'), TransactionType: 'Payment', Account: W, n: i });
    }
    const db = fakeWinDb(rows);
    window.windbQuery = db.query;
    const pass = await paginateAndStash({ claim: 'x', chain: 'XRPL', wallet: W, buildSql: asQuestion, page: 1000 });
    const cached = await window.taxDB.countForWallet(W, 'XRPL');
    // The same download again adds nothing.
    window.windbQuery = fakeWinDb(rows).query;
    const again = await paginateAndStash({ claim: 'x', chain: 'XRPL', wallet: W, buildSql: asQuestion, page: 1000 });
    const cachedAgain = await window.taxDB.countForWallet(W, 'XRPL');
    // A failed page: not ok, so the caller leaves the sync point where it was.
    let n = 0; const errs = [];
    const inner = fakeWinDb(rows).query;
    window.windbQuery = async (sql) => { if (++n === 2) throw new Error('WinDB HTTP 502'); return inner(sql); };
    const failed = await paginateAndStash({ claim: 'x', chain: 'XRPL', wallet: W, buildSql: asQuestion, page: 1000, onError: (e, p) => errs.push([e.message, p]) });
    return { pass, cached, again: again.total, cachedAgain, failed: { ok: failed.ok, total: failed.total }, errs, maxTs: ts(2099) };
  }, { W });
  expect(out.pass.total).toBe(2100);
  expect(out.pass.ok).toBe(true);
  expect(out.pass.truncated).toBe(false);
  expect(out.pass.maxTs).toBe(out.maxTs);
  expect(out.cached).toBe(2100);
  expect(out.again).toBe(2100);
  expect(out.cachedAgain).toBe(2100);
  expect(out.failed).toEqual({ ok: false, total: 1000 });
  expect(out.errs).toEqual([['WinDB HTTP 502', 2]]);
});

test('a lease read twice at a page boundary is counted once', async () => {
  const out = await window.evaluate(async ({ W, OTHER }) => {
    // 5 leases on one timestamp straddle the boundary of a 4-row page.
    const rows = Array.from({ length: 9 }, (_, i) => ({
      CTID: '', TransactionHash: (0xA0 + i).toString(16).toUpperCase().padStart(64, '0'), Timestamp: ts(i >= 2 && i < 7 ? 2 : i),
      Account: OTHER, Amount_XRP: '', Amount_value: '0.5', Amount_currency: 'EVR', Amount_issuer: 'rTESTevrIssuer1111111111111111111', URITokenID: 'U' + i }));
    const db = fakeWinDb(rows);
    const asked = [];
    window.windbQuery = async (sql) => {
      asked.push(sql);
      const m = /LIMIT (\d+) OFFSET (\d+)/.exec(sql), f = /Timestamp >= '([^']+)'/.exec(sql);
      return db.query(asQuestion(Number(m[2]), Number(m[1]), f ? f[1] : null));
    };
    const pass = await fetchLeaseSales('x', W, new Set([W]), null, null, 4);
    return { total: pass.total, evr: pass.evr, external: pass.external, ok: pass.ok, queries: asked.length, offsets: asked.map((s) => /OFFSET (\d+)/.exec(s)[1]) };
  }, { W, OTHER });
  expect(out.total).toBe(9);
  expect(out.external).toBe(9);
  expect(out.evr).toBeCloseTo(4.5, 9);
  expect(out.ok).toBe(true);
  expect(out.offsets.every((o) => o === '0')).toBe(true);
});

// ── Queries ────────────────────────────────────────────────────────────

test('only an address, a timestamp or a row count can be written into a query', async () => {
  const out = await window.evaluate(({ W }) => {
    const thrown = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
    const said = [];
    const realLog = window.log; window.log = (m) => said.push(m);
    const res = {
      addr: sqlAddr(W),
      badAddr: thrown(() => sqlAddr(W + "' OR '1'='1")),
      notAddr: thrown(() => sqlAddr('')),
      ts: [sqlTs('2025-01-01 00:00:00'), sqlTs('2025-12-17 10:50:42.168000006'), sqlTs('2025-12-17T10:50:42.168Z')],
      badTs: thrown(() => sqlTs("2025-01-01 00:00:00' OR '1'='1")),
      badTs2: thrown(() => sqlTs('2025-01-01 00:00:00; DROP TABLE x')),
      int: sqlInt(2000), badInt: [thrown(() => sqlInt('10; DROP')), thrown(() => sqlInt(-1)), thrown(() => sqlInt(1.5))],
      // A saved sync point that is not a timestamp is not sent: the full history is read instead.
      cursor: [usableCursor('2025-01-01 00:00:00', 'w'), usableCursor(null, 'w'), usableCursor("x' OR 1=1 --", 'w')],
      lease: thrown(() => leaseSql(W, null, "2025' --", 1000, 0)),
      leaseAddr: thrown(() => leaseSql("r' --", null, null, 1000, 0)),
      leaseOk: leaseSql(W, null, '2025-01-01 00:00:00', 1000, 0),
    };
    window.log = realLog;
    return { ...res, said };
  }, { W });
  expect(out.addr).toBe(W);
  expect(out.badAddr).toMatch(/not a wallet address/);
  expect(out.notAddr).toMatch(/not a wallet address/);
  expect(out.ts).toHaveLength(3);
  expect(out.badTs).toMatch(/not a timestamp/);
  expect(out.badTs2).toMatch(/not a timestamp/);
  expect(out.int).toBe('2000');
  expect(out.badInt.every((m) => /not a row count/.test(m))).toBe(true);
  expect(out.cursor).toEqual(['2025-01-01 00:00:00', null, null]);
  expect(out.said.join('\n')).toMatch(/saved sync point is not a timestamp/);
  expect(out.lease).toMatch(/not a timestamp/);
  expect(out.leaseAddr).toMatch(/not a wallet address/);
  expect(out.leaseOk).toContain(`Account != '${W}'`);
});

test('every query the download builds goes through those checks', async () => {
  const html = fs.readFileSync(path.join(APP_DIR, 'renderer/index.html'), 'utf8');
  const builders = html.match(/buildSql: \(offset, page, from\) => `[\s\S]*?`\.trim\(\)/g) || [];
  expect(builders).toHaveLength(4);                    // Xahau sent/received, XRPL sent/received
  for (const b of builders) {
    expect(b).toMatch(/= '\$\{addr\}'/);               // addr = sqlAddr(w)
    expect(b).not.toMatch(/'\$\{w\}'/);
    expect(b).toContain('${timeFilter(from)}');
    expect(b).toContain('LIMIT ${sqlInt(page)} OFFSET ${sqlInt(offset)}');
  }
  expect(html.match(/addr = sqlAddr\(w\)/g)).toHaveLength(2);
  expect(html.match(/>= '\$\{sqlTs\(t\)\}'/g)).toHaveLength(2);
  // No query text is built from a raw sync point any more.
  expect(html).not.toMatch(/>= '\$\{sinceTs\}'/);
});

// ── PDF ────────────────────────────────────────────────────────────────

test('the Form 8949 PDF wraps a long description instead of cutting it off', async () => {
  const out = await window.evaluate(({ W, POOL, LP }) => {
    const mk = () => new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
    const row = (description, ticker) => pdfDisposalRow({ description, dateAcquired: '05/24/2024', dateStr: '08/27/2025', proceeds: 5400, basis: 2400, gain: 3000,
      ticker, wallet: W, term: 'LT', dk: '2025-08-27' });
    const long = row('123456.7890 LP token ABABAB (rTESTpa…) withdrawn from AMM pool, and a note long enough to need a second line', LP + '.' + POOL);
    const short = row('100.0000 XRP', 'XRP');
    const d1 = mk(); d1.setFontSize(7);
    const yLong = pdfTable(d1, { cols: PDF_DISPOSAL_COLS, rows: [long], x0: 40, startY: 100, margin: 40 });
    const d2 = mk(); d2.setFontSize(7);
    const yShort = pdfTable(d2, { cols: PDF_DISPOSAL_COLS, rows: [short], x0: 40, startY: 100, margin: 40 });
    const text = d1.output();
    const d3 = mk(); d3.setFontSize(7);
    const lines = wrapToWidth(d3, 'word '.repeat(80).trim(), 115, 3);
    // A row that no longer fits is moved to the next page whole.
    const d4 = mk(); d4.setFontSize(7);
    const pageH = d4.internal.pageSize.getHeight();
    pdfTable(d4, { cols: PDF_DISPOSAL_COLS, rows: [short, long], x0: 40, startY: pageH - 40 - 16 - 14 - 18, margin: 40 });
    const fits = wrapToWidth(d3, '8641.9746 LP XRP/MAG withdrawn from AMM pool', PDF_DISPOSAL_COLS[0].w - 5, 3).length;
    const width = PDF_DISPOSAL_COLS.reduce((n, c) => n + c.w, 0);
    return { fits, width, pageW: d3.internal.pageSize.getWidth(), wrapped: wrapToWidth(d3, long.desc, PDF_DISPOSAL_COLS[0].w - 5, 3), full: long.desc, yLong, yShort, hasEnd: text.includes('second line'), hasStart: text.includes('123456.7890 LP token'), ellipsis: text.includes('withdrawn from…'),
             lines: lines.length, lastEnds: lines[2].endsWith('…'), pages: d4.internal.getNumberOfPages(), asset: [long.chain, short.chain, pdfAssetShort('LONGTOKENNAME.' + POOL)] };
  }, { W, POOL, LP });
  expect(out.wrapped.join(' ')).toBe(out.full);         // every word is there, none replaced by an ellipsis
  expect(out.fits).toBe(1);                            // an ordinary LP row needs one line
  expect(out.width).toBeLessThanOrEqual(out.pageW - 60);   // and the table still fits between the margins
  expect(out.wrapped.length).toBeGreaterThan(1);
  expect(out.hasStart).toBe(true);
  expect(out.hasEnd).toBe(true);                       // the words that used to fall off the end
  expect(out.yLong).toBeGreaterThan(out.yShort);       // the row grew to hold them
  expect(out.yLong - out.yShort).toBe((out.wrapped.length - 1) * 8);
  expect(out.lines).toBe(3);                           // never taller than three lines
  expect(out.lastEnds).toBe(true);
  expect(out.pages).toBe(2);
  expect(out.asset).toEqual(['LP', 'XRP', 'LONGTOK…']);
});

// ── LP rows name their pool ────────────────────────────────────────────

test('an LP row names its pool, also when the second asset only shows up later, and the name survives a saved report', async () => {
  const out = await window.evaluate(({ W, MINTER, POOL, LP, h }) => {
    const lrow = ({ hash, ts, type, xrp = 0, tokens = [], pool }) => Object.assign({
      _ledger: 1, TransactionType: 'LedgerChange', TransactionResult: 'tesSUCCESS', Timestamp: ts, LedgerHash: hash,
      LedgerType: type, Account: W, Destination: '', Role: 'sent', XRP: xrp, Tokens: tokens }, pool ? { Pool: pool } : {});
    const tok = (c, d, i) => ({ c, i: i || MINTER, d });
    const lpTk = LP + '.' + POOL, abc = 'ABC.' + MINTER;
    resetLedgerState();
    WALLETS.length = 0; WALLETS.push(W);
    ledgerTradeIndex.keys.clear(); ledgerTradeIndex.through.clear();
    ammTreatment = 'A';
    const ws = new Set([W]), xr = makeXrplPriceHelpers();
    const unknown = ltTokenLabel(lpTk);
    ledgerAdd(W, 'XRP', '2023-01-10', 5000, 0.40, 'received');
    // XRP only goes in: one asset of the pool is known.
    processOneXRPLRow(lrow({ hash: h[0], ts: '2024-05-24 10:00:00', type: 'AMMDeposit', xrp: -1000, tokens: [tok(LP, 100, POOL)] }), W, ws, 'out', xr);
    const oneKnown = ltTokenLabel(lpTk);
    // An XRP-only withdrawal is written while the pool is still half known…
    processOneXRPLRow(lrow({ hash: h[1], ts: '2025-08-27 10:00:00', type: 'AMMWithdraw', xrp: 300, tokens: [tok(LP, -30, POOL)] }), W, ws, 'out', xr);
    const early = allDisposalsHigh[allDisposalsHigh.length - 1].description;
    // …and both assets come out later.
    processOneXRPLRow(lrow({ hash: h[2], ts: '2025-09-01 10:00:00', type: 'AMMWithdraw', xrp: 400, tokens: [tok('ABC', 900), tok(LP, -70, POOL)] }), W, ws, 'out', xr);
    relabelLpRows();
    const lpRows = allDisposalsHigh.filter((r) => r.ticker === lpTk).map((r) => r.description);
    const xrpRow = allDisposalsHigh.find((r) => r.ticker === 'XRP');
    // A saved report carries the names.
    const snap = snapshotLedgerState();
    resetLedgerState();
    const afterReset = ltTokenLabel(lpTk);
    restoreLedgerState(snap);
    const restored = ltTokenLabel(lpTk);
    // From 1.10.16 the ledger read stores the pool's assets on the row, so one transaction is enough.
    resetLedgerState();
    ledgerAdd(W, 'XRP', '2023-01-10', 5000, 0.40, 'received');
    processOneXRPLRow(lrow({ hash: h[3], ts: '2024-05-24 10:00:00', type: 'AMMDeposit', xrp: -1000, tokens: [tok(LP, 100, POOL)], pool: ['XRP', abc] }), W, ws, 'out', xr);
    const fromRow = allDisposalsHigh.length && ltTokenLabel(lpTk);
    // What the ledger read writes for an AMM transaction.
    const ch = ltChangesFromTx({ hash: h[4], ledger_index: 90000000,
      tx: { TransactionType: 'AMMDeposit', Account: W, Fee: '12', date: 770000000, Asset: { currency: 'XRP' }, Asset2: { currency: 'ABC', issuer: MINTER } },
      meta: { TransactionResult: 'tesSUCCESS', TransactionIndex: 3, AffectedNodes: [
        { ModifiedNode: { LedgerEntryType: 'RippleState', FinalFields: { Balance: { currency: LP, issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', value: '-100' }, HighLimit: { currency: LP, issuer: W, value: '0' }, LowLimit: { currency: LP, issuer: POOL, value: '0' } }, PreviousFields: { Balance: { currency: LP, issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', value: '0' } } } }] } }, W);
    const stored = JSON.parse(ltCacheRow(ch).raw_json);
    const pay = ltChangesFromTx({ hash: h[5], ledger_index: 90000001, tx: { TransactionType: 'Payment', Account: W, Fee: '12', date: 770000000 },
      meta: { TransactionResult: 'tesSUCCESS', TransactionIndex: 1, AffectedNodes: [] } }, W);
    return { unknown, oneKnown, early, lpRows, xrpDesc: xrpRow.description, hasTail: 'descTail' in xrpRow, afterReset, restored, fromRow, pool: stored.Pool, payPool: pay.pool,
             other: ltTokenLabel(abc), asset: [ltAssetTicker({ currency: 'XRP' }), ltAssetTicker({ currency: 'ABC', issuer: MINTER }), ltAssetTicker(null), ltAssetTicker({ currency: 'ABC', issuer: 'x' })] };
  }, { W, MINTER, POOL, LP, h: [H('1'), H('2'), H('3'), H('4'), H('5'), H('6')] });
  expect(out.unknown).toBe('LP token ABABAB (rTESTpa…)');           // nothing known: the old label
  expect(out.oneKnown).toBe('LP XRP/? ABABAB');
  expect(out.early).toBe('30.0000 LP XRP/? ABABAB withdrawn from AMM pool');
  expect(out.lpRows).toEqual(['30.0000 LP XRP/ABC withdrawn from AMM pool', '70.0000 LP XRP/ABC withdrawn from AMM pool']);
  expect(out.xrpDesc).toBe('1000.0000 XRP deposited to AMM pool');   // other rows untouched
  expect(out.hasTail).toBe(false);
  expect(out.afterReset).toBe('LP token ABABAB (rTESTpa…)');
  expect(out.restored).toBe('LP XRP/ABC');
  expect(out.fromRow).toBe('LP XRP/ABC');
  expect(out.pool).toEqual(['XRP', 'ABC.' + MINTER]);
  expect(out.payPool).toEqual([]);
  expect(out.other).toBe('ABC (rTESTpa…)');
  expect(out.asset).toEqual(['XRP', 'ABC.' + MINTER, null, null]);
});

// ── Bridge panel ───────────────────────────────────────────────────────

test('the bridge panel never offers one of your own wallets, and a refusal says what to pick instead', async () => {
  const out = await window.evaluate(({ W, W2, OTHER, MINTER, h }) => {
    resetLedgerState();
    WALLETS.length = 0; WALLETS.push(W, W2);
    bridgeConfig.addresses = []; bridgeConfig.tokens = {};
    const entry = (hash, counterparty, kind, qty) => ({ chain: 'XRPL', wallet: W, dk: '2025-06-23', dateStr: '06/23/2025', year: 2025, hash, type: 'Payment',
      role: 'received', kind, ticker: 'EVR.' + MINTER, qty, counterparty });
    // A candidate that is one of your own wallets (however it got into the list) and a real one.
    ledgerTradeLog.push(entry(h[0], W2, 'token_in', 2500), entry(h[1], OTHER, 'token_in', 2495));
    const sug = bridgeSuggestions().map((e) => e.addr);
    bridgeScan.hints = { [W2]: { n: 2, qty: 100, native: 'EVR', dir: 'to' }, [OTHER]: { n: 1, qty: 50, native: 'EVR', dir: 'to' } };
    renderBridgeBox();
    const box = document.getElementById('bridgeBox');
    const html = box ? box.innerHTML : '';
    return { sug, offersOwn: html.includes(W2), offersOther: html.includes(OTHER), says: /not your wallet/i.test(html),
             own: bridgeRefusal(bridgeAddressConflict(W)), bad: bridgeRefusal(bridgeAddressConflict('nope')), conflict: bridgeAddressConflict(W) };
  }, { W, W2, OTHER, MINTER, h: [H('7'), H('8')] });
  expect(out.sug).toEqual([OTHER]);
  expect(out.offersOwn).toBe(false);
  expect(out.offersOther).toBe(true);
  expect(out.says).toBe(true);
  expect(out.conflict).toBe('it is one of your own wallets');
  expect(out.own).toMatch(/not the wallet you sent from/);
  expect(out.own).toMatch(/Mark as bridge/);
  expect(out.bad).toBe('That address cannot be a bridge: not a valid address.');
});
