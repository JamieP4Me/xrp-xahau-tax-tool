#!/usr/bin/env node
/**
 * Fails if anything personal has crept into the tree.
 *
 * The wallet list is the sensitive artefact in this project: a list of XRPL
 * addresses attached to a name identifies a person and everything they hold.
 * It was once baked into renderer/index.html as a literal array, and it would
 * be very easy to reintroduce by pasting a working copy back over the repo.
 * This runs in CI and before every release build so that cannot ship.
 *
 * WHY NODE AND NOT BASH. This started life as verify-clean.sh, wired into the
 * dist:mac / dist:linux / dist:win npm scripts so a release build could not
 * skip it. That worked on macOS and Linux and failed instantly on Windows,
 * where npm runs scripts through cmd.exe:
 *
 *     '.' is not recognized as an internal or external command
 *
 * The tempting fix was to drop the gate from dist:win. That would have left
 * the one platform where the check does not run — and a privacy check with a
 * hole in it is worse than none, because it gets trusted. Node runs
 * everywhere the project already needs it, so the gate now runs everywhere
 * too, in CI and on a contributor's machine whatever they are on.
 */
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);

let failed = false;
const ok = (m) => console.log('✓ ' + m);
const bad = (m, lines) => {
  failed = true;
  console.log('✗ ' + m);
  for (const l of lines || []) console.log('    ' + l);
};

// ── Which files to scan ───────────────────────────────────────────────────
// Every text type in the tree, not a hand-picked few. An earlier version
// scanned only .js/.html/.md/.json, which silently exempted a Python
// diagnostic and two workflow files that were about to be published
// unchecked.
const SCAN_EXT = new Set([
  '.js', '.html', '.md', '.json', '.py', '.yml', '.yaml', '.sh', '.txt', '.css', '.ts',
]);
const SKIP_DIR = new Set(['node_modules', 'dist-installers', 'test-results', '.git', 'playwright-report']);
// Lockfile integrity hashes are base58-shaped by coincidence.
const SKIP_FILE = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIR.has(e.name)) walk(path.join(dir, e.name), out);
    } else if (SCAN_EXT.has(path.extname(e.name)) && !SKIP_FILE.has(e.name)) {
      out.push(path.relative(ROOT, path.join(dir, e.name)));
    }
  }
  return out;
}

