#!/usr/bin/env bash
# Fails if anything personal has crept into the tree.
#
# The wallet list is the sensitive artefact in this project: a list of XRPL
# addresses attached to a name identifies a person and everything they hold.
# It was once baked into renderer/index.html as a literal array, and it would
# be very easy to reintroduce by pasting a working copy back over the repo.
# This runs in CI and before a release so that cannot ship.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
say() { printf '%s\n' "$*"; }
bad() { fail=1; say "✗ $*"; }
ok()  { say "✓ $*"; }

# Files that are allowed to contain address-shaped strings, and why.
#   - tests use synthetic addresses generated to satisfy the format
#   - the renderer contains rEXAMPLE… placeholders in the CSV template
# Every text file type in the tree, not a hand-picked few. The first version
# of this script scanned only .js/.html/.md/.json, which silently exempted a
# Python diagnostic and two GitHub workflow files that were about to be
# published unchecked. A gate with a gap is worse than no gate, because it
# gets trusted.
SCAN_FILES=$(git ls-files '*.js' '*.html' '*.md' '*.json' '*.py' '*.yml' '*.yaml' \
                          '*.sh' '*.txt' '*.css' '*.ts' 2>/dev/null || \
             find . -path ./node_modules -prune -o -path ./dist-installers -prune -o \
                    -path ./.git -prune -o \
                    \( -name '*.js' -o -name '*.html' -o -name '*.md' -o -name '*.json' \
                       -o -name '*.py' -o -name '*.yml' -o -name '*.yaml' -o -name '*.sh' \
                       -o -name '*.txt' -o -name '*.css' -o -name '*.ts' \) -print)

# ── 1. No non-empty baked-in wallet list ─────────────────────────────────
if grep -nE '^let WALLETS = \[[^]]' renderer/index.html >/dev/null 2>&1; then
  bad "renderer/index.html ships a non-empty WALLETS array — it must be 'let WALLETS = [];'"
else
  ok "WALLETS ships empty"
fi

# ── 2. No real-looking addresses outside the allowed places ──────────────
ADDR='\br[1-9A-HJ-NP-Za-km-z]{24,34}\b'
found=0
for f in $SCAN_FILES; do
  case "$f" in
    test/*|./test/*)      continue ;;   # synthetic by construction
    *package-lock.json)   continue ;;   # integrity hashes are base58-shaped by chance
    *.lock|*yarn.lock)    continue ;;
  esac
  hits=$(grep -oE "$ADDR" "$f" 2>/dev/null | grep -v '^rEXAMPLE' | sort -u)
  if [ -n "$hits" ]; then
    bad "$f contains address-shaped strings that are not rEXAMPLE… placeholders:"
    printf '    %s\n' $hits
    found=1
  fi
done
[ "$found" -eq 0 ] && ok "no real-looking addresses outside test fixtures"

# ── 3. No personal identifiers ───────────────────────────────────────────
NAMES='postma|christopherpostma|jamie\.postma'
hits=$(grep -rniE "$NAMES" $SCAN_FILES 2>/dev/null | grep -v '^\./scripts/verify-clean\.sh:' | grep -v '^scripts/verify-clean\.sh:' || true)
if [ -n "$hits" ]; then
  bad "personal identifiers present:"; printf '    %s\n' "$hits"
else
  ok "no personal identifiers"
fi

# ── 4. No absolute home paths ────────────────────────────────────────────
# /Users/<name> or /home/<name> in a committed file publishes a username and
# usually means a script was written against one machine.
hits=$(grep -rnE '(/Users/|/home/)[a-zA-Z0-9_.-]+' $SCAN_FILES 2>/dev/null \
       | grep -v '/home/runner' | grep -v '\$HOME' || true)
if [ -n "$hits" ]; then
  bad "absolute home directory paths present:"; printf '    %s\n' "$hits"
else
  ok "no absolute home paths"
fi

# ── 5. No Payment-Claim baked into the HTML ──────────────────────────────
if grep -nE 'id="paymentClaim"[^>]*value="[^"]+"' renderer/index.html >/dev/null 2>&1; then
  bad "renderer/index.html has a Payment-Claim baked into the input's value attribute"
else
  ok "no Payment-Claim in the source"
fi

# ── 6. No local database or exports committed ────────────────────────────
strays=$(git ls-files 2>/dev/null | grep -iE '\.(sqlite3?|db)$|Holdings-|Form-?8949|Disposal-Destinations|Wallet-Config|Basis-Ledger|Koinly-Import|CoinLedger-Import' || true)
if [ -n "$strays" ]; then
  bad "data files are tracked by git:"; printf '    %s\n' "$strays"
else
  ok "no data files tracked"
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "CLEAN CHECK FAILED — do not publish this tree."
  exit 1
fi
echo "Clean. Safe to publish."
