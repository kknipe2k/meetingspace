'use strict';

/*
 * pretest / precoverage guard (closes M01.V Finding 2). Before the Node test
 * runner loads, confirm better-sqlite3 is built for the *Node* ABI; if the
 * machine last ran the app (Electron ABI), the require throws a
 * NODE_MODULE_VERSION mismatch and we rebuild for Node so `npm test` after
 * `npm run dev`/`e2e` no longer fails the whole DB suite.
 *
 * This never flips the ABI to Electron — that is the app run path's job
 * (rebuild:electron on predev/prestart). It only restores the Node ABI at rest.
 * The pure classifier lives in abi-guard.cjs (unit-tested); the require +
 * rebuild here is the excluded OS-call wrapper.
 */
const { execSync } = require('node:child_process');

const { isAbiMismatch } = require('./abi-guard.cjs');

// better-sqlite3 lazy-loads its native addon — `require()` alone succeeds even
// when the compiled binary is the wrong ABI; the mismatch only surfaces when a
// Database is actually opened. So the probe must open one (what the tests do).
try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch (error) {
  if (!isAbiMismatch(error)) {
    throw error;
  }
  // eslint-disable-next-line no-console
  console.warn('[abi-guard] better-sqlite3 ABI mismatch — rebuilding for Node…');
  execSync('npm rebuild better-sqlite3', { stdio: 'inherit' });
}
