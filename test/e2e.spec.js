// test/e2e.spec.js — drives the REAL Electron app (main.js + preload.js +
// renderer/index.html) exactly as a user would launch it, via Playwright's
// _electron runner. This is the one test in the suite that isn't a mock: it
// boots the actual local HTTP server, the actual BrowserWindow, and the
// actual contextBridge/IPC path down to the real SQLite file on disk.
//
// Run headless-safe with:  xvfb-run -a npx playwright test test/e2e.spec.js
//
// What this proves, concretely:
//  - the app launches and shows a window with no menu bar and the right title
//    ("its own window, and no browser chrome" from the user's request)
//  - the renderer loaded over http://127.0.0.1:<port>, not file:// (the CORS
//    fix), and window.taxDB / window.appInfo are present (contextBridge works)
//  - a real IPC round-trip through preload.js -> ipcMain -> db.js -> SQLite
//    file on disk actually persists and reads back data
//  - the Local Data panel in the UI (Setup tab) reflects that persisted data,
//    i.e. the renderer wiring (USE_LOCAL_DB branch, refreshLocalDataPanel)
//    is not just theoretically reachable but actually runs end-to-end

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_DIR = path.join(__dirname, '..');

test('Electron app launches, has no menu bar, and the local DB round-trips through IPC', async () => {
  // Isolated home dir so app.getPath('userData') (which Electron derives from
  // appData, which on Linux comes from $HOME/.config) never touches or is
  // polluted by a real profile's tax-data.sqlite3. This is a stronger
  // guarantee than passing --user-data-dir, which Electron doesn't reliably
  // honor for app.getPath() on every platform.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrp-xahau-e2e-'));

  const app = await electron.launch({
    args: [APP_DIR],
    cwd: APP_DIR,
    env: { ...process.env, HOME: userDataDir },
  });

  try {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    // ── Window chrome ──────────────────────────────────────────────────
    // Note: Playwright's page.title() reads document.title, which is the
    // in-page <title> ("Form 8949 · ... · 2025") — that's expected and fine.
    // The OS-level window/taskbar title is a separate property (BrowserWindow
    // .getTitle()), which main.js pins via page-title-updated preventDefault()
    // so it doesn't flip away from the app's real name.
    const { nativeTitle, isMenuBarVisible } = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return { nativeTitle: win.getTitle(), isMenuBarVisible: win.isMenuBarVisible() };
    });
    expect(nativeTitle).toBe('XRP & Xahau Tax Tool');
    expect(isMenuBarVisible).toBe(false);

    // ── Served over http://127.0.0.1, not file:// ──────────────────────
    const url = window.url();
    expect(url.startsWith('http://127.0.0.1:')).toBe(true);

    // ── contextBridge surface present ──────────────────────────────────
    const bridgePresent = await window.evaluate(() => ({
      taxDB: !!(window.taxDB && window.taxDB.isElectron),
      appInfo: !!(window.appInfo && window.appInfo.isElectron),
      noNodeLeak: typeof window.require === 'undefined',
    }));
    expect(bridgePresent.taxDB).toBe(true);
    expect(bridgePresent.appInfo).toBe(true);
    expect(bridgePresent.noNodeLeak).toBe(true); // nodeIntegration:false actually holds

    // ── Real IPC round-trip: insert rows, read sync state, read them back ──
    const roundTrip = await window.evaluate(async () => {
      const wallet = 'rE2ETestWalletXXXXXXXXXXXXXXXXXXXX';
      const chain = 'Xahau';
      await window.taxDB.clearWalletChain(wallet, chain); // start clean in case of a stale run

      const before = await window.taxDB.getSyncState(wallet, chain);
      const inserted = await window.taxDB.insertRows(wallet, chain, [
        { tx_hash: 'E2E_HASH_1', timestamp: '2024-01-01 00:00:00', raw_json: JSON.stringify({ hello: 1 }) },
        { tx_hash: 'E2E_HASH_2', timestamp: '2024-01-02 00:00:00', raw_json: JSON.stringify({ hello: 2 }) },
      ]);
      await window.taxDB.upsertSyncState(wallet, chain, '2024-01-02 00:00:00');
      const after = await window.taxDB.getSyncState(wallet, chain);
      const rows = await window.taxDB.getAllRows(wallet, chain);
      const stats = await window.taxDB.getStats();
      const dbPath = await window.taxDB.getPath();

      return { before, inserted, after, rows, stats, dbPath };
    });

    expect(roundTrip.before).toBeNull();
    expect(roundTrip.inserted).toBe(2);
    expect(roundTrip.after).toBe('2024-01-02 00:00:00');
    expect(roundTrip.rows.map((r) => r.hello)).toEqual([1, 2]); // sorted by timestamp asc
    expect(roundTrip.stats.totalRows).toBeGreaterThanOrEqual(2);
    expect(roundTrip.dbPath.endsWith('tax-data.sqlite3')).toBe(true);

    // The DB file this IPC call wrote to must actually exist on disk — i.e.
    // this isn't an in-memory stub, it's the real better-sqlite3 file.
    expect(fs.existsSync(roundTrip.dbPath)).toBe(true);

    // ── Local Data panel reflects it in the actual rendered UI ─────────
    await window.evaluate(() => refreshLocalDataPanel());
    const panelHtml = await window.locator('#localDataStats').innerHTML();
    expect(panelHtml).toContain('tax-data.sqlite3');
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
