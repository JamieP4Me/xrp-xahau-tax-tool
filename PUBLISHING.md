# Publishing this project

Two separate jobs, in this order:

1. **Build a clean DMG** you can hand to someone — no wallets, no cache, no
   Payment-Claim, no cost basis of yours.
2. **Publish the source to GitHub** with the documentation, and attach that DMG
   to a release.

Do them in that order. Building the DMG from a clean tree proves the tree is
clean before you push it anywhere public.

---

## Part 1 — A clean DMG

### What actually carries your data

Three places, and only the first is inside the app bundle:

| Where | What | In the DMG? |
|---|---|---|
| `renderer/index.html` → `let WALLETS = [...]` | your wallet list | **yes, if not empty** |
| `localStorage` (this Mac, app origin) | wallet list, classifications, labels | no |
| `~/Library/Application Support/XRP & Xahau Tax Tool/tax-data.sqlite3` | every cached transaction | no |

`WALLETS` now ships empty and the XRP fallback basis ships at `0.00`, so a
build made from a clean checkout carries nothing. **The risk is your working
copy**, where you may have pasted a list back in at some point.

### Steps

```
cd ~/Projects-xrp-xahau
node scripts/verify-clean.js
```

It must print **"Clean. Safe to publish."** If it fails it names the file and
the offending strings. Fix those before going further — do not skip it, and do
not build "just this once" from a tree that fails.

Then:

```
export PATH="/opt/homebrew/opt/node@20/bin:$PATH"
node -v            # must print v20.x
npm ci
npm run rebuild
npm run dist:mac
```

**That export lasts only for the terminal window you type it in.** Open a new
window and you are back on whatever Homebrew has made the default `node`,
which moves forward without asking. Put the line in `~/.zshrc` and stop
thinking about it:

```
echo 'export PATH="/opt/homebrew/opt/node@20/bin:$PATH"' >> ~/.zshrc
```

If you skip it, `npm ci` now stops immediately with a one-line explanation
(`scripts/check-node.js`, wired in as `preinstall`) instead of several hundred
lines of C++ errors from better-sqlite3 failing to compile against a Node
whose V8 has dropped the APIs it uses.

The DMG lands in `dist-installers/`. Note that `npm ci` (not `install`)
installs exactly what the lockfile says, which is what you want for something
you are handing to other people.

### Verify the DMG before you hand it over

Do not trust the build; check it. Mount it and grep the packaged renderer for
anything address-shaped:

```
hdiutil attach "dist-installers/XRP & Xahau Tax Tool-1.0.0.dmg" -mountpoint /tmp/xrpdmg
grep -aoE 'r[1-9A-HJ-NP-Za-km-z]{24,34}' \
  "/tmp/xrpdmg/XRP & Xahau Tax Tool.app/Contents/Resources/app.asar" \
  | grep -v '^rEXAMPLE' | sort -u | head
hdiutil detach /tmp/xrpdmg
```

**No output is the pass condition.** Anything printed that does not start with
`rEXAMPLE` is a real address inside the shipped app.

### Then test it as a stranger would

The app keeps its data in a per-user directory, so installing your own DMG on
your own Mac still shows *your* cache. That is your machine, not the DMG — but
it means you cannot see what a new user sees without isolating the profile.

Use Chromium's `--user-data-dir` switch, which Electron honours for
`app.getPath('userData')`. That is where both the SQLite cache **and** the
`localStorage` holding the wallet list live, so one flag moves everything:

```
cd ~/Projects-xrp-xahau
rm -rf /tmp/xrp-fresh-profile
APP=$(ls -td "$PWD"/dist-installers/mac-universal/*.app | head -1)
"$APP/Contents/MacOS/$(basename "$APP" .app)" --user-data-dir=/tmp/xrp-fresh-profile
```

You should get: an empty wallet list, no cached transactions, XRP fallback
basis `0.00`, and an empty Payment-Claim field.

**Do not use `HOME=/tmp/... open -a …`.** Two reasons: `open` hands the launch
to launchd, which uses your real environment and drops the variable; and even
run directly, macOS resolves the home directory through the account database
rather than `$HOME`, so the app finds your real profile anyway. It looks like a
clean-profile test and is not one.

Afterwards, `rm -rf /tmp/xrp-fresh-profile` — it is a real profile directory,
just an empty one.

### Note on Gatekeeper — and why "damaged" is not the same as "unverified"

There are two different macOS refusals, and they need different advice.

**"Apple could not verify …"** is the ordinary unsigned-app prompt.
Right-click → **Open** gets past it.

**"… is damaged and can't be opened. You should move it to the Trash."** is
what you get when a downloaded app has *no signature at all*. Right-click →
Open does **not** bypass this one, so a user following the usual advice is
stuck and reasonably concludes the download is broken. It is not.

