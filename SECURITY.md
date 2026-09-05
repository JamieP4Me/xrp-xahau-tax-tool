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
run, and CoinGecko price data is embedded rather than fetched.

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

## Reporting a vulnerability

Open a GitHub issue for anything non-sensitive. For something that would put
users' funds or privacy at risk, use GitHub's **private vulnerability
reporting** (Security → Report a vulnerability) rather than a public issue.

## Threat model, briefly

This app never has access to a private key or a seed, cannot sign or send a
transaction, and asks for neither. Any build that requests a seed phrase is
not this software.
