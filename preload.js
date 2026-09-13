// preload.js — the only bridge between the renderer (the tax tool's HTML/JS,
// unchanged from the browser version except where it explicitly checks for
// window.taxDB) and the main process's SQLite database. contextIsolation is
// on and nodeIntegration is off in main.js, so this is the entire surface
// area the page has access to beyond ordinary web APIs — no filesystem, no
// native modules, nothing else from Node or Electron leaks through.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('taxDB', {
  isElectron: true,

  /** @returns {Promise<string|null>} */
  getSyncState: (wallet, chain) => ipcRenderer.invoke('db:getSyncState', wallet, chain),

  /** rows: [{tx_hash, timestamp, raw_json}] -> Promise<number inserted> */
  insertRows: (wallet, chain, rows) => ipcRenderer.invoke('db:insertRows', wallet, chain, rows),

  /** @returns {Promise<void>} */
  upsertSyncState: (wallet, chain, newTimestamp) =>
    ipcRenderer.invoke('db:upsertSyncState', wallet, chain, newTimestamp),

  /** @returns {Promise<object[]>} cached raw WinDB rows for wallet+chain, oldest first */
  getAllRows: (wallet, chain) => ipcRenderer.invoke('db:getAllRows', wallet, chain),

  countForWallet: (wallet, chain) => ipcRenderer.invoke('db:countForWallet', wallet, chain),

  clearWalletChain: (wallet, chain) => ipcRenderer.invoke('db:clearWalletChain', wallet, chain),

  forceFullResync: () => ipcRenderer.invoke('db:forceFullResync'),

  /** Facts about the cache rather than in it — see db.js getMeta(). */
  getMeta: (key) => ipcRenderer.invoke('db:getMeta', key),
  setMeta: (key, value) => ipcRenderer.invoke('db:setMeta', key, value),

  clearAll: () => ipcRenderer.invoke('db:clearAll'),

  getStats: () => ipcRenderer.invoke('db:getStats'),

  getPath: () => ipcRenderer.invoke('db:getPath'),

  /** @returns {Promise<string[]>} every wallet with at least one cached row, across both chains */
  listCachedWallets: () => ipcRenderer.invoke('db:listCachedWallets'),

  /** @returns {Promise<number>} total cached rows for one chain */
  countForChain: (chain, types) => ipcRenderer.invoke('db:countForChain', chain, types),
  countByType: (chain) => ipcRenderer.invoke('db:countByType', chain),

  /**
   * One page of a chain's rows in true global chronological order across all
   * wallets. Pass cursor=null to start; feed back the returned cursor until
   * it comes back null. This is what lets the renderer process millions of
   * rows in order without ever holding more than one page.
   * @returns {Promise<{rows:{wallet:string,row:object}[], cursor:object|null}>}
   */
  // `types` is optional. With it, rows of every other type never cross this
  // boundary -- which is the point, since marshalling 6.3M objects into the
  // renderer to discard most of them was the cost.
  getChainRowsPage: (chain, limit, cursor, types) =>
    ipcRenderer.invoke('db:getChainRowsPage', chain, limit, cursor, types),

  /**
   * Ledger-verified AMM amounts, from scripts/verify-xrpl.js --amm.
   * WinDB's Amount_XRP on an AMM row is what the transaction REQUESTED; the
   * ledger delivered more in 24 of 47 comparable rows and in every comparable
   * withdrawal. These are the delivered figures. See db.js amm_ledger.
   * rows: [{wallet, tx_type, timestamp, ledger_hash, submitted, delivered, flags, note}]
   */
  importAmmLedger: (rows) => ipcRenderer.invoke('db:importAmmLedger', rows),
  getAmmLedger: () => ipcRenderer.invoke('db:getAmmLedger'),
  getAmmStats: () => ipcRenderer.invoke('db:getAmmStats'),
  clearAmmLedger: () => ipcRenderer.invoke('db:clearAmmLedger'),
});

contextBridge.exposeInMainWorld('appInfo', {
  isElectron: true,
  platform: process.platform,
  // Resolved from the main process's app.getVersion() — see the note on the
  // 'app:getVersion' handler in main.js.
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
});
