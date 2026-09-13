#!/usr/bin/env node
/**
 * Refuses to install on a Node version this project cannot build on.
 *
 * WHY THIS EXISTS
 *
 * better-sqlite3 is a native addon, so `npm ci` compiles it against whatever
 * Node happens to be first on PATH. Homebrew moves its default `node` forward
 * aggressively, and recent V8 releases removed APIs the addon still uses
 * (`v8::Object::GetPrototype`, `Context::GetIsolate`,
 * `PropertyCallbackInfo::This`). The result is a wall of C++ errors:
 *
 *     ./src/util/binder.lzz:40:37: error: no member named 'GetPrototype' in 'v8::Object'
 *
 * followed, confusingly, by `electron-rebuild: command not found` and
 * `electron: command not found` — because the failed install left
 * node_modules half-unpacked, so the next two commands look like a second,
 * unrelated problem. Nothing in that output names the actual cause.
 *
 * This runs as `preinstall`, before a single dependency is fetched, and says
 * the one thing that matters in one line.
 *
 * NOT `engines` + engine-strict: that would also enforce every transitive
 * dependency's declared engine range, which fails on packages that are merely
 * conservative in their metadata. The `engines` field is still declared in
 * package.json as documentation; this is what actually stops the build.
 */
'use strict';

// Node 20 was supported while Electron 33 bundled it. Electron 33 went
// end-of-life on 2025-04-29 -- 33.4.11 was its final release, and it was
// still what this app shipped 17 months later. Electron 44 bundles Node 24,
// and better-sqlite3 13 declares engines >=22, so 20 can no longer build
// this project at all. @electron/rebuild additionally wants >=22.12.
const SUPPORTED = [22, 24];
const major = Number(process.versions.node.split('.')[0]);

if (SUPPORTED.includes(major) || process.env.XRPTAX_SKIP_NODE_CHECK === '1') {
  process.exit(0);
}

const bar = '─'.repeat(72);
console.error(`
${bar}
  Node ${process.versions.node} will not build this project.

  better-sqlite3 is a native addon and does not compile against Node ${major}.
  Supported: Node ${SUPPORTED.join(' or ')}   (CI and the release builds use 20.)

  On macOS with Homebrew:

      export PATH="/opt/homebrew/opt/node@20/bin:$PATH"
      node -v            # must print v20.x
      rm -rf node_modules
      npm ci

  That export lasts only for the current terminal window. To make it stick,
  add the same line to ~/.zshrc.

  If node@20 is not installed:   brew install node@20

  Node is here: ${process.execPath}

  To override this check anyway:  XRPTAX_SKIP_NODE_CHECK=1 npm ci
${bar}
`);
process.exit(1);