let tracked;   // undefined = not asked yet; array = answer; 'unavailable' = git could not be asked
// Returns null — NOT an empty list — when git cannot be asked.
//
// This used to `catch { tracked = []; }`, which meant that outside a git
// checkout (or on any git failure at all) both git-based checks below iterated
// nothing, found nothing, and printed a tick. The whole gate then reported
// "Clean. Safe to publish." while two of its seven checks had not actually
// run. That is worse than a failure: a gate that cannot fail is not a gate,
// and this one was passing vacuously in every working copy that was not a
// repo — including the one these checks were being developed in.
//
// Callers must treat null as "cannot verify" and fail, not as "nothing found".
//
// The memo is deliberately not null-based either. `tracked` starts undefined
// and becomes an array or the string 'unavailable', so "not asked yet" and
// "asked, no answer" can never collapse into the same value — which is the
// same class of bug one level down, and it bit this fix on its first run.
function gitFiles() {
  if (tracked === undefined) {
    try {
      tracked = execSync('git ls-files', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n').filter(Boolean);
    } catch { tracked = 'unavailable'; }
  }
  return tracked === 'unavailable' ? null : tracked;
}

const files = walk(ROOT, []);
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const SELF = ['scripts/verify-clean.js', 'scripts/verify-clean.sh'].map(p => p.replace(/\//g, path.sep));
const isSelf = (f) => SELF.includes(f);

// ── 1. No non-empty baked-in wallet list ──────────────────────────────────
{
  const html = read('renderer/index.html');
  if (/^let WALLETS = \[[^\]]/m.test(html)) {
    bad("renderer/index.html ships a non-empty WALLETS array — it must be 'let WALLETS = [];'");
  } else {
    ok('WALLETS ships empty');
  }
}

// ── 2. No real-looking addresses outside the allowed places ───────────────
// Tests use synthetic addresses generated to satisfy the format; the renderer
// carries rEXAMPLE… placeholders in its CSV template.
{
  const ADDR = /\br[1-9A-HJ-NP-Za-km-z]{24,34}\b/g;
  let found = false;
  for (const f of files) {
    if (f.startsWith('test' + path.sep) || f.startsWith('test/')) continue;
    const hits = [...new Set((read(f).match(ADDR) || []).filter(a => !a.startsWith('rEXAMPLE')))];
    if (hits.length) { bad(`${f} contains address-shaped strings that are not rEXAMPLE… placeholders:`, hits); found = true; }
  }
  if (!found) ok('no real-looking addresses outside test fixtures');
}

// ── 3. No personal identifiers ────────────────────────────────────────────
{
  const NAMES = /postma|christopherpostma|jamie\.postma/i;
  const hits = [];
  for (const f of files) {
    if (isSelf(f)) continue; // this file names them in order to look for them
    read(f).split('\n').forEach((line, i) => {
      if (NAMES.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  if (hits.length) bad('personal identifiers present:', hits); else ok('no personal identifiers');
}

// ── 4. No absolute home paths ─────────────────────────────────────────────
// /Users/<name> or /home/<name> in a committed file publishes a username and
// usually means a script was written against one machine.
{
  const HOMEPATH = /(\/Users\/|\/home\/)[A-Za-z0-9_.-]+/;
  const hits = [];
  for (const f of files) {
    if (isSelf(f)) continue;
    read(f).split('\n').forEach((line, i) => {
      if (HOMEPATH.test(line) && !/\/home\/runner/.test(line) && !/\$HOME/.test(line)) {
        hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
      }
    });
  }
  if (hits.length) bad('absolute home directory paths present:', hits); else ok('no absolute home paths');
}

// ── 5. No Payment-Claim baked into the HTML ───────────────────────────────
{
  if (/id="paymentClaim"[^>]*value="[^"]+"/.test(read('renderer/index.html'))) {
    bad("renderer/index.html has a Payment-Claim baked into the input's value attribute");
  } else {
    ok('no Payment-Claim in the source');
  }
}

// ── 6. No local database or exports committed ─────────────────────────────
{
  // A database is a database whatever it is called.
  const ALWAYS = /\.(sqlite3?|db)$/i;

  // These name fragments identify an EXPORT this app writes. They are not
  // sufficient on their own: `amm[-_.]` used to be, and it failed the whole
  // gate on `test/amm-real-file.spec.js` — a test file, named after the data
  // it reads. A false positive here is not harmless. It teaches whoever sees
  // it that the gate cries wolf, and the next real hit gets waved through.
  const EXPORT_NAME = /Holdings-|Form-?8949|Disposal-Destinations|Wallet-Activity|Wallet-Config|Basis-Ledger|Gift-Log|Lost-Wallet|Exchange-Cost-Basis|Koinly-Import|CoinLedger-Import|XRPL-Verification|Unvalued-Transactions|Price-History-|amm[-_.]/i;

  // ...so an export name only counts when it is carried on a file that can
  // actually hold the data. Source that merely mentions an export by name is
  // how these exports get written in the first place.
  const DATA_EXT = /\.(csv|tsv|pdf|xlsx?|sqlite3?|db)$/i;

  const t = gitFiles();
  if (t === null) {
    bad('cannot ask git what is tracked — this check did not run, so the tree is unverified');
  } else {
    const strays = t.filter(f => ALWAYS.test(f) || (EXPORT_NAME.test(f) && DATA_EXT.test(f)));
    if (strays.length) bad('data files are tracked by git:', strays); else ok('no data files tracked');
  }
}

// ── 6b. No CSV anywhere in the tree carries a real address ────────────────
//
// Check 6 matches FILENAMES against a list, which only catches exports we
// thought to name. `verify-xrpl.js --out amm-all.csv` wrote wallet addresses,
// amounts and transaction hashes into the working copy under a name nobody
// had added to that list — matched by neither the gate nor .gitignore. One
// `git add .` and it ships.
//
// So this checks CONTENT instead of names: any tracked CSV holding something
// shaped like a funded r-address fails, whatever it is called. Placeholders
// (rEXAMPLE…, rTEST…) are how the wallet-config template is allowed to exist.
{
  const ADDR = /\br[1-9A-HJ-NP-Za-km-z]{24,34}\b/g;
  const PLACEHOLDER = /^r(EXAMPLE|TEST|XXXX|SENDER|WALLET)/i;
  const t = gitFiles();
  if (t === null) {
    // Same reasoning as check 6: an unanswerable question is not a pass.
    bad('cannot ask git what is tracked — this check did not run, so the tree is unverified');
  } else {
    const offenders = [];
    for (const f of t.filter(f => /\.csv$/i.test(f))) {
      let text = '';
      try { text = require('fs').readFileSync(f, 'utf8'); } catch (e) { continue; }
      const real = [...new Set(text.match(ADDR) || [])].filter(a => !PLACEHOLDER.test(a));
      if (real.length) offenders.push(`${f} (${real.length} address(es), e.g. ${real[0].slice(0, 10)}…)`);
    }
    if (offenders.length) bad('tracked CSV files contain real addresses:', offenders);
    else ok('no real addresses in tracked CSVs');
  }
}

console.log('');
if (failed) {
  console.log('CLEAN CHECK FAILED — do not publish this tree.');
  process.exit(1);
}
console.log('Clean. Safe to publish.');
