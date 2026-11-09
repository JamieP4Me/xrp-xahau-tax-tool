// test/supply-chain.test.js — what actually ships, and what an advisory reaches.
//
// `npm audit` misled this project in BOTH directions:
//
//   Under-reporting. `npm audit --omit=dev` said zero while the app ran an
//   Electron end-of-life for seventeen months — a devDependency by
//   convention, but the runtime inside the DMG.
//
//   Over-reporting. A critical in dompurify (via jspdf) was read as "the
//   vendored jsPDF ships DOMPurify", and briefly written down as fact. It
//   doesn't: the bundle carries only a lazy LOADER, and every route that
//   loader tries is closed in this renderer.
//
// These assertions pin the facts an advisory assessment depends on, so that
// SECURITY.md cannot quietly become false when someone adds a dependency,
// re-vendors jsPDF, or reaches for doc.html().

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); }
  catch (e) {
    failures++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${e.message.split('\n').join('\n    ')}`);
  }
}

console.log('supply chain — what ships, and what an advisory can reach');

test('the only production dependency is better-sqlite3', () => {
  // electron-builder packages production dependencies and nothing else from
  // node_modules. Adding one changes what ships — and so changes which
  // advisories are real — and must not happen without a second look.
  const deps = Object.keys(JSON.parse(read('package.json')).dependencies || {});
  assert.deepStrictEqual(deps, ['better-sqlite3'],
    'production dependencies changed to ' + JSON.stringify(deps) + '. Re-read the ' +
    'advisory table in SECURITY.md: anything here ships inside the DMG.');
});

test('the vendored jsPDF bundles no copy of DOMPurify', () => {
  // Markers calibrated against the real library: present in dompurify's own
  // dist, absent from jsPDF's loader. ("sanitize(" is NOT a marker — it is
  // the loader's call site and appears in both.)
  const s = read('renderer/vendor/jspdf.umd.min.js');
  const found = ['addHook', 'removeHook', 'isValidAttribute'].filter(k => s.includes(k));
  assert.deepStrictEqual(found, [],
    'the vendored jsPDF now appears to CONTAIN DOMPurify (' + found.join(', ') + '). ' +
    'Its version is then shipped code, and every dompurify advisory applies directly.');
});

test('the markers really do identify DOMPurify, so the test above can fail', () => {
  // A detector that cannot detect is worse than none. Prove it against the
  // genuine article whenever the package is installed.
  const real = path.join(ROOT, 'node_modules/dompurify/dist/purify.min.js');
  if (!fs.existsSync(real)) return;   // dev copy absent: nothing to calibrate against
  const s = fs.readFileSync(real, 'utf8');
  for (const k of ['addHook', 'removeHook', 'isValidAttribute']) {
    assert.ok(s.includes(k), `marker ${k} is missing from real DOMPurify — recalibrate`);
  }
});

test('the app never calls jsPDF html(), the only path that reaches for DOMPurify', () => {
  const html = read('renderer/index.html');
  const calls = (html.match(/\.(html|addHTML)\s*\(/g) || []);
  assert.strictEqual(calls.length, 0,
    `found ${calls.length} html()/addHTML() call(s). jsPDF's html() renderer loads ` +
    'DOMPurify at runtime; using it makes the dompurify advisories live.');
});

test('the renderer offers no require() or AMD route for that loader to use', () => {
  // The loader's three routes are window.DOMPurify, require("dompurify") and
  // AMD define. The last two exist only if the renderer is given Node, which
  // these two settings forbid.
  const main = read('main.js');
  assert.ok(/contextIsolation:\s*true/.test(main), 'contextIsolation is no longer true');
  assert.ok(/nodeIntegration:\s*false/.test(main), 'nodeIntegration is no longer false');
});

test('Electron is pinned at or above the November 2026 patched release', () => {
  // 44.0.0-alpha.1 through 44.9.0 carry a high-severity advisory. A range
  // floor below 44.10.2 lets a fresh install resolve into it.
  const range = JSON.parse(read('package.json')).devDependencies.electron;
  const m = /^\^?(\d+)\.(\d+)\.(\d+)/.exec(range || '');
  assert.ok(m, 'unparseable electron range: ' + range);
  const [maj, min, pat] = m.slice(1).map(Number);
  const ok = maj > 44 || (maj === 44 && (min > 10 || (min === 10 && pat >= 2)));
  assert.ok(ok, `electron range ${range} allows a version inside the advisory range`);
});

if (failures) { console.log(`\n${failures} test(s) FAILED`); process.exit(1); }
console.log('\nAll supply-chain tests passed');
