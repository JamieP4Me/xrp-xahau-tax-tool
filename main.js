// main.js — Electron main process.
//
// Two jobs beyond the usual "create a window":
//
// 1. Serve the renderer over a real http://127.0.0.1 origin instead of
//    file://. This is the fix for the exact CORS problem documented in
//    XRP_XAHAU_STANDALONE_APP_PLAN.md: WinDB/Dhali's fetch() calls need a
//    non-null origin to work reliably, and loading the page via file://
//    (Electron's default for loadFile()) hits the same null-origin issue a
//    double-clicked HTML file does in a regular browser. A tiny local
//    static server sidesteps it entirely, the same way `python3 -m
//    http.server` did for the browser-only version of this tool.
//
// 2. Own the local SQLite cache (db.js) and expose it to the renderer only
//    through a narrow set of ipcMain.handle() calls — the renderer never
//    touches the filesystem or a native module directly (contextIsolation
//    stays on, nodeIntegration stays off). This is what lets a second run
//    of the app fetch only new transactions instead of every transaction
//    since ledger genesis every single time.

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { createDb } = require('./db');

const RENDERER_DIR = path.resolve(__dirname, 'renderer');
const DB_FILENAME = 'tax-data.sqlite3';

// Only one copy of this app may run at a time. Two instances would open two
// better-sqlite3 write handles on the same tax-data.sqlite3: WAL allows many
// readers but a single writer, so a "Clear local database" in one instance
// while the other is mid-sync fails on the write lock — and a clear that
// fails partway is the one state this design must never reach (see the
// transaction note in db.js clearAll). It also silently defeated the fixed
// port: the second instance hit EADDRINUSE, fell back to a random port, and
// therefore ran against a different origin with empty localStorage.
// Headroom above V8's default renderer old-space cap (~4 GB). The report
// build is a genuinely large in-memory job — a global chronological merge
// across every cached wallet — and at multi-million-row scale the default
// left no margin. The streaming changes in the renderer are the real fix
// (peak dropped from ~4.6 GB to ~1.6 GB); this is the safety margin so a
// user with an unusually large cache degrades into slowness rather than a
// hard process kill. It is a ceiling, not an allocation: nothing extra is
// reserved, and machines with less RAM are unaffected until they need it.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=6144');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

let mainWindow = null;
let localServer = null;
let localServerPort = 0;
let db = null;

// ── Tiny static file server for the renderer (no dependencies) ─────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// A fixed, unusual port so the renderer's origin (http://127.0.0.1:<port>)
// is IDENTICAL across every launch. This matters a lot more than it looks:
// the renderer uses localStorage for the wallet list, term overrides, and
// other Setup-tab state (saveWalletList()/loadWalletList() in
// renderer/index.html) — and localStorage is scoped per-origin. Binding to
// port 0 (OS-assigned, different every launch) was giving every restart a
// brand-new origin with empty localStorage, silently wiping the saved
// wallet list on every relaunch even though the actual transaction cache
// (SQLite, keyed by wallet address, not by origin) was completely intact.
// That's what made it look like "my transactions disappeared after
// restarting" — the wallets you'd need to re-select to view them had been
// forgotten, not the cached data itself. A fixed port fixes this exactly
// the way closing and reopening a real installed app is supposed to work.
const FIXED_LOCAL_SERVER_PORT = 47821;

function startLocalServer() {
  return new Promise((resolve, reject) => {
    localServer = http.createServer((req, res) => {
      try {
        // Reject anything not aimed at our own loopback port. Cheap defence
        // against DNS rebinding, where a remote page resolves its hostname to
        // 127.0.0.1 and reads whatever this server will hand out.
        const expectedHost = `127.0.0.1:${localServerPort}`;
        if (localServerPort && req.headers.host !== expectedHost) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }

        const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
        const filePath = path.resolve(RENDERER_DIR, '.' + (urlPath === '/' ? '/index.html' : urlPath));
        // Confine to the renderer directory. This used to be
        // `filePath.startsWith(RENDERER_DIR)`, which is a string prefix test,
        // not a path-boundary test: '/app/renderer-backup/x.js' starts with
        // '/app/renderer' and so passed. Comparing the relative path is the
        // real check — it rejects anything that escapes with '..' or resolves
        // to a sibling directory that merely shares the name prefix.
        const rel = path.relative(RENDERER_DIR, filePath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
        fs.readFile(filePath, (err, data) => {
          // This callback runs outside the enclosing try/catch, so it has to
          // handle its own failures — an uncaught throw here would take down
          // the main process, potentially mid-sync.
          try {
            if (err) {
              res.writeHead(404);
              res.end('Not found');
              return;
            }
            const ext = path.extname(filePath).toLowerCase();
            res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
            res.end(data);
          } catch (_) { /* client went away mid-response */ }
        });
      } catch (e) {
        res.writeHead(500);
        res.end('Server error');
      }
    });

    const bind = (port) => {
      localServer.listen(port, '127.0.0.1');
    };

    localServer.once('listening', () => {
      localServerPort = localServer.address().port;
      resolve(localServerPort);
    });
    // If the fixed port is somehow taken (another instance of this app
    // already running, or something else squatting it), fall back to an
    // OS-assigned port rather than failing to start at all — localStorage
    // just won't persist across restarts for that one session, same as
    // before this fix existed.
    localServer.once('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        localServer.removeAllListeners('error');
        localServer.once('error', reject);
        bind(0);
      } else {
        reject(err);
      }
    });
    bind(FIXED_LOCAL_SERVER_PORT);
  });
}

function isSameLocalOrigin(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port === String(localServerPort);
  } catch (_) { return false; }
}

function isSafeExternalUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch (_) { return false; }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'XRP & Xahau Tax Tool',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs ipcRenderer; no remote content is ever loaded so this stays safe
    },
  });

  mainWindow.setMenuBarVisibility(false);

  // Keep the OS window title/taskbar label as "XRP & Xahau Tax Tool" rather
  // than letting it flip to the page's own <title> ("Form 8949 · ... · 2025")
  // once the renderer loads — Electron does that by default.
  mainWindow.on('page-title-updated', (event) => { event.preventDefault(); });

  mainWindow.loadURL(`http://127.0.0.1:${localServerPort}/index.html`);

  // Any link the page opens with window.open() (the "Get New Claim" and
  // "Dhali Guide" links) should go to the user's real default browser, not
  // spawn another chromeless app window.
  //
  // Only http(s) is handed to the OS. shell.openExternal() will happily
  // launch file:// paths, UNC paths and registered protocol handlers, which
  // is a well-known local-code-execution route — and the URL here comes from
  // whatever the page passed to window.open().
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Keep this window pinned to its own local origin. preload.js is attached
  // to it, so any same-window navigation to a remote page — a plain <a href>,
  // a form POST, a location.href assignment, a redirect — would hand that
  // remote page the entire window.taxDB bridge, including getAllRows() (the
  // user's complete financial history) and clearAll() (destroys the cache).
  // setWindowOpenHandler above only covers window.open()/target=_blank.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isSameLocalOrigin(url)) {
      event.preventDefault();
      if (isSafeExternalUrl(url)) shell.openExternal(url);
    }
  });

  // A renderer that dies takes the whole UI with it and leaves a blank white
  // window and nothing else — no error, no dialog, no log. That is exactly
  // what an out-of-memory kill looked like while rebuilding a multi-million
  // row cache, and it is indistinguishable from a hang unless we say so.
  mainWindow.webContents.on('render-process-gone', (_evt, details) => {
    const oom = details.reason === 'oom' || details.reason === 'crashed';
    dialog.showErrorBox(
      'XRP & Xahau Tax Tool — the page stopped responding',
      `The display process ended unexpectedly (${details.reason}` +
      (details.exitCode !== undefined ? `, exit code ${details.exitCode}` : '') + ').\n\n' +
      (oom
        ? 'This usually means it ran out of memory while processing a very large ' +
          'local cache. Your cached data is safe — nothing was written or deleted.\n\n' +
          'Reopen the app and try "View Report From Cache (offline)" on the Setup tab. ' +
          'If it keeps happening, use "Force Full Re-sync" or reduce the number of ' +
          'selected wallets and report the wallet count and row count from the Local ' +
          'Data panel.'
        : 'Your cached data is safe. Reopening the app should recover it.')
    );
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  const dbPath = path.join(app.getPath('userData'), DB_FILENAME);
  db = createDb(dbPath);
  registerIpcHandlers(db, dbPath);

  await startLocalServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((err) => {
  // Without this, a failure in here (the loopback listen being blocked, the
  // database file being unreadable) was an unhandled promise rejection: no
  // window, no error, no exit — just an app that appears not to start, with
  // nothing anywhere explaining why.
  try { dialog.showErrorBox('XRP & Xahau Tax Tool — startup failed', String((err && err.stack) || err)); } catch (_) {}
  app.quit();
});

app.on('window-all-closed', () => {
  // macOS convention: closing the window does NOT quit the app. So this must
  // not tear anything down — it previously closed BOTH the database and the
  // local HTTP server here, on every platform, while only the app.quit() was
  // guarded by the darwin check. On macOS that left the app alive in the Dock
  // with its server dead and its database closed, so clicking the Dock icon
  // reopened a window that could only fail: the page load hit
  // ERR_CONNECTION_REFUSED, and every db:* call threw "database connection is
  // not open". Nothing short of fully quitting and relaunching recovered it.
  if (process.platform !== 'darwin') app.quit();
});

// Teardown belongs on the quit path, not the window-close path. This also
// covers Cmd+Q / menu Quit, which skip 'window-all-closed' entirely and so
// previously never closed the database at all (leaving the WAL uncheckpointed).
app.on('will-quit', () => {
  if (db) { db.close(); db = null; }
  if (localServer) { localServer.close(); localServer = null; }
});

// ── IPC surface exposed to the renderer via preload.js's contextBridge ─────
function registerIpcHandlers(db, dbPath) {
  ipcMain.handle('db:getSyncState', (_evt, wallet, chain) => db.getSyncState(wallet, chain));

  ipcMain.handle('db:insertRows', (_evt, wallet, chain, rows) => db.insertRows(wallet, chain, rows));

  ipcMain.handle('db:upsertSyncState', (_evt, wallet, chain, newTimestamp) =>
    db.upsertSyncState(wallet, chain, newTimestamp));

  ipcMain.handle('db:getAllRows', (_evt, wallet, chain) => db.getAllRows(wallet, chain));

  ipcMain.handle('db:countForWallet', (_evt, wallet, chain) => db.countForWallet(wallet, chain));

  ipcMain.handle('db:clearWalletChain', (_evt, wallet, chain) => db.clearWalletChain(wallet, chain));

  ipcMain.handle('db:forceFullResync', () => db.forceFullResync());

  ipcMain.handle('db:clearAll', () => db.clearAll());

  ipcMain.handle('db:getStats', () => db.getStats());

  ipcMain.handle('db:getPath', () => dbPath);

  ipcMain.handle('db:listCachedWallets', () => db.listCachedWallets());

  ipcMain.handle('db:countForChain', (_evt, chain) => db.countForChain(chain));

  ipcMain.handle('db:getChainRowsPage', (_evt, chain, limit, cursor) =>
    db.getChainRowsPage(chain, limit, cursor));
}
