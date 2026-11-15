# Security and privacy

## What this app holds

Everything stays on the machine it runs on:

- **Transaction cache** — a SQLite database in the OS application-data
  directory (`~/Library/Application Support/…` on macOS). It contains every
  transaction for every wallet you have synced.
- **Wallet list and classifications** — browser `localStorage`, scoped to the
  app's own fixed origin.
- **Your Payment-Claim** — held in memory for the duration of a fetch and
  **never written to disk**, never included in any export, and stripped from
  the "shareable copy" export.

Nothing is transmitted anywhere except the WinDB/Dhali queries you explicitly
run and, since 1.10.8, the on-chain balance check's read-only ledger queries
(below). CoinGecko price data is embedded rather than fetched.

### The on-chain balance check (1.10.8)

After each build the app asks a full-history ledger server for the balance of
every fetched wallet, and "Explain" asks for one wallet's transaction history.
What that means for privacy and safety:

- **What is sent:** since 1.10.10 the check reads WinDB through Dhali by
  default, with the same Payment-Claim and the same endpoint as the download,
  so nothing goes anywhere the download does not already go: your wallet
  addresses, in a few small read-only SQL queries. Addresses are checked
  against the address alphabet before they are placed in a query. If you
  switch the source to the public ledger servers, your addresses and ledger
  numbers go to `xrplcluster.com` (XRPL) and `xahau.network` (Xahau), which
  can see which addresses are being looked up from your IP address. Turn off
  "run automatically after each build" on the Holdings tab if you do not
  want either to happen without a click.
- **How:** from the main process (`ledger-rpc.js`), never from the page. The
  renderer's `connect-src` still allows WinDB only. `ledger-rpc.js` accepts
  only https, only the hosts `xrplcluster.com`, `s2.ripple.com`,
  `xahau.network` and `run.api.dhali.io`, and only read-only methods
  (`account_info`, `account_lines`, `account_objects`, `account_tx`,
  `amm_info`, `book_offers`, `ledger`, `server_info`). Nothing in it can submit or sign.
- **The Payment-Claim** is attached only when you set a Dhali server for the
  check, and only to `run.api.dhali.io`. It is never sent to the public
  servers, never logged, and never stored. `test/ledger-rpc.test.js` pins all
  of this.

### XRPL trades read from the ledger (1.10.14)

"Read XRPL trades from the ledger" on the Setup tab asks a full-history XRPL
server for every transaction of each of your XRPL wallets (`account_tx`,
read-only), and after the first read it runs by itself at the end of each
download. It uses the server set in the on-chain check's settings, which is
the public cluster `xrplcluster.com` unless you chose another. So **your
wallet addresses go to that server**, which can see which addresses are being
looked up from your IP address. Nothing else is sent: no Payment-Claim (unless
the server you set is Dhali), no report data. It goes through the same
main-process route as the balance check (`ledger-rpc.js`), with the same host
and method lists. It does not run until you press the button once, and
"Remove what was read" undoes it.

A token's name is chosen by whoever issued it and is shown throughout the app.
It is reduced to letters and digits once, where it is read
(`ltCurrencyCode`); anything else is kept as its hex code. A test checks that
markup in a token name cannot reach the page.

### The command-line scripts

`scripts/verify-xrpl.js` and `scripts/xrp-bridge.js` used to send the
Payment-Claim header to whichever node they were using, xrplcluster.com or
xahau.network included, whenever `DHALI_PAYMENT_CLAIM` was exported. Since
2026-11-14 they send it only when the endpoint is `https://run.api.dhali.io/…`.
`test/verify-xrpl.test.js` runs the real request function against public,
look-alike and Dhali endpoints to check this. If you ran either script with
the claim exported and without a Dhali endpoint before that date, issue a
fresh claim. `scripts/trustlines.js` goes through `ledger-rpc.js` and was
never affected.

## Before you share a build or a working copy

Run:

```
node scripts/verify-clean.js
```

It fails if a wallet list, a Payment-Claim, personal identifiers, or exported
data files have crept into the tree. It runs in CI on every push.

A wallet list is personal data: a set of XRPL addresses tied to a name
identifies a person and reveals everything they hold. Treat it the way you
would treat a bank statement.

## Dependency advisories — what actually ships

`npm audit` is unreliable for this project **in both directions**, so read
it against what the build actually contains rather than at face value.

**What ships in the DMG:** the Electron runtime, the one production
dependency (`better-sqlite3`), and the files under `renderer/` — including
the vendored `renderer/vendor/jspdf.umd.min.js`. Nothing else from
`node_modules` is packaged.

**Under-reporting.** `npm audit --omit=dev` reported zero vulnerabilities
while the app was running an Electron that had been end-of-life for
seventeen months. Electron is a devDependency by convention — electron-builder
bundles it — but it is the runtime inside the DMG. Always audit the full tree.

**Over-reporting.** In November 2026 the full audit showed a *critical* in
`dompurify`, reaching the tree through `jspdf`. It was easy to conclude the
vendored jsPDF therefore ships DOMPurify. It does not, and that conclusion
was briefly written down as fact. The vendored bundle contains only a lazy
*loader* for DOMPurify — it tries `window.DOMPurify`, then `require`, then
AMD, and otherwise rejects — and none of those three routes exists in this
renderer (`contextIsolation` on, `nodeIntegration` off). The built
`app.asar` contains no reference to `node_modules/dompurify` at all. The app
also never calls jsPDF's `.html()`, the only path that would reach for it.
`test/supply-chain.test.js` keeps both facts true.

### Accepted, with an exit condition

| Advisory | Severity | Reaches | Why it stays |
|---|---|---|---|
| `minimatch` globparts DoS (GHSA-g3hv-75wg-m249) | moderate | `electron-builder → app-builder-lib → @electron/universal@2.0.3 → minimatch` | Build-time only; never ships. Exploiting it needs attacker-controlled glob patterns, and the only patterns this matcher sees are our own `package.json` build rules. |

The only automatic fix offered is `npm audit fix --force`, which
**downgrades electron-builder to 24.13.3** — back into the line carrying the
advisories cleared in September 2026. Not taken.

The clean fix exists: `@electron/universal` 3.0.4+ drops `minimatch`
entirely. But `app-builder-lib` pins `@electron/universal` to **exactly**
`2.0.3`, and that package is what evaluates the `x64ArchFiles` rule deciding
which architecture's native binary survives into the universal app. Forcing
an untested major-version override into that decision could ship a DMG that
works on Apple Silicon and fails on Intel, with nothing on an arm64 Mac to
show it. **Exit condition:** when `app-builder-lib` moves off the exact
`2.0.3` pin, these clear on an ordinary update.

### Checking

```
npm audit                 # full tree; read the table above before acting
npm test                  # includes the supply-chain assertions
```

## Reporting a vulnerability

Open a GitHub issue for anything non-sensitive. For something that would put
users' funds or privacy at risk, use GitHub's **private vulnerability
reporting** (Security → Report a vulnerability) rather than a public issue.

## Threat model, briefly

This app never has access to a private key or a seed, cannot sign or send a
transaction, and asks for neither. Any build that requests a seed phrase is
not this software.
