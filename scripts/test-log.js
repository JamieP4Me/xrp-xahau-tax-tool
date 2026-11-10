#!/usr/bin/env node
/**
 * test-log — run `npm test`, write everything to test-output.log, and print
 * only the summary.
 *
 * A failing Playwright test dumps the whole renderer page as error context
 * (8,000+ lines for one failure), which buries the one line that matters.
 * This keeps the full output on disk (gitignored by *.log) and shows:
 *   - each db suite's "All ... passed" line, or its FAIL lines
 *   - Playwright's closing summary: counts plus the name of every failure
 *
 *   npm run test:log
 *
 * Exits with npm test's own exit code.
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOG = path.join(__dirname, '..', 'test-output.log');
const out = fs.createWriteStream(LOG);
const started = Date.now();
process.stdout.write('running npm test (full output -> test-output.log) ...\n');

const child = spawn('npm', ['test'], { cwd: path.join(__dirname, '..'), shell: process.platform === 'win32' });
child.stdout.pipe(out, { end: false });
child.stderr.pipe(out, { end: false });

child.on('close', (code) => {
  out.end(() => {
    const lines = fs.readFileSync(LOG, 'utf8').split('\n');
    const keep = lines.filter((l) => /^All .*passed/.test(l) || /^ {2}FAIL - /.test(l) || /test\(s\) FAILED/.test(l));
    const i = lines.findIndex((l) => /^ {2}\d+ (failed|flaky|passed|skipped|interrupted|did not run)/.test(l));
    console.log('\n' + keep.join('\n'));
    if (i >= 0) console.log('\n' + lines.slice(i).join('\n').trim());
    else if (code !== 0) console.log('\n(no Playwright summary: the run stopped earlier; last lines below)\n' + lines.slice(-25).join('\n'));
    console.log(`\n${code === 0 ? 'PASSED' : 'FAILED'} in ${Math.round((Date.now() - started) / 1000)}s · full output: test-output.log (${lines.length} lines)`);
    process.exit(code == null ? 1 : code);
  });
});
