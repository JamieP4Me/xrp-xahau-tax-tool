# XRP & Xahau Tax Tool — Desktop App

A native desktop build of the Form 8949 / Schedule D tool (`form8949-xrp-xahau-2025.html`)
using Electron: its own window, its own icon, no browser chrome, and a local SQLite
cache so a full transaction history only has to be fetched once per wallet —
every run after that fetches only what's new.

## What this is

The same HTML/CSS/JS as the browser version, wrapped so it:

- Opens as a real installable app (`.dmg` / `.exe` / `.AppImage`) with its own
  icon and window, not a browser tab.
- Serves its own content over `http://127.0.0.1:<port>` instead of `file://`,
  which is what makes the WinDB/Dhali `fetch()` calls work reliably — this was
  the CORS problem documented in `XRP_XAHAU_STANDALONE_APP_PLAN.md`, and it's
  fully gone in this build.
- Persists every transaction it fetches to a local SQLite database (in the
  OS's per-user app-data folder, not inside the app bundle, so it survives
  updates/reinstalls). The next time you run "Fetch," each wallet only pulls
  transactions newer than what's already cached, then merges cached + new and
  re-runs the tax calculation once. A "Local Data" panel on the Setup tab
  shows what's cached and lets you force a full re-sync or clear it.
- Rebuilds Form 8949 / Schedule D from whatever's already cached in that
  SQLite database automatically, every time the app starts — with no
  Payment-Claim and no network call. The claim is only ever needed to fetch
  *new* transactions; viewing what's already been synced never needs it. A
  "View Report From Cache (offline)" button on the Local Data panel re-runs
  the same rebuild on demand (e.g. after switching the tax-year dropdown).
- Exports a CSV formatted for direct import into Koinly.io or CoinLedger.io,
  trimmed down to only the transactions those tools actually need (deposits,
  withdrawals, DEX trades — trustlines, account settings, and transfers
  between your own wallets are left out). See "Koinly / CoinLedger CSV
  export" below.

The browser version (`form8949-xrp-xahau-2025.html`) still works standalone,
unchanged — this app's renderer is a copy that feature-detects the desktop
database bridge (`window.taxDB`) and falls back to the original in-memory,
fetch-everything-every-time behavior if it's not present.

## Why Electron, not Tauri

Both were considered, as the request suggested. Electron was chosen because:

- This build had to actually be built and tested end-to-end, not just
  scaffolded. Tauri's Linux build needs `webkit2gtk` and system GTK packages
  that add real setup risk in a fresh environment; Electron's Node/Chromium
  toolchain is self-contained via npm and was verified working here.
- Neither framework lets you cross-compile a `.dmg` or `.exe` from Linux —
  real macOS/Windows builds need to run on those OSes regardless of framework
  (see the CI workflow below). So Tauri's main advantage (smaller install
  size, no bundled Chromium) doesn't change how this gets shipped; it only
  changes the runtime footprint of the installed app.
- Electron's tooling for exactly this shape of app — a static HTML/JS tool
  plus a native SQLite dependency — is more mature: `better-sqlite3` has
  prebuilt binaries and a well-trodden `electron-builder` +
  `@electron/rebuild` path, which is what this app uses.

The tradeoff is real: the Electron build bundles a full Chromium (installers
land around 100+ MB vs. Tauri's low-teens MB using the OS's own WebView). If
install size becomes a real concern later, the renderer (`renderer/index.html`)
was kept as a plain, framework-free static page specifically so a Tauri
port would mean swapping the Rust/native shell around it, not rewriting it.

## Project layout

```
main.js              Electron main process: local static server + SQLite + IPC
preload.js           contextBridge surface exposed to the page (window.taxDB, window.appInfo)
db.js                SQLite wrapper (better-sqlite3) — schema, sync cursor, dedup
renderer/index.html  The tax tool itself (adapted copy of form8949-xrp-xahau-2025.html)
build/               App icons (icon.png / icon.ico / icon.icns)
test/db.test.js           Plain-Node unit tests for db.js (no Electron needed)
test/e2e.spec.js          Playwright test that launches the real packaged app
test/fifo-ordering.spec.js  Playwright test proving the cross-wallet FIFO merge fix
test/restart-persistence.spec.js  Playwright test proving a real quit-and-reopen keeps the report and settings
test/tax-software-export.spec.js  Playwright test for the Koinly/CoinLedger CSV export's row filtering
test/tax-correctness.spec.js      Playwright tests for the tax-math fixes from the code review
test/memory-scale.spec.js         Playwright test bounding renderer memory during a cache rebuild
test/price-history.spec.js        Playwright test for the per-asset Price History page and its spread maths
scripts/check-node.js             preinstall guard: refuses to build on a Node version better-sqlite3 cannot compile against
(Holdings tab: renderHoldings/computeHoldings/computeDisposalDestinations in renderer/index.html)
.github/workflows/build.yml   CI: builds .dmg / .exe / .AppImage on their native OS
```

## How the incremental sync works

- Each wallet+chain pair has a `sync_state.last_timestamp` cursor. A fetch
  only queries WinDB for rows newer than that cursor.
- Every row fetched is stashed to `raw_transactions`, keyed by
  `(wallet, chain, tx_hash)`, so re-fetching an overlapping range is a no-op
  (`INSERT OR IGNORE`) rather than a duplicate.
- Once every selected wallet has finished syncing, the app merges *all* of
  their cached rows — every wallet, both the outbound and inbound pass, old
  rows and newly-synced ones — into a single stream sorted by real
  transaction timestamp, and runs the FIFO tax engine over that one merged
  stream exactly once (see `processMergedXahauEntries()` /
  `processMergedXRPLEntries()` in `renderer/index.html`). This fixes the
  ordering gap completely, not just within one wallet: a transfer chain
  across three or more selected wallets (A sends to B, B later sends the
  same funds on to C) is now processed in true chronological order
  regardless of which wallet the fetch loop happened to sync first, so a lot
  B received from A is always available in B's ledger by the time B's later
  transfer to C is processed. Previously, processing one wallet's complete
  history before moving to the next could reach C (or B) before the wallet
  that originated the lot had been processed at all, silently falling back
  to $0 basis / unknown acquisition date for the inherited portion — see
  `test/fifo-ordering.spec.js`, which reproduces that exact failure from the
  old per-wallet approach and confirms the merged pass gets the real basis
  instead.
- The cursor never advances past `now - 24h`. This is a safety margin against
  WinDB not having finished indexing the very latest ledger data at the
  moment of a query — without it, a naive "furthest timestamp seen" cursor
  could permanently skip a transaction that hadn't been indexed yet when it
  was fetched.
- The cursor only advances if *both* the outbound and inbound passes for a
  wallet complete without error or user-cancel. A failed/aborted fetch leaves
  the cursor where it was, so the next run retries from the same point rather
  than silently skipping the gap.

### Why closing and reopening the app used to lose your report

Two separate bugs used to make "quit the app, reopen it" show an empty
Form 8949 (or a wallet list that had silently reverted). Both are fixed now:

