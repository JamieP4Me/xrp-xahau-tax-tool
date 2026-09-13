// test/sign-native.test.js — the guard that must never go quiet.
//
// scripts/sign-native.js exists because macOS kills Electron with SIGKILL and
// no error when it loads an unsigned native addon. The first version of it
// hard-coded node_modules/better-sqlite3/build/Release, which was correct for
// better-sqlite3 11 and wrong ONE DAY LATER: version 13 ships
// prebuilds/<platform>-<arch>.node, and build/Release survives holding only
// object files.
//
// So the script found nothing, exited 0, and printed nothing. A guard against
// a silent failure, failing silently. It was noticed only because its success
// line stopped appearing in a build log — which is not a control.
//
// This is the control. If the packaging layout moves again, this fails.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { findBinaries, PKG } = require('../scripts/sign-native.js');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); }
  catch (e) {
    failures++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${e.stack.split('\n').slice(0, 4).join('\n    ')}`);
  }
}

console.log('sign-native.js — the native addon must be findable to be signable');

test('the package directory it searches actually exists', () => {
  assert.ok(fs.existsSync(PKG),
    `expected better-sqlite3 at ${PKG} — if this moved, sign-native.js is signing nothing`);
});

test('REGRESSION: at least one native binary is found, wherever packaging puts it', () => {
  const all = findBinaries(PKG);
  assert.ok(all.length > 0,
    'found no .node or .dylib under better-sqlite3. This is exactly the state in ' +
    'which sign-native.js silently signed nothing and the app died with SIGKILL.');
});

test('a binary for THIS platform and architecture is among them', () => {
  // The foreign prebuilds are never loadable here, so finding only those would
  // still mean nothing gets signed that matters.
  const all = findBinaries(PKG);
  const tag = `${process.platform}-${process.arch}`;
  const usable = all.filter(f => /build[\/\\]Release[\/\\]/.test(f) || f.includes(tag));
  assert.ok(usable.length > 0,
    `no binary for ${tag}; saw:\n      ` + all.map(f => path.basename(f)).join('\n      '));
});

test('it never returns a directory or a source file', () => {
  for (const f of findBinaries(PKG)) {
    assert.ok(/\.(node|dylib)$/.test(f), `not a loadable binary: ${f}`);
    assert.ok(fs.statSync(f).isFile(), `not a file: ${f}`);
  }
});

test('on a non-macOS platform signing is skipped, not attempted', () => {
  // Signing is a macOS requirement. Everywhere else this must be inert rather
  // than shelling out to a codesign that does not exist.
  const { signNative } = require('../scripts/sign-native.js');
  if (process.platform !== 'darwin') {
    assert.deepStrictEqual(signNative(), { skipped: 'not darwin' });
  }
});

if (failures) { console.log(`\n${failures} test(s) FAILED`); process.exit(1); }
console.log('\nAll sign-native.js tests passed');
