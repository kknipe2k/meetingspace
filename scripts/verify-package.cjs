'use strict';

/*
 * Packaged-bundle verifier (M05.C). After `electron-builder --dir`, this confirms the
 * SHIPPED bundle is safe + complete:
 *   - the TEST-ONLY entry (renderer/probe.html, permissive CSP) is NOT shipped;
 *   - the production entries (index.html + main.js) ARE shipped;
 *   - the bundled main carries no `dangerouslyAllowBrowser` (renderer key-escape risk).
 *
 * Pure seam (evaluatePackagedContents) is unit-tested in tests/packaging/verify-package.test.ts;
 * the asar read + fs read + process.exit in main() is the excluded OS-call wrapper — the same
 * seam/wrapper split as scripts/e2e-complete-guard.cjs. @electron/asar (electron-builder's own
 * bundled asar lib) is required lazily inside main() so the unit test can import the seam
 * without electron-builder installed.
 */
const { existsSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

/*
 * The pure decision: given the asar entry list + the bundled main source, return
 * { ok, problems[] }. A non-empty problems list means the bundle is unsafe/incomplete
 * and must NOT be reported as a clean package.
 */
function evaluatePackagedContents(asarEntries, bundledMainSource) {
  const problems = [];
  const entries = (asarEntries || []).map((entry) => String(entry).replace(/\\/g, '/'));

  const probes = entries.filter((entry) => /(^|\/)probe\.html$/i.test(entry));
  if (probes.length > 0) {
    problems.push(`test-only entry shipped in the bundle: ${probes.join(', ')} (must be excluded)`);
  }
  if (!entries.some((entry) => /(^|\/)index\.html$/i.test(entry))) {
    problems.push('production renderer entry (index.html) missing from the bundle');
  }
  if (!entries.some((entry) => /(^|\/)main\.js$/i.test(entry))) {
    problems.push('main-process entry (main.js) missing from the bundle');
  }
  if (typeof bundledMainSource === 'string' && /dangerouslyAllowBrowser/.test(bundledMainSource)) {
    problems.push('dangerouslyAllowBrowser present in the bundled main (renderer key-escape risk)');
  }

  return { ok: problems.length === 0, problems };
}

function main() {
  const root = resolve(__dirname, '..');
  // electron-builder --dir output on Windows: release/win-unpacked/resources/app.asar.
  const asarPath = join(root, 'release', 'win-unpacked', 'resources', 'app.asar');
  if (!existsSync(asarPath)) {
    console.error(
      `[verify-package] no packaged asar at ${asarPath} — run \`npm run package:dir\` first`,
    );
    process.exit(1);
  }

  // electron-builder bundles @electron/asar; require it lazily (the seam above never needs it).
  const asar = require('@electron/asar');
  const entries = asar.listPackage(asarPath);

  // The bundled main on disk is the same bytes packed into the asar.
  const mainPath = join(root, 'out', 'main', 'main.js');
  const mainSource = existsSync(mainPath) ? readFileSync(mainPath, 'utf8') : undefined;

  const { ok, problems } = evaluatePackagedContents(entries, mainSource);
  if (!ok) {
    console.error('[verify-package] shipped bundle FAILED verification — refusing to call it clean:');
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }

  console.log(
    `[verify-package] bundle OK: probe.html excluded, index.html + main.js present, ` +
      `no dangerouslyAllowBrowser (${entries.length} asar entries).`,
  );
}

if (require.main === module) {
  main();
}

module.exports = { evaluatePackagedContents };