1. **The report itself was pure in-memory state.** `allDisposalsHigh` /
   `allDisposalsLow` / `allIncomeRows` / `allTransactionHistory` /
   `walletLedger` are plain JS variables in the renderer — nothing rebuilt
   them on startup, so even a wallet set that was 100% synced with nothing
   new to fetch showed a blank report until you pasted a fresh Payment-Claim
   and clicked Fetch again. Fixed by running the offline cache rebuild
   described above automatically, right after the page loads, before you
   touch anything.
2. **The local server used to bind to a random port every launch.**
   `main.js` called `listen(0, ...)`, so the renderer's origin
   (`http://127.0.0.1:<port>`) was different every time the app started.
   `localStorage` is scoped per-origin, so a different origin each launch
   silently wiped the wallet-list and term-override customizations saved
   there (the SQLite cache itself was unaffected — it's keyed by wallet
   address, not by origin). Fixed by pinning the server to a fixed port
   (`FIXED_LOCAL_SERVER_PORT` in `main.js`, with a fallback to a random port
   only if that fixed port is somehow already taken on the machine).

`test/restart-persistence.spec.js` launches the real Electron app twice
against the same profile directory — an actual separate process launch, not
a page reload — and proves both fixes hold: the second launch shows the
cached report with no fetch, and the customized wallet list / term
overrides both survive.

(Note: the "selected" checkboxes — *which* of your wallets are currently
ticked — intentionally do **not** persist across restarts; that's original
behavior, unrelated to either bug above, not something this fixed or broke.)

Local Data panel (Setup tab) actions:
- **Refresh** — re-reads cache stats (row count, wallets covered, oldest/newest
  transaction, last sync time).
- **View Report From Cache (offline)** — rebuilds Form 8949 / Schedule D from
  every wallet with cached data, with no Payment-Claim and no network call.
  Runs automatically and silently on every startup; use the button to force
  a re-run on demand (e.g. right after switching the tax-year dropdown).
- **Force Full Re-sync** — clears sync cursors only. Cached rows stay, so the
  next fetch re-scans from genesis but doesn't lose or duplicate anything
  already stored (dedup handles the overlap).
- **Clear Local Database** — wipes everything. Next fetch starts completely fresh.

The database file lives at Electron's standard per-OS `userData` path
(e.g. `~/.config/xrp-xahau-tax-tool/tax-data.sqlite3` on Linux,
`~/Library/Application Support/xrp-xahau-tax-tool/tax-data.sqlite3` on macOS,
`%APPDATA%\xrp-xahau-tax-tool\tax-data.sqlite3` on Windows) — outside the
app bundle, so reinstalling or updating the app never touches it.

## Other features

- **"All Transactions" CSV export no longer freezes the app on a large
  history.** With hundreds of thousands (or millions) of cached rows, the
  original export built one giant CSV string in a single synchronous pass —
  long enough to block Chromium's UI thread and trigger macOS's "App Not
  Responding" state. The export (`exportAllTx()` / `downloadCSVChunked()` in
  `renderer/index.html`) now writes the file in 50,000-row chunks, yielding
  back to the UI thread between chunks and logging progress, so the app
  stays responsive and the button re-enables itself when the download starts.
- **2026 is selectable as a tax year**, even though it isn't over yet. It's
  useful for reviewing this year's transactions so far — in particular for
  spotting tax-loss-harvesting opportunities — well before year-end. It
  appears first in every tax-year dropdown (Setup, Form 8949, Schedule D);
  2025 remains the default selection.
- **Price History is one asset at a time, with spread.** The tab has three
  sub-tabs — XRP, XAH and EVR (`showPriceAsset()` / `priceAssetTab`) — each
  showing Month, Low, High, Spread ($) and Spread (%), with a bold full-year
  row per year. Splitting it was not cosmetic: the three series begin in 2013,
  2023 and 2024 respectively, so a combined table was mostly em-dashes, and
  they differ by two orders of magnitude, so a shared column of decimals
  rounded XAH's real movement to `$0.0000`. XAH and EVR are therefore shown to
  six decimal places and XRP to four. The year row aggregates one level up —
  the year's high is the highest month's high, never a sum or a mean.

  EVR gets a tab because `EVR_PRICES` is an independent series with its own
  highs and lows, contradicting a stale comment in the renderer that claimed
  EVR had no market of its own.

- **Volume, market and personal.** Four further columns: Market Vol ($),
  Market Vol (units, est.), and — once a report has been built — Your Vol
  (units) and Your Vol ($ est.).

  *Market volume* is embedded in `MARKET_VOLUME_USD`, monthly, as
  `[totalUsd, daysObserved]`, from the same CoinGecko source as the prices
  (`coins/<id>/market_chart`, `total_volumes`). Monthly rather than daily
  because monthly is the only granularity the page shows: ~8 KB instead of
  ~140 KB. It is **not** sourced from an XRPL explorer and could not be — the
  XRPL DEX order book runs on the order of 3.6M XRP/day against a market of
  roughly $2.5bn/day, so Bithomp, XRPScan or anything else reading the chain
  sees about 0.2% of the volume. Market volume lives on centralised exchanges,
  which never touch the ledger.

  *Your volume* (`myVolumeByMonth` / `recordMyVolume()`) is accumulated during
  the ledger build. A payment counts when coins crossed the boundary of the
  wallets this tool fetches: transfers between two of your own fetched wallets
  are excluded — nothing changed hands, and the cache holds them twice, once
  per wallet perspective — while sends to an exchange address marked `mine`,
  to a gift address, or out of a lost-key wallet do count. It is throughput,
  not net movement, so it is comparable with the market figure beside it.

  **Which figures are estimates matters, and the page says so.** Market Vol ($)
  is reported. Market Vol (units) is derived by dividing by the month's
  midpoint price. Your Vol in units is exact, off the ledger; its dollar value
  is estimated at each day's midpoint, because the ledger records no price. A
  `†` marks any period the data does not fully cover. Months before volume
  reporting began (XRP, Aug–Nov 2013) are **absent rather than zero** and
  render as an em-dash. None of it enters cost basis, proceeds or gains.

  **Prices aggregate by extreme, volumes by sum.** A year's high is its highest
  month's high; a year's volume is the total of its months. Applying one rule
  to both is the easy mistake, and `test/price-history.spec.js` checks each.

- **Price History has a PDF export.** The "Download PDF" button
  (`exportPriceHistoryPDF()`) exports *the asset currently selected*, in
  landscape — nine columns of currency do not fit across letter-portrait.
  Screen and print are generated from one `priceHistoryModel()`, because the
  two were previously written separately and drifted: the page gained spread
  and per-asset tabs while the PDF was still emitting a combined XRP+XAH table
  with neither.

  `jspdf` is now a devDependency pinned to the same version as the cdnjs URL
  in `renderer/index.html`, so the tests can inject it when the CDN is
  unreachable and actually exercise the export instead of skipping it. A test
  asserts the two versions still agree.

## Koinly / CoinLedger CSV export

