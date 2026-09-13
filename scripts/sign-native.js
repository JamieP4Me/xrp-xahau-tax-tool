#!/usr/bin/env node
/**
 * Ad-hoc code-signs the freshly compiled native addon, on macOS.
 *
 * WHY THIS EXISTS
 *
 * Electron ships with the hardened runtime enabled. macOS refuses to map an
 * unsigned library into a hardened process and kills the process outright --
 * SIGKILL, no JavaScript error, no stack, nothing on stdout:
 *
 *     .../Electron.app/Contents/MacOS/Electron exited with signal SIGKILL
 *
 * The only place the reason appears is the kernel's own crash report:
 *
 *     "termination": {"code":2,"namespace":"CODESIGNING","indicator":"Invalid Page"}
 *
 * electron-rebuild compiles better_sqlite3.node locally and leaves it
 * unsigned, so EVERY rebuild for the Electron ABI re-arms this. It cost an
 * evening once: the app died identically on every launch while a bare
 * `electron` with no app started fine -- because a bare Electron never loads
 * the addon. Reinstalling Electron does not help and neither does signing
 * Electron.app; the unsigned file is the addon, and that is what must be
 * signed.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not use `codesign --deep`. Apple deprecated that flag precisely
 * because it re-signs nested helper binaries and STRIPS THEIR ENTITLEMENTS.
 * Running it against Electron.app during that same evening replaced a broken
 * signature with a valid signature and no entitlements, which fails in a new
 * way -- the helper processes can no longer find the parent:
 *
 *     bootstrap_look_up com.github.Electron.MachPortRendezvousServer: Permission denied
 *
 * So this signs exactly the files that were just compiled, and nothing else.
 *
 * Non-macOS platforms have no equivalent requirement: this is a no-op there.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

if (process.platform !== 'darwin') process.exit(0);

const dir = path.join(__dirname, '..', 'node_modules', 'better-sqlite3', 'build', 'Release');
let targets = [];
try {
  targets = fs.readdirSync(dir)
    .filter(f => f.endsWith('.node') || f.endsWith('.dylib'))
    .map(f => path.join(dir, f));
} catch (e) {
  // Nothing built yet. Not an error: the rebuild that follows will produce it,
  // and this script runs again after that.
  process.exit(0);
}
if (!targets.length) process.exit(0);

// `-` is the ad-hoc identity: no certificate, no Developer ID, nothing to
// configure. It is enough to satisfy the hardened runtime for a locally built
// addon loaded by a locally installed Electron.
const res = spawnSync('codesign', ['--force', '--sign', '-', ...targets], { encoding: 'utf8' });

if (res.error || res.status !== 0) {
  // Deliberately NOT fatal. A machine where codesign is unavailable, or where
  // signing is not required, must still be able to build. If signing was
  // actually needed the app dies on launch with the SIGKILL above -- and this
  // warning is then the first thing to look for.
  console.warn('  ⚠ could not ad-hoc sign the native addon:',
               (res.error && res.error.message) || String(res.stderr || '').trim());
  console.warn('    If the app exits with SIGKILL and no error, this is why.');
  process.exit(0);
}

console.log(`  ✓ ad-hoc signed ${targets.length} native binar(ies) for the hardened runtime`);
