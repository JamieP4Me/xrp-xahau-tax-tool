#!/usr/bin/env node
/**
 * Ad-hoc code-signs the compiled native addon, on macOS.
 *
 * WHY THIS EXISTS
 *
 * Electron runs with the hardened runtime. macOS refuses to map an unsigned
 * library into a hardened process and kills the process outright -- SIGKILL,
 * no JavaScript error, no stack, nothing on stdout:
 *
 *     .../Electron.app/Contents/MacOS/Electron exited with signal SIGKILL
 *
 * The reason appears only in the kernel's crash report:
 *
 *     "termination":{"code":2,"namespace":"CODESIGNING","indicator":"Invalid Page"}
 *
 * A bare `electron` with no app starts fine throughout, because it never
 * loads the addon -- so every piece of visible evidence points at your own
 * code while an unsigned file is the cause.
 *
 * WHY IT SEARCHES INSTEAD OF KNOWING
 *
 * The first version of this script hard-coded
 * node_modules/better-sqlite3/build/Release. That was correct for
 * better-sqlite3 11 and WRONG ONE DAY LATER: version 13 ships
 * prebuilds/<platform>-<arch>.node, and electron-rebuild writes there too.
 * build/Release still exists, holding nothing but object files.
 *
 * The script therefore found no targets, exited 0, and printed nothing --
 * a guard against a silent failure, failing silently. It was caught only
 * because its success line stopped appearing in a build log.
 *
 * So: find every .node and .dylib under the package, wherever the packaging
 * convention puts them this year, and SAY SO WHEN THERE ARE NONE. A guard
 * that cannot find what it guards must never be quiet about it.
 *
 * Non-macOS platforms have no equivalent requirement: a no-op there.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PKG = path.join(__dirname, '..', 'node_modules', 'better-sqlite3');

function findBinaries(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findBinaries(full, out, depth + 1);
    else if (/\.(node|dylib)$/.test(e.name)) out.push(full);
  }
  return out;
}

function signNative() {
  if (process.platform !== 'darwin') return { skipped: 'not darwin' };
  const all = findBinaries(PKG);

// Only this machine's architecture can be loaded here, and signing a foreign
// prebuild is pointless noise. Everything under build/ is ours by definition.
const mine = all.filter(f =>
  /build[\\/]/.test(f) || f.includes(`darwin-${process.arch}`) || !/prebuilds[\\/]/.test(f));

if (!mine.length) {
  console.warn('  ⚠ sign-native: found no native binary to sign under node_modules/better-sqlite3.');
  console.warn(`    Looked for *.node and *.dylib; saw ${all.length} file(s) in total.`);
  console.warn('    If the app then exits with SIGKILL and no error message, this is why:');
  console.warn('    the packaging layout moved and this script needs to follow it.');
  return { signed: 0 };
}

// `-` is the ad-hoc identity: no certificate, nothing to configure. Enough to
// satisfy the hardened runtime for a locally built addon.
//
// NOT `--deep`. Apple deprecated it because it re-signs nested binaries and
// STRIPS THEIR ENTITLEMENTS; running it against Electron.app once replaced a
// broken signature with a valid one and no entitlements, after which the
// helper processes could no longer find their parent.
const res = spawnSync('codesign', ['--force', '--sign', '-', ...mine], { encoding: 'utf8' });

if (res.error || res.status !== 0) {
  console.warn('  ⚠ could not ad-hoc sign the native addon:',
               (res.error && res.error.message) || String(res.stderr || '').trim());
  console.warn('    If the app exits with SIGKILL and no error, this is why.');
  return { signed: 0 };
}

  console.log(`  ✓ ad-hoc signed ${mine.length} native binar(ies) for the hardened runtime:`);
  for (const f of mine) console.log(`      ${path.relative(path.join(__dirname, '..'), f)}`);
  return { signed: mine.length, files: mine };
}

module.exports = { signNative, findBinaries, PKG };

if (require.main === module) signNative();