The Form 8949 toolbar has two extra buttons, "⬇ Koinly CSV" and "⬇ CoinLedger
CSV" (`exportKoinlyCSV()` / `exportCoinLedgerCSV()` in `renderer/index.html`),
for importing your history into either tax-software platform instead of (or
alongside) this app's own Form 8949/Schedule D output. Both pull from the
same filtered row set (`buildRelevantTaxRows()`), so the logic only has to
be right once:

- **Only tax-relevant rows are included.** Ledger housekeeping with no
  economic value — `TrustSet`, `AccountSet`, `SignerListSet`, `OfferCancel`,
  and so on — is left out entirely, matching what the user actually asked
  for ("they do not need all transactions"). Only `Payment` (deposits/
  withdrawals) and `OfferCreate` (DEX trades) rows with a real, non-dust
  amount are considered.
- **Transfers between your own wallets are left out too.** Every wallet the
  app has ever cached data for (`listCachedWallets()`) is treated as one
  combined account for this export. A transfer that never leaves that
  combined account isn't a taxable event — Koinly/CoinLedger don't need a
  row for it, any more than this app's own FIFO ledger creates a gain/loss
  event for it (see `ledgerTransferIn()`).
- **Koinly CSV** uses Koinly's documented Universal/custom CSV columns
  (`Date, Sent Amount, Sent Currency, Received Amount, Received Currency,
  Fee Amount, Fee Currency, Net Worth Amount, Net Worth Currency, Tag,
  Description, TxHash`). Every deposit/withdrawal/trade row also carries a
  computed `Net Worth Amount`/`Net Worth Currency` in USD, using this app's
  own embedded daily price history for XAH/EVR/XRP — so Koinly has an
  accurate cost basis even though it likely has no market-price data of its
  own for XAH or EVR. The one EVR-reward case this app treats as ordinary
  income is tagged `reward`.
- **CoinLedger CSV** uses CoinLedger's documented Universal Manual Import
  Template columns (`Date, Platform, Asset Sent, Amount Sent, Asset
  Received, Amount Received, Fee Currency, Fee Amount, Type, Description,
  TxHash`). CoinLedger's template has no "Net Worth override" column, so if
  its own price database doesn't cover XAH/EVR, cost basis for those rows
  may come back as $0/unknown there — Koinly's export is the more reliable
  of the two specifically for XAH/EVR because of the Net Worth columns
  above. The EVR-reward case is tagged `Income`.
