// Playwright config.
//
// The single job here is testMatch. There are two test suites in test/ and
// they need better-sqlite3 compiled against DIFFERENT ABIs:
//
//   *.spec.js    run inside Electron  → needs `npm run rebuild` (electron-rebuild)
//   db.test.js   runs in plain Node   → needs `npm rebuild better-sqlite3`
//
// Without testMatch, a bare `npx playwright test` swept db.test.js into the
// Electron run, where every one of its cases died with "Module did not
// self-register" / "NODE_MODULE_VERSION 130 ... requires 127". That failure
// looks exactly like a broken native build and sent us rebuilding a module
// that was already correct. It is a harness mistake, not a code defect, and
// this line is what stops it recurring.
//
// Run db.test.js via `npm run test:db`.
// The app rebuilds the report a second time in the background after every
// build to keep the AMM treatment comparison current. In the suite those
// extra builds would race the assertions, so they are off here; specs spread
// process.env into electron.launch, so this reaches every app instance.
process.env.XRPTAX_BACKGROUND_COMPARE = process.env.XRPTAX_BACKGROUND_COMPARE || 'off';

module.exports = {
  testDir: './test',
  testMatch: '**/*.spec.js',
  timeout: 180000,
  workers: 1,
  reporter: [['list']],
};
