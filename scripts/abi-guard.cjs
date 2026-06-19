'use strict';

/*
 * Pure decision seam of the dual-ABI guard (gotcha §1 / ADR-0003). better-sqlite3
 * is a native addon; it is kept at the Node ABI at rest so Vitest (Node) and CI
 * pass, and flipped to Electron's ABI only on the app run path (predev/prestart).
 * If the machine last ran the app, requiring it under Node throws a
 * NODE_MODULE_VERSION mismatch — this classifier recognises that case so the
 * wrapper (ensure-node-abi.cjs) can rebuild for Node before tests run.
 *
 * Unit-tested in tests/ci/abi-guard.test.ts; the require + npm-rebuild call is
 * the excluded OS-call layer.
 */
function isAbiMismatch(error) {
  if (!error || typeof error.message !== 'string') {
    return false;
  }
  const message = error.message;
  return (
    message.includes('NODE_MODULE_VERSION') ||
    message.includes('different Node.js version') ||
    message.includes('was compiled against a different')
  );
}

module.exports = { isAbiMismatch };