- **XRPL DEX trades (`OfferCreate` on the XRP Ledger) are skipped**, and
  counted separately in the post-export summary. This app's cached XRPL data
  only ever captured what was given up in a DEX offer, not what was received
  in return (`TakerPays_*` was never fetched for XRPL — see
  `fetchXRPLWinDB()`), so there's no way to build a correct two-sided trade
  row for those without misrepresenting them as a withdrawal to nowhere.
  Koinly has native XRP Ledger wallet support (paste your XRP address
  directly into Koinly's wallet setup) that reads DEX trades straight off
  the ledger and doesn't have this gap — see the note below.
- **Neither export captures on-chain network fees separately** (the cached
  WinDB data doesn't retain them) — the Fee Amount/Fee Currency columns are
  always left blank.

Each export finishes with a summary — of how many relevant transactions it
found, out of how many total scanned — plus a plan recommendation based on
Koinly's/CoinLedger's published pricing tiers (`recommendPlan()`): both
platforms price by transactions-per-tax-year, roughly Newbie/Hobbyist ($49,
100 tx), Hodler/Investor ($99, 1,000 tx), Trader/Pro ($199+, 3,000+ tx), and
Pro/Unlimited ($279–$499, 10,000+ tx) — both alert boxes explicitly tell you
to confirm current pricing at koinly.io/pricing or coinledger.io/pricing
before buying, since these change.

**Koinly's native wallet sync as an alternative.** Since Koinly natively
supports both XRP Ledger and Xahau wallets via public-address auto-sync (no
CSV needed), you can also just paste each wallet's public address directly
into Koinly and let it pull the full history itself. That's simpler for the
raw data and doesn't have the XRPL-DEX gap above, but it means Koinly's own
engine — not this app's — decides what's income vs. a plain deposit, and it
won't know anything about wallets in the 130-wallet default list you haven't
also added there. The CSV export stays useful when you want the export to
match exactly what this app already computed.

## Code review — correctness fixes

A full adversarial review of every file. Each item below changed a number
that could have appeared on a filed return, silently lost data, or crashed
the app at real data size. Every one has a regression test that asserts both
the wrong value the old code produced and the right one
(`test/tax-correctness.spec.js`, plus three additions to `test/db.test.js`).

**Timestamps were parsed as local time, then read back as UTC.** WinDB
returns `"2025-12-31 20:00:00"` in UTC. `new Date("2025-12-31T20:00:00")` —
no offset — is parsed by ECMAScript as *local* time, and the result was then
read with `getUTC*()`. On a machine in US Eastern every date shifted by five
hours: a sale at 20:00 UTC on 31 December was reported in the **following tax
year**, and roughly a fifth of all transactions (anything after 19:00 UTC)
were priced with the **next day's** high/low. Everything now goes through
`parseWinDbTs()`. This never showed up in testing because CI runs in UTC,
where the offset is zero — the regression test sets `TZ=America/New_York` on
purpose.

**Xahau DEX purchases got no cost basis at all.** `TakerPays_*` — the buy
side of a DEX offer — was missing from the fetched column list while the
ledger code read it anyway, so `row.TakerPays_XRP ?? 0` was always `0` and
both acquisition branches were unreachable. Anything bought on the Xahau DEX
had no lot, so selling it later fell through to the `$0` basis / unknown-date
path and reported the entire proceeds as a short-term gain. The same gap
silently emptied the received side of every DEX row in the Koinly/CoinLedger
export. **Rows cached before this fix still lack those columns — run "Force
Full Re-sync" to re-fetch them.**

**The sync cursor could skip history permanently.** A pass stopped at a
50-page (50,000-row) ceiling in a way that was indistinguishable from
finishing, and the cursor then took the **maximum** timestamp across the
outbound and inbound passes. A wallet with six figures of outbound rows and a
handful of recent inbound ones truncated its outbound pass in 2020, completed
its inbound pass into 2026, and set the cursor to 2026 — orphaning six years
of outbound history on that run and every future one. The ceiling is now high
enough not to bind, reaching it is reported and flagged `truncated`, and
`computeSyncCursor()` takes the **minimum** across passes. As a side effect,
fully-synced dormant wallets stop re-downloading their whole history (at
Payment-Claim cost) on every run.

**FIFO consumed lots in arrival order, not acquisition order.** Internal
transfers correctly carry the original acquisition date across (holding-period
tacking), but the inherited lot was appended *last*, so a 2019 lot transferred
in today sat behind a 2024 lot the destination already held. Concretely: B
holds 1,000 XRP bought 2024-06-01 at $0.50, A transfers in 1,000 XRP acquired
2019-01-01 at $0.35, B then sells 1,000 XRP — reported $500 basis and
short-term, when true FIFO gives $350 and long-term. Lots are now kept ordered
by acquisition date.

**A wallet paying itself scrambled its own lot order.** `A → A` payments ran
the transfer path, draining the oldest lot and re-appending it, turning
subsequent FIFO into something closer to LIFO. Self-payments are routine
(regular-key rotation, ticket housekeeping). Now a no-op.

**Long-term started a day early.** `holdingDays > 365` is only equivalent to
"more than one year" outside leap years. Acquire 2024-01-01, sell 2025-01-01:
366 days, reported long-term (20% rate) when the one-year anniversary itself
is still short-term. Now a calendar comparison (`isLongTerm`).

**Missing price dates produced `NaN`, silent `$0`, or the newest price.**
Three different broken fallbacks: XRP had none at all, so one gap (the
embedded series has real interior gaps, and 2026 extends past its end) turned
**every total** in the app into `NaN` via `.reduce()`; XAH fell back to the
airdrop-basis field, which defaults to `0`, pricing sales at $0.00 and
fabricating losses; EVR reached for the last date in the entire series,
valuing a 2023 reward at a 2026 price. All now go through `lookupPrice()`,
which uses the **nearest** available date and records every substitution — the
Data Summary states plainly how many figures are estimates.

**Schedule D ignored the High/Low toggle.** It read `highRows`
unconditionally, so switching to "Daily Low" changed the Form 8949 tab and the
PDF but left Schedule D showing High totals — and Schedule D holds the figures
that go on the return.

**Switching to an empty tax year left the previous year's numbers on screen.**
Both Schedule D and the Comparison tab returned early without clearing, so a
year with no disposals still displayed the prior year's net gain under the new
year's heading.

**Two different definitions of "my wallet".** A live fetch classified against
the configured `WALLETS` list; the offline cache rebuild used only wallets
with cached rows. A wallet of yours that was configured but never synced
counted as yours during a fetch and as a stranger on the next app start, so a
transfer to it flipped between a non-taxable internal move and a fabricated
taxable disposal between one report and the next, over identical data. Both
paths now use `ownedWalletSet()` — the union.

**XRP amounts were divided by a million, deleting the largest transactions.**
WinDB's `Amount_XRP` for the XRP Ledger holds **whole XRP**, not drops —
verified against the real 4.6M-row cache with `xah-units-check.py`: 1,873 of
3,247 sampled XRPL values carry a decimal point, and drops are integral by
protocol. The code applied `if (qty > 1000) qty = qty / 1e6`, which was
accidentally correct below 1,000 XRP and silently destructive above it: a
12,000 XRP transfer became 0.012, failed the dust test, and was dropped from
the ledger and Form 8949 entirely. Precisely the largest, most material
transactions were the ones that disappeared, with nothing reporting a problem
— in one real cache, dozens of payments each worth six figures. Both chains are now read as whole units, with no magnitude heuristic
anywhere. Sub-1-unit dust is skipped **and counted**, and the count is shown
on the Data Summary.

**CSV columns could shift.** Currency codes are attacker-supplied 3-byte
values that may contain a comma — anyone can send you a token named `A,B` —
and several fields were written unquoted. All exports now go through
`csvField()`.

**Two report builds could run at once and double-count everything.** The
automatic startup rebuild takes minutes on a large cache. Clicking "View
Report From Cache" while it was still running started a SECOND pass over the
same shared arrays: the second's `resetLedgerState()` wiped what the first had
produced, then both passes kept appending disposals and lots, interleaved,
each one's FIFO consuming lots the other had just added.

On a real several million-row cache this produced a report claiming **nearly double the real count
transactions scanned** — more rows than the cache contains — with duplicated
Form 8949 lines and capital gains inflated to match. Nothing anywhere
objected; the totals simply looked like arithmetic.

Fixed three ways. `buildReportFromCache()` holds a single in-flight promise
and a second caller joins it rather than starting a competing run; `runFetch()`
waits for any in-flight build before touching the same state; and the button
is disabled while the startup rebuild runs. On top of that,
`verifyScannedRowCount()` asserts a hard invariant after every build — rows
processed must equal rows cached, exactly — and a mismatch puts a red
"DO NOT FILE THESE FIGURES" banner on the Data Summary rather than letting a
plausible-looking wrong number through. `test/tax-correctness.spec.js` fires
two builds concurrently and asserts the count still reconciles.

## Code review — crashes and performance at 4.6M rows

**The "All Transactions" export was guaranteed to fail.** Chunking fixed the
*freeze*, but the final `parts.join('\n')` still had to build the whole file
as one JavaScript string, and V8 caps strings at 536,870,888 characters. At
~225 characters per row that throws `RangeError` past ~2.4M rows; this cache
holds 4.6M. `Blob` now takes the array of chunks directly — no intermediate
string, no ceiling — and the blob URL is revoked instead of leaking ~1 GB per
export.

**The FIFO ledger was quadratic.** Exhausted lots were never skipped past, so
every disposal rescanned the whole spent prefix from index 0. Measured on this
machine at 100,000 acquire/dispose pairs: **21.6s before, 0.125s after** —
about 170×, and the growth curve is now linear rather than quadratic.

**Startup killed the renderer outright — blank white window, no error.** This
one reached the user, and took two attempts to fix properly.

The rebuild needs one global chronological stream across every wallet, because
FIFO is only correct in true time order. It produced that by loading every
cached row into an array and sorting it in JavaScript. At ~523 bytes per row
and ~several million rows on the Xahau side alone, that is ~2.2 GB of pure transient
buffer — plus, at the time, a ~3.0 GB `allTransactionHistory` array held for
the whole session. Against V8's ~4 GB renderer ceiling, the process was
aborted mid-rebuild.

Removing `allTransactionHistory` (below) was not enough on its own: the sort
buffer alone still exceeded what was available. The real fix was to stop
producing that order in JavaScript at all. SQLite has an index for it
(`idx_raw_tx_chain_ts` on `(chain, timestamp, wallet, tx_hash)`) and
`getChainRowsPage()` walks it with keyset pagination, so the renderer holds
**one 25,000-row page** and nothing else. Both entry points — the offline
rebuild and the post-fetch rebuild — now share one routine,
`streamChainIntoLedger()`, so they cannot drift apart again.

The fetch path had the same defect in a worse form: it held every selected
wallet's complete row set in a `Map` *and then* flattened it into the sort
array, roughly twice the whole cache. It now just counts rows per wallet and
streams from the cache like the offline path.

Two supporting changes: `allTransactionHistory` is no longer accumulated in
desktop mode at all (`KEEP_TX_HISTORY_IN_MEMORY`) — SQLite already holds those
rows, a counter replaces it for display, and the exports stream via
`forEachCachedTx()`; and `allDisposalsLow`, a complete second copy of every
disposal across every year that differed only in which already-present fields
were copied into `proceeds`/`gain`, was removed in favour of projecting the
low view from the master rows for the selected year.

Measured on a real 1,000,000-row cache: rebuild completes in 32s with a peak
heap of **390 MB** against a 4,084 MB limit — extrapolating to ~1.8 GB at 4.6M
rows. `test/memory-scale.spec.js` asserts the transient working set stays
bounded by page size rather than growing with the cache, which is the property
that actually failed; `test/db.test.js` covers the paging's ordering and its
stability across page boundaries when many rows share a timestamp.

A renderer crash is also no longer silent: `main.js` listens for
`render-process-gone` and shows a dialog naming the reason.

**Other hot-path work removed:** the EVR price fallback re-sorted ~920 keys on
every miss (~103µs per call, now hoisted); several multi-million-element sorts
used `localeCompare` where plain comparison is identical for these
fixed-format timestamps; and `buildRelevantTaxRows()` walked every cached row
in one unyielded loop, which is the same freeze that was already fixed
elsewhere — it now yields like the ledger builders do.

## Code review — main process, database, lifecycle

- **macOS: closing the window permanently broke the app.** `window-all-closed`
  closed the database *and* the HTTP server on every platform, while only
  `app.quit()` was guarded by the darwin check. On macOS the app stays in the
  Dock — so reopening it hit `ERR_CONNECTION_REFUSED` and every database call
  threw "connection is not open", recoverable only by fully quitting.
  Teardown moved to `will-quit`, which also covers Cmd+Q (previously it never
  closed the database at all).
- **Clearing the cache was not atomic, and deleted in the dangerous order.**
  Rows were deleted before cursors, in two separate implicit transactions. A
  crash or force-quit between them — plausible, since deleting 4.6M rows looks
  like a hang — left rows gone with cursors still claiming "synced through T",
  making all history before T permanently unfetchable, with no error. Now one
  transaction, cursor first.
- **`upsertSyncState` suppressed the timestamp it documented as unconditional.**
  The forward-only guard gated the whole update, so re-syncing a dormant
  wallet wrote nothing and "Last synced" kept showing a months-old date right
  after a successful sync.
- **No single-instance lock.** Two copies meant two SQLite writers on one file,
  and the second silently fell back to a random port — losing the fixed-origin
  `localStorage` the port pinning exists to protect.
- **Navigation could hand the preload bridge to a remote page.** Only
  `window.open` was intercepted; a same-window navigation would have carried
  `window.taxDB` — including `getAllRows()` and `clearAll()` — to another
  origin. Added `will-navigate` pinning, an `https`/`http`-only check before
  `shell.openExternal`, a real path-boundary check (the old one was a string
  prefix test, so a sibling `renderer-backup/` directory would have been
  served), and a `Host` header check against DNS rebinding.
- **Startup failures were invisible.** An unhandled rejection in `whenReady`
  meant no window, no error, no exit. Now reports and quits.

## Running in development

```bash
npm install
npm run rebuild   # rebuilds better-sqlite3's native binding for Electron's Node ABI
npm start
```

(`npm run rebuild` is only needed once after `npm install`, or after an
Electron version bump — `better-sqlite3` ships a binary built for plain
Node.js, which has a different native module ABI than Electron's bundled
Node, so it has to be rebuilt against Electron's ABI before `electron .`
can load it. `electron-builder` does this rebuild automatically as part of
packaging, so `npm run dist*` doesn't need it run first.)

## Testing

```bash
npm run test:db    # unit tests for the SQLite cache layer — no Electron, no display needed
npm run test:e2e   # launches the real packaged app end-to-end (needs a display; use xvfb-run -a on Linux/CI)
npm test           # both
```

`test/db.test.js` covers dedup, cursor forward-only advancement, cursor
survival across a simulated app restart, a full "fetch → close → reopen →
fetch again" cycle, and (new) `listCachedWallets()` returning every wallet
with cached data across both chains, deduplicated. `test/e2e.spec.js` boots
the actual Electron app (real window, real local HTTP server, real IPC, real
SQLite file on disk) and checks the window has no menu bar, keeps the
correct title, isn't loading over `file://`, and that a database write
through the UI's own code path actually lands on disk and shows up in the
Local Data panel. `test/fifo-ordering.spec.js` drives the real ledger
functions from inside the running app with a synthetic 3-wallet transfer
chain: it shows the old per-wallet-at-a-time approach lands on $0 cost basis
for the final disposal, then shows the merged chronological pass gets the
real $250 basis — a concrete regression test for the cross-wallet ordering
fix described above. `test/restart-persistence.spec.js` launches the real
Electron app twice against a shared profile directory — a genuine quit and
reopen — and proves the offline cache rebuild repopulates Form 8949 with no
Payment-Claim, and that the wallet list / term overrides saved to
`localStorage` survive, per the fixed-port section above.
`test/tax-software-export.spec.js` seeds a synthetic cache covering every
category the Koinly/CoinLedger export has to tell apart — an external
deposit and withdrawal, an EVR income row, a Xahau DEX trade, an XRPL
deposit and withdrawal, a transfer between two of the user's own wallets,
a `TrustSet`, and an XRPL DEX trade — and checks `buildRelevantTaxRows()`
keeps exactly the seven relevant rows and drops the rest, and that the
per-platform row formatters (date reformatting, income tagging) come out
right.

Note: `better-sqlite3`'s native binding has to be rebuilt for whichever
runtime last touched it — `npm run rebuild` (Electron's Node ABI) before
`npm start` / `npm run test:e2e` / `npm run dist*`, and plain `npm rebuild
better-sqlite3` (your system Node's ABI) before `npm run test:db`. Running
the wrong one first fails loudly with a `NODE_MODULE_VERSION` mismatch —
just rebuild for the runtime you're about to use and re-run.

## Building installers

Locally (produces whatever your current OS can build — e.g. only
`.AppImage` on Linux, since cross-building macOS/Windows targets from Linux
isn't supported by electron-builder):

```bash
npm run dist:linux   # .AppImage
npm run dist:mac     # .dmg  (must run on macOS)
npm run dist:win     # .exe  (must run on Windows, or Linux with wine — untested here)
```

Output lands in `dist-installers/`.

### Real installers for all three OSes: GitHub Actions

`.github/workflows/build.yml` builds each target on its native OS (macOS
runner → `.dmg`, Windows runner → `.exe`, Ubuntu runner → `.AppImage`) and
uploads them as workflow artifacts. Trigger it from the Actions tab
("Run workflow") or by pushing a tag like `v1.0.1`.

**Code signing is not configured.** The builds work without it, but macOS
Gatekeeper will show an "unidentified developer" warning and Windows
SmartScreen will show an "unrecognized app" warning on first launch —
normal for an unsigned app, not a bug. To remove those warnings:
- **macOS**: needs an Apple Developer ID certificate. Add it as the
  `CSC_LINK` (base64-encoded `.p12`) and `CSC_KEY_PASSWORD` repo secrets;
  electron-builder picks them up automatically. Full notarization is a
  further step beyond just signing — see electron-builder's macOS docs if
  you want the warning gone entirely rather than just replaced with a
  "signed but not notarized" one.
- **Windows**: needs a code-signing certificate, added the same way via
  `CSC_LINK` / `CSC_KEY_PASSWORD`.

Neither is required to use the app — signing only affects the first-run
OS warning, not functionality.

## Known scope limitations

- The cross-wallet FIFO ordering fix above is desktop-only. The plain-browser
  `form8949-xrp-xahau-2025.html` file still uses the original per-wallet,
  process-as-you-fetch approach (it has no local cache to merge from), so it
  can still understate cost basis for a transfer chain across three or more
  selected wallets. That file was deliberately left untouched by this build;
  porting the fix there would mean fetching all selected wallets' complete
  histories into memory before processing any of them, rather than streaming
  rows through as they arrive page-by-page.
- Windows `.exe` build has not been produced or run in this environment (no
  Windows machine available here) — it's config-complete and will build on
  the CI workflow's Windows runner, but hasn't been smoke-tested the way the
  Linux AppImage and the Electron app itself have been.
- macOS `.dmg` likewise config-complete but unbuilt/unrun outside CI, for the
  same reason.
- The Koinly/CoinLedger CSV export skips XRPL DEX trades (`OfferCreate` on
  the XRP Ledger, as opposed to Xahau) — see "Koinly / CoinLedger CSV
  export" above for why, and Koinly's native XRP Ledger wallet sync as the
  workaround for that specific gap.
- Neither CSV export captures on-chain network fees — the cached WinDB data
  doesn't retain them, so the Fee columns in both formats are always blank.
  Fees are small enough on both XRPL and Xahau that this is unlikely to
  matter, but it means neither export can claim to be fee-inclusive.

## The Holdings tab — checking whether "sales" were really sales

The engine decides whether a transfer out of a wallet is a taxable sale by
exactly one test: **is the destination address in the wallet list?** If it
isn't, the movement is booked as a fully taxable disposal at market value.

That is the only rule available to it, and it is wrong whenever the
destination is an address the user controls but hasn't listed — an exchange
deposit address, a hardware wallet added later, a wallet used once. The
resulting Form 8949 looks completely ordinary; there is no error, just a large
gain that shouldn't be there.

The Holdings tab makes that checkable:

- **Holdings by wallet** sums the FIFO ledger's *unconsumed* lots per wallet
  and asset, with cost basis and current value at the latest embedded price.
  Because it's built from what the engine believes is left over, it can be
  compared directly against a block explorer. A wallet the tool shows as empty
  that really holds a balance means a transfer out of it was booked as a sale,
  and the gap is the size of the error.
- **Where the disposals went** groups every disposal for the selected tax year
  by destination address, ranked by proceeds, with each one's share of the
  total. Any address near the top that is actually the user's is the cause of
  the overstatement — adding it to the wallet list and rebuilding reclassifies
  those movements as non-taxable transfers.

Both tables export to CSV. The destination export includes an empty
"Is This Actually Yours?" column to fill in while working through the list.

### The round-trip column — identifying an address without recognising it

**It is opt-in, and that is a bug fix, not a preference.** The scan reads every
cached row — 4.6M of them on one real machine. Running it inline inside
`renderHoldings()` meant the Holdings page sat on "Scanning the cache for
return flows…" and never painted, which is the same blank-page failure the app
had already been through once with the OOM kill. The tables are built from the
in-memory ledger and now render immediately; the flow column reads "not scanned
yet" until the scan is asked for, reports progress while it runs, and the
result is cached until the next rebuild (a rebuild can change the owned set,
so a stale result would be worse than none).

Working through a list of unfamiliar addresses by hand is slow and error-prone,
and the cache already contains the evidence: **you do not receive money back
from someone you sold to.** `computeCounterpartyFlows()` scans the cache once
and, for every address outside the owned set, records how much went out to it
and how much came back from it, kept in separate directions.

An address that has paid you back is flagged **ROUND TRIP** — it is essentially
always your own wallet or your own account somewhere. A genuine buyer shows as
one-way. Dust below `DUST_MIN_UNITS` is excluded on the return leg too, so a
0.4-XRP spam payment cannot turn a real sale into a false round trip. The
column appears in the destinations table and in its CSV export.

## Loading wallets: the classified CSV

`Address,Type,Label,Date Lost,Gift Recipient`, where Type is `active`, `lost`,
`gift` or `mine`. A plain one-address-per-line list with no header still works
and is treated as all-active, so nothing that used to import stops importing.

The parser is tolerant where tolerance is safe and strict where it is not. It
reads quoted fields properly (`"Daughter, One"` stays one field), accepts a
header in any column order under a range of aliases, normalises type values —
`LOST KEY - Postnode`, `Exchange`, `Transfer Only` all resolve — and takes
`MM/DD/YYYY` as well as `YYYY-MM-DD`. It will **not** guess at an unrecognised
type, a `lost` row with no date, or a `gift` row with no recipient. Those
become errors naming the line, because silently downgrading a `lost` row to
`active` puts phantom sales back on the return, which is the failure this
whole feature exists to prevent.

Nothing is applied until a preview dialog is confirmed, and every apply first
clears the address from all four lists before placing it in one — so
re-importing a file that demotes an active wallet to `gift` actually removes it
from the fetch list and from the current selection, rather than leaving it in
both.

`Export current setup` writes the same shape back out, so the file doubles as
backup and restore. The shareable-copy export deliberately does not carry these
lists.

### Marking an exchange address `mine` — and the trap in doing so

Yes, an exchange deposit address should be `mine`: sending coins to your own
Uphold/Kraken/Coinbase deposit address is a transfer, not a sale.

But the inbound direction had a serious defect. The acquisition branch was
guarded by `dest === wallet && !ownSrc`, and marking the exchange address makes
`ownSrc` TRUE — so an arrival from it matched nothing at all. There was no
outbound side to have handled it either, because the address is never fetched.
**Every coin withdrawn from that exchange entered the ledger with no lot**, and
the eventual sale was then computed at $0 basis and short-term: the maximum
possible tax, caused by correctly classifying an address.

Inbound from a never-fetched owned address now routes through
`ledgerTransferIn` with a basis fallback, which handles both shapes:

- **Round trip** — coins you deposited come back carrying their *original*
  basis and acquisition dates, so the holding period tacks and the round trip
  is a no-op.
- **Bought on the exchange** — any excess over what you deposited takes the
  market price on the arrival date, recorded in `inferredBasisRows` and
  disclosed on the Data Quality panel as "inferred, not observed".

The fallback is passed *only* for never-fetched sources. There a shortfall is
structural — the app cannot see a purchase made inside an exchange. For a real
fetched wallet a shortfall means missing history, so it still falls through to
$0 basis, because inventing basis there would understate the gain.

Two related fixes fall out of the same branch: an EVR arrival from your own
exchange account is no longer booked as Evernode reward *income*, and the
deposit leg is no longer a disposal.

**None of this replaces the exchange's own records.** The inferred figure is a
reasonable estimate with an arrival-date holding period, not a substantiated
purchase price — and whatever was *sold* on the exchange remains taxable and
invisible to this tool.

### Which types are fetched, and why the other two must not be

| Type | Taxable when coins leave? | Fetched? |
|---|---|---|
| `active` | yes, unless the destination is yours | **yes** |
| `lost` | no, after the loss date | **yes** |
| `gift` | no | **no** |
| `mine` | no | **no** |

The two "no"s are the point, not an optimisation.

A **gift** address belongs to someone else. Fetching it would drag that
person's entire financial history into this file, and it is unnecessary: the
gift is fully described by the outgoing payment from the user's own wallet,
which is already cached.

A **mine** address is typically an exchange deposit address whose hot wallet
carries tens of millions of transactions. Fetching one would cost a fortune in
Payment-Claim and blow up the local cache. It is used for the sale-vs-transfer
decision only.

A **lost** wallet, by contrast, *must* be fetched — the drainage and the
stranded balance are only visible from its own transaction history.

The Setup list badges every address ACTIVE / LOST / GIFT / MINE. Gift and mine
chips render greyed and are not selectable, and `Select All` cannot pick them;
rendering them rather than hiding them is deliberate, so an imported address
never appears to have vanished.

## A cached row is a PERSPECTIVE, not a fact

The defect that let the millions of dollars survive being diagnosed.

Exchanges and bridges use **one shared address for every customer**, separated
by destination tag. Classify one `active` and its entire public history gets
fetched. The user then works out which address it is and reclassifies it — and
**nothing changes**, because `streamChainIntoLedger` pages over the whole cache
**by chain, not by wallet list**. The stale rows kept being processed from that
address's perspective.

Worse, the damage propagated silently. The bridge's onward transfers to a
Coinbase address the user had correctly marked `mine` were booked as transfers
(not sales, so nothing looked wrong) and piled **hundreds of thousands of XRP of phantom
holdings** into it — coins the user had never sent.

Every cached row is a *perspective*: "wallet W's view of transaction T". It may
be processed only if W is a wallet whose coins are actually the user's to
dispose of — `active` or `lost`, i.e. `WALLETS`. `mine` and `gift` addresses
are classification-only, and an address removed from the list has been judged
not to be the user's; in every one of those cases its own transaction history
is somebody else's business, cached or not.

Skipped rows are still **counted**, so the row-count invariant that catches
double-processing keeps working instead of firing a false "DO NOT FILE" alarm,
and the count is disclosed on the Data Quality panel. `Purge cached data for
addresses you no longer own` on the Setup tab reclaims the disk space; it
cannot change any figure, because those rows were already being read past.

### Exchange balances leave the portfolio total

A balance against a `mine` address is not self-custody — it is what was **sent
to an exchange and never came back**, which for most people means it was sold
there. It now has its own section, excluded from the headline portfolio value,
saying plainly that the exchange's own records are the only thing that can
settle what happened to it.

## The wallet-activity diagnostic — finding a misclassified address

On a real run this produced **millions of dollars of 2025 proceeds against a a small fraction of that gain**
from a a portfolio a fraction of that size, across **over a thousand distinct destination addresses, most of
which appeared once or twice.**

That combination is diagnostic. Proceeds ≈ basis means every disposal consumed
a lot acquired at almost the same price — funds passing *through* a wallet, not
being sold from it. And over a thousand counterparties in one year is not how a person's
wallet behaves.

The cause is an address that is **not a personal wallet** classified as
`active`: a bridge, an exchange hot wallet, a payment service. The app then
fetches its entire public history and books every payment it makes to any
stranger as the user's own taxable sale.

**No amount of price or FIFO correctness catches this**, because each
individual disposal is computed correctly. The only available signal is the
shape of the activity, so `walletFlowStats` accumulates it during the build at
no extra cost:

- **Distinct counterparties** — the decisive one. A personal wallet deals with
  a handful of addresses. A service deals with thousands, most exactly once.
  The Set is capped at 5,000; past that the point is made.
- **Throughput ratio** — inbound quantity ÷ outbound quantity on the dominant
  asset. Near 1 means funds pass through rather than accumulating.

**The first version of this heuristic cried wolf, and the retune matters.** It
flagged anything with ≥200 counterparties, or ≥50 combined with pass-through,
and duly convicted a genuine main wallet with around a hundred counterparties built up over
five years. Pass-through is *normal* for an Evernode host — rewards arrive and
get swept onward — so it should never have been evidence. And a false positive
here is expensive: it tells someone to delete a real wallet, which drops real
disposals off their return.

The address that actually caused the damage had **over a thousand counterparties in a
single year, 71% of them seen once or twice**. So the test needs *both* scale
and churn: `peers >= 500 && oneTimeShare >= 0.6`, where `oneTimeShare` is the
fraction of counterparties dealt with exactly once. A person reuses addresses —
their exchange, their own wallets, the same handful of people. A service meets
each customer once and never again. Pass-through is still reported, but it does
not vote.

The verdict reads "worth checking", not "not your wallet", and the remedy
depends on a fact only the user has:

| Situation | Do this |
|---|---|
| You have an account at that service (exchange or bridge deposit address) | mark it **`mine`** |
| The address has nothing to do with you | remove it from the list |
| It really is your own busy wallet | leave it **`active`**, ignore the notice |

Earlier guidance here said to remove such an address outright. That was wrong
for the common case: deleting a deposit address you genuinely use turns every
transfer to it back into a taxable sale.

Two supporting changes: labels are now kept for **every** address type (the
import used to discard them for `active` and `mine`, which is backwards — a
table of 36-character r-addresses is unreadable without them), and the
destinations CSV carries **quantity and source wallet**, since USD proceeds
alone hide how many coins actually moved.

## Form 1099-DA does not close out the exchange side

A natural assumption, and wrong in a way that costs money:

- For **2025**, brokers report **gross proceeds only**. No cost basis.
- Basis reporting begins with **2026** transactions.
- Even then, assets **transferred in from a self-custody wallet are
  non-covered** — the exchange never saw the purchase and cannot report what
  was paid.

That last point is decisive here, because it describes this user's entire
pattern: buy in a wallet, send to an exchange, sell there. The 1099-DA will
show what those coins sold for and nothing about what they cost. Put those
proceeds on a return with no basis and the whole amount is taxed.

So the sent-to-exchange section is not a loose end to ignore; it is the input
to the basis side of those 1099-DA lines. `Cost Basis Handoff CSV` emits the
actual FIFO lots sitting against each `mine` address — quantity, original
acquisition date, unit cost, total basis, and whether each lot is long- or
short-term — oldest first, the order FIFO will consume them.

The property that makes this work is one the ledger has had since early on:
`ledgerTransferIn` carries each consumed lot's **original** acquisition date
and cost to the destination rather than stamping the transfer date. Without
that, every coin sent to an exchange would silently become short-term.

Rev. Proc. 2024-28 requires basis to be tracked wallet by wallet from
1 January 2025, which is exactly what this ledger does — so the same file is
the substantiation for that allocation.

## Holdings export

`Holdings CSV` and `Holdings PDF` (jsPDF, client-side, no Payment-Claim). The
PDF keeps the three categories in separate sections with their own subtotals —
self-custody, sent-to-an-exchange, and stranded in a lost wallet — because a
single blended "total" is precisely the misleading number this tool exists to
stop producing. Only self-custody appears in the headline figure.

## Lost wallets — the fourth category

Three Evernode host accounts lost their private keys when the server holding
them crashed. They are still live on the network: hooks and fees keep spending
XAH out of them and will until the balances reach zero, and nobody can stop it.

Two separate errors follow if this is not modelled.

1. **Every involuntary outflow is booked as a taxable sale at market value.**
   The user did not sell, did not authorise it, and received nothing — there
   are no proceeds. Left alone this manufactures gains out of a loss, every
   year, until the accounts drain.
2. **The stranded coins are counted in the portfolio**, overstating what the
   user actually owns. They are on-chain but unspendable by anyone.

`lostWallets` carries `{ addr, lostDate, note }`, and **the date is doing real
work**. Activity before it was ordinary activity the user controlled and is
taxed normally; only spending on or after it is treated as involuntary. This is
deliberately not "exclude the whole wallet" — these accounts were funded and
used before the crash, and that history is real.

Post-loss outflows go to `pushLostSpend()`, which consumes the FIFO lots (the
coins genuinely left) but writes to `allLostSpendRows` rather than
`allDisposalsHigh`. No Form 8949 line, no gain. The Holdings tab splits lost
wallets out of the portfolio total and reports them separately, with the basis
still stranded and the basis already drained, by year.

### What this deliberately does NOT do: claim a deduction

There isn't one. Three doors, all closed:

- **Casualty loss** (§165(c)(3)) is limited to federally declared disasters —
  and, from 2026, state-declared ones. The One Big Beautiful Bill Act made that
  limitation permanent. A server crash is neither.
- **Theft loss** requires criminal intent. Losing a key is not theft.
- **Worthlessness / abandonment** (§165(a), Treas. Reg. §1.165-2) fails twice
  over. It requires the property to be *worthless*, and inaccessible is not the
  same as worthless — the XAH still trades. It also requires an affirmative act
  of abandonment, which is impossible without the key. And per IRS CCA
  202302011, even where it succeeds, for an individual the deduction lands in
  miscellaneous itemized deductions, which §67(g) suspends — a suspension the
  OBBBA made **permanent**, not merely extended through 2025.

So the basis simply stays unrecognised. The job of this section is therefore to
**preserve and document** it — which is what any future deduction would have to
substantiate, and which cannot be reconstructed once the lots are consumed. The
Lost Wallet Basis Report CSV is that record.

One caveat the app cannot decide: if the accounts were run as a **trade or
business** rather than as an investment, an abandonment loss on business
property is an ordinary loss under §165(a) and is *not* a miscellaneous
itemized deduction, so §67(g) would not reach it. Whether running Evernode
hosts rises to a trade or business is a facts-and-circumstances question for a
preparer, not for this tool. It is flagged, not assumed.

### The genuinely ambiguous case

A DEX offer placed from a lost wallet is the one call the app refuses to make
silently. An exchange of property is normally a realization event even when
involuntary, but the user controls neither side and cannot reach what comes
back. Those rows are kept off Form 8949, listed in the CSV, and surfaced in the
UI with an explicit warning to raise them with a preparer. In practice these
host accounts do not trade, so the count should stay at zero.

### The exports again

Both tools would re-create the phantom sale on import, so the drainage is
tagged: Koinly `lost`, CoinLedger `Casualty Loss` — both of which remove the
asset from the balance without realizing a gain or a loss, matching the
treatment here. A payment made *before* access was lost is still exported
unlabelled, i.e. taxable.

## Gifts — the third category

A gift is neither a sale nor a transfer between your own wallets, and the two
existing categories both get it wrong:

- Left unmarked, a gift is booked as a **fully taxable disposal at market
  value** — the same defect as an unlisted exchange address.
- Marked as **Mine**, the phantom sale disappears but the gifted coins stay in
  your holdings for ever, and a later disposal consumes lots you no longer own.

So `giftAddresses` is a third classification. A gift consumes the FIFO lots —
the coins really did leave — but produces **no Form 8949 line and no gain**,
because giving property away is not a realization event for the donor (and
gives no deduction either).

What it records instead is what nobody can reconstruct once the lots are gone
(`pushGift()`):

| Recorded | Why |
|---|---|
| your cost basis in the lots given | the recipient's **carryover basis** for computing a future gain (IRC §1015(a)) |
| fair market value on the gift date | their basis for computing a future **loss**, if FMV was below your basis that day (the "dual basis" rule) |
| your holding period (ST/LT/VARIOUS) | it **tacks** onto theirs — a long-term lot stays long-term in their hands |
| earliest lot acquisition date | what they will need on their own Form 8949 |

The gift log groups by **recipient and year**, not by address, because that is
the unit the annual exclusion is measured in — one person may have been given
coins at several addresses, and it is the per-person, per-year total that
decides whether **Form 709** is required. `GIFT_ANNUAL_EXCLUSION` carries
$17,000 (2023), $18,000 (2024) and $19,000 (2025, 2026); a year over the limit
is highlighted. Exclusions double for a married couple electing gift-splitting,
which the app does not attempt to model. None of this is tax advice.

Gift addresses are, like `transferOnlyAddresses`, **classification-only and
never fetched**, and the two lists are mutually exclusive — marking an address
one way clears the other.

**The Koinly and CoinLedger exports tag gifts too.** Both tools apply the same
rule this app does, so an untagged outgoing gift would be re-booked as a
disposal at market value on import — fixing Form 8949 here and leaving the
export alone would have moved the error rather than removed it. Koinly gets
`gift` in its Tag column, CoinLedger `Gift Sent` in its Type column, and a
genuine sale is still exported unlabelled, i.e. taxable.

### Open questions the code cannot settle on its own

These came out of the review and need real data or a judgement call. None is
silently assumed — each is either surfaced in the UI or listed here.

- ~~**`Amount_XRP` units differ between the two chains**~~ — **RESOLVED.** Run
  `xah-units-check.py` against the real cache and both columns hold WHOLE
  units, not drops: 33 of the sampled Xahau values and 1,873 of the sampled
  XRPL values carry a decimal point, and drops are integral by protocol. The
  Xahau path was already correct (the "in drops" comment was stale and has
  been fixed). **The XRPL path was wrong** and has been corrected — see below.
- **`OfferCreate` is treated as a completed trade at the full offer size.**
  `tesSUCCESS` on an `OfferCreate` means the offer was *placed*, not filled,
  and `TakerGets` is the offer's terms rather than the realized amount. So a
  limit order that never filled (and was later cancelled — `OfferCancel` isn't
  fetched) still books a disposal, while a resting offer filled by someone
  else's transaction produces no row at all under your account. This is a
  data-source limitation, not a coding slip: fixing it needs transaction
  metadata (`AffectedNodes` / balance changes) that isn't being retrieved.
- **All inbound EVR is booked as ordinary income.** There's no check for
  whether the sender is an Evernode reward distributor, so EVR bought on an
  exchange and withdrawn to a wallet is reported as income on Schedule 1.
- **The dust threshold is a flat `>= 1.0` unit count** across XRP (~$1.36),
  XAH (~$0.014) and EVR (~$0.085). Fractional Evernode hosting rewards fall
  below it, so they're neither reported as income nor given a basis lot —
  which then makes their eventual disposal $0-basis and short-term.
- **"Daily Low" is not a symmetric scenario.** Acquisition lots always take
  the daily *high*, so the low view is low proceeds against high basis — the
  most pessimistic combination, not a lower bound.
