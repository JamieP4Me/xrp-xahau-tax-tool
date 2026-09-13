#!/usr/bin/env node
/**
 * Makes sure better-sqlite3 is compiled for whoever is about to load it, and
 * rebuilds it if not.
 *
 * WHY THIS EXISTS
 *
 * better-sqlite3 is a native addon, so it is compiled against one ABI at a
 * time. Two things in this project need different ones:
 *
 *   - the app and the Playwright suite need Electron's bundled Node ABI
 *   - db.test.js, verify-xrpl.test.js and verify-xrpl.js need the ABI of
 *     whatever Node is on PATH
 *
 * The two NODE_MODULE_VERSION numbers are deliberately not written down here.
 * They change with every Electron and Node major -- they were 130 and 115
 * under Electron 33 and Node 20 -- and a comment naming the wrong pair is
 * worse than one naming none, because the next person checks their error
 * message against it and concludes the check is broken.
 *
 * Switching was a manual dance — `npm rebuild better-sqlite3` one way,
 * `npm run rebuild` the other — and forgetting produces an error that names
 * two version numbers and no remedy:
 *
 *     The module '…/better_sqlite3.node' was compiled against a different
 *     Node.js version using NODE_MODULE_VERSION <one>. This version of
 *     Node.js requires NODE_MODULE_VERSION <another>.
 *
 * In the app that arrives as a startup crash dialog, which reads like the
 * install is broken rather than like one command is needed. Nobody should
 * have to hold this in their head, so the npm scripts now check first.
 *
 * HOW IT DETECTS, without a rebuild
 *
 * By trying to load the module under plain Node:
 *
 *   - it LOADS      → built for Node's ABI    → Electron would fail
 *   - it FAILS with a NODE_MODULE_VERSION error → built for Electron's ABI
 *
 * The failure is the informative case, which is why this works cheaply.
 *
 * USAGE:  node scripts/check-abi.js electron|node
 */
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const want = process.argv[2];
if (want !== 'electron' && want !== 'node') {
  console.error('usage: node scripts/check-abi.js electron|node');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');

function currentAbi() {
  // Probe in a CHILD process, never in this one.
  //
  // Two reasons, and the second is why this cannot be done inline:
  //
  //  1. better-sqlite3 loads its native binding lazily, inside the Database
  //     constructor. `require()` alone succeeds against a binary built for a
  //     completely different ABI — which is how the first version of this
  //     check reported "already correct" while the very next command died on
  //     NODE_MODULE_VERSION. So the probe has to actually open a database.
  //
  //  2. Doing that against a mismatched binary does not reliably throw. It
  //     can abort the process outright ("Module did not self-register", then
  //     SIGSEGV). This script runs as `prestart`, so a crash here would fail
  //     `npm start` entirely — turning a guard against a confusing error into
  //     a worse one. In a child process a crash is just a non-zero exit code,
  //     which is a perfectly good answer to "is this the wrong ABI?".
  const probe = "new (require('better-sqlite3'))(':memory:').close()";
  const res = require('child_process').spawnSync(process.execPath, ['-e', probe], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000,
  });

  if (res.status === 0) return 'node';

  const out = String((res.stderr || '') + (res.stdout || ''));
  if (/NODE_MODULE_VERSION/.test(out) || /did not self-register/.test(out) || res.signal) {
    return 'electron';
  }
  // Not built at all, or broken some other way. Rebuilding is the right move
  // either way, so report the opposite of what is wanted.
  return want === 'electron' ? 'node' : 'electron';
}

const have = currentAbi();
if (have === want) process.exit(0);

console.log(`\n  better-sqlite3 is built for ${have}; this step needs ${want}. Rebuilding…`);
console.log('  (This is automatic now — see scripts/check-abi.js.)\n');

try {
  if (want === 'electron') {
    execFileSync(path.join(ROOT, 'node_modules', '.bin', 'electron-rebuild'),
      ['-f', '-w', 'better-sqlite3'], { cwd: ROOT, stdio: 'inherit' });
  } else {
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['rebuild', 'better-sqlite3'], { cwd: ROOT, stdio: 'inherit' });
  }
  // A locally compiled addon is unsigned, and Electron's hardened runtime
  // will not load an unsigned library -- macOS kills the process with SIGKILL
  // and no error at all. See scripts/sign-native.js for the whole story.
  require('./sign-native.js').signNative();
} catch (e) {
  console.error(
    `\n  Automatic rebuild failed. Run this by hand:\n\n` +
    (want === 'electron' ? '      npm run rebuild\n' : '      npm rebuild better-sqlite3\n')
  );
  process.exit(1);
}