You will never see this locally, because quarantine is only applied to
downloaded files — which is exactly why it surfaces the first time someone
else tries your release.

The build now ad-hoc signs the app (`scripts/adhoc-sign.js`, wired in as
electron-builder's `afterPack` hook). Ad-hoc signing does not make the app
*trusted* — only a paid Developer ID plus notarisation does that — but it
gives the bundle a valid signature, so macOS shows the truthful "unidentified
developer" message and right-click → Open works as documented. On Apple
Silicon it is close to mandatory anyway: arm64 requires every binary to carry
at least an ad-hoc signature to execute.

Either way, this always works:

```
xattr -dr com.apple.quarantine "/Applications/XRP & Xahau Tax Tool.app"
```

Full signing and notarising needs a paid Apple Developer account ($99/yr).
Worth it if you expect non-technical users; otherwise say so plainly in the
release notes so nobody thinks it is a virus.

---

## Part 2 — Publishing to GitHub

### What is already in place

| File | Purpose |
|---|---|
| `LICENSE` | MIT, plus a not-tax-advice disclaimer |
| `.gitignore` | node_modules, builds, **and every export filename the app produces** |
| `SECURITY.md` | where data lives, how to report a vulnerability |
| `scripts/verify-clean.js` | the privacy gate |
| `.github/workflows/ci.yml` | runs the gate, then both test suites, on every push |
| `README.md` | the engineering documentation |

The `.gitignore` deliberately lists the app's own export filenames
(`Holdings-*.csv`, `Basis-Ledger-*.csv`, and the rest). Those are the files most
likely to be sitting in your working copy, and every one of them contains
addresses, balances and cost basis.

### Create the repository

Do **not** `git init` in a directory that has ever held your data without
checking first. Start from a verified-clean tree:

```
cd ~/Projects-xrp-xahau
node scripts/verify-clean.js || echo "STOP — fix before continuing"
```

Then:

```
git init
git add -A
git status          # read this list. Every file on it becomes public.
```

Read that list properly. Look for `.sqlite3`, any CSV or PDF, and anything with
a date in the filename.

```
git commit -m "Initial public release

Offline IRS Form 8949 / Schedule D generator for XRP Ledger and Xahau.
Wallet classification (active / lost / gift / exchange), FIFO cost basis
with holding-period tacking, and Koinly / CoinLedger export."
```

Create the repo on GitHub (**public**, and do **not** let it add a README,
.gitignore or licence — you have them), then:

```
git branch -M main
git remote add origin https://github.com/<you>/xrp-xahau-tax-tool.git
git push -u origin main
```

### Immediately after the first push

1. **Settings → Security → enable private vulnerability reporting**, and enable
   secret scanning and push protection. Push protection is the one that would
   stop a Payment-Claim from being committed.
2. **Check the Actions tab.** The clean check runs first; if it goes red, the
   tree carries something it should not — and it is now public, so act fast
   (see below).
3. Add repository topics: `xrp`, `xrpl`, `xahau`, `evernode`, `crypto-tax`,
   `form-8949`, `electron`.

### If you ever push something you should not have

Deleting the file in a later commit **does not remove it** — it stays in the
history and in every fork and clone. The only real remedies:

- If it is a credential (a Payment-Claim, an API key): **revoke it first**, then
  worry about the history. Rotation is what actually protects you.
- If it is data: rewrite the history with
  [`git filter-repo`](https://github.com/newren/git-filter-repo) and
  force-push, then delete and recreate the repo if it was public for more than
  a moment. Assume anything that was public for even a minute was scraped.

The `verify-clean.js` gate exists so this never comes up.

### Cutting a release with the DMG

```
git tag -a v1.0.0 -m "v1.0.0"
git push origin v1.0.0
```

Then GitHub → Releases → Draft a new release → pick the tag → attach
`dist-installers/XRP & Xahau Tax Tool-1.0.0.dmg`.

Say three things in the release notes: that the build is **unsigned** and how to
open it anyway, that it needs a **Dhali Payment-Claim** to fetch anything, and
that it is **not tax advice**.

---

## What to tell people the tool is for

Worth being straight about the boundaries, because they are unusual:

**It does**: read XRPL and Xahau history via WinDB, build a FIFO cost-basis
ledger wallet by wallet (Rev. Proc. 2024-28), classify addresses as active /
lost / gift / exchange, produce Form 8949 and Schedule D, and export for Koinly
and CoinLedger.

**It does not**: see anything that happened *inside* an exchange. If you sold on
Coinbase, this tool knows the coins left your wallet and nothing more. It also
never touches a private key or seed and cannot move funds — worth stating,
because a tax tool asking for wallet addresses invites the question.

**It is not tax advice**, and the gift, lost-key and 1099-DA handling in
particular involve judgement calls that belong to a qualified preparer.
