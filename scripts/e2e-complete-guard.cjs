'use strict';

/*
 * e2e completeness guard (closes M04 D-02). M04.D reported "e2e pass" while the
 * full `npm run e2e` gate was in fact RED — a partial/stale run read as green
 * (Hard Rule §6). `forbidOnly: true` in playwright.config.ts kills the classic
 * `.only` partial-run vector; THIS guard is the second lock: after Playwright
 * exits 0, it independently confirms that EVERY declared test across EVERY spec
 * file actually ran (none filtered out, none skipped, none failed). A subset run
 * — fewer tests than the spec files declare — fails here, so "e2e green" can only
 * mean the whole suite ran.
 *
 * The declared count comes from a STATIC scan of the spec sources (the source of
 * truth), independent of the report — a grep filter that hides tests from the run
 * also hides them from the report, so the report alone can't be trusted to know
 * what *should* have run.
 *
 * Pure seam (countDeclaredTests / collectRanTests / evaluateE2eRun) is unit-tested
 * in tests/ci/e2e-complete-guard.test.ts; the fs read + process.exit in main() is
 * the excluded OS-call wrapper (same split as abi-guard.cjs).
 */
const { existsSync, readFileSync, readdirSync } = require('node:fs');
const { basename, join, resolve } = require('node:path');

// Matches a Playwright test declaration `test(` / `test.only(` but NOT
// `test.describe(` / `test.beforeEach(` / `test.afterEach(` (those keep the suite
// shape without adding a test) and not `test` embedded in another word.
const TEST_DECL = /\btest(\.only)?\s*\(/g;

function countDeclaredTests(source) {
  const matches = source.match(TEST_DECL);
  return matches ? matches.length : 0;
}

// Walk the Playwright JSON report tree and collect every spec that produced a
// result, returning the executed-test count and the set of spec basenames seen.
function collectRanTests(report) {
  const ranFiles = new Set();
  let ranTestCount = 0;
  const walk = (suites, inheritedFile) => {
    for (const suite of suites ?? []) {
      const file = suite.file ?? inheritedFile;
      for (const _spec of suite.specs ?? []) {
        ranTestCount += 1;
        if (file) {
          ranFiles.add(basename(file));
        }
      }
      walk(suite.suites, file);
    }
  };
  walk(report.suites);
  return { ranTestCount, ranFiles };
}

/*
 * The pure decision: given the parsed report and the statically-declared spec
 * files + total test count, return { ok, problems[] }. A non-empty problems list
 * means the run was partial / not-clean and must NOT be reported as green.
 */
function evaluateE2eRun(report, declared) {
  const problems = [];
  const stats = report.stats ?? {};

  if (typeof stats.expected !== 'number') {
    problems.push('report has no stats — cannot confirm a complete run');
  }
  if ((stats.unexpected ?? 0) > 0) {
    problems.push(`${stats.unexpected} test(s) failed`);
  }
  if ((stats.skipped ?? 0) > 0) {
    problems.push(`${stats.skipped} test(s) skipped — a skip can mask a partial run`);
  }

  const { ranTestCount, ranFiles } = collectRanTests(report);

  for (const file of declared.specFiles) {
    if (!ranFiles.has(file)) {
      problems.push(`spec "${file}" declares tests but produced no results (did not run)`);
    }
  }

  if (ranTestCount !== declared.testCount) {
    problems.push(
      `ran ${ranTestCount} of ${declared.testCount} declared tests — a partial run cannot be reported as green`,
    );
  }

  return { ok: problems.length === 0, problems };
}

function main() {
  const root = resolve(__dirname, '..');
  const reportPath = join(root, 'test-results', 'e2e-results.json');
  if (!existsSync(reportPath)) {
    console.error(
      `[e2e-complete] no report at ${reportPath} — Playwright must run with the json reporter before this guard`,
    );
    process.exit(1);
  }

  const report = JSON.parse(readFileSync(reportPath, 'utf8'));

  const specDir = join(root, 'tests', 'e2e');
  const specFiles = new Set();
  let testCount = 0;
  for (const entry of readdirSync(specDir)) {
    if (!entry.endsWith('.spec.ts')) {
      continue;
    }
    const declared = countDeclaredTests(readFileSync(join(specDir, entry), 'utf8'));
    if (declared > 0) {
      specFiles.add(entry);
      testCount += declared;
    }
  }

  const { ok, problems } = evaluateE2eRun(report, { specFiles, testCount });
  if (!ok) {
    console.error('[e2e-complete] e2e run is NOT a clean, complete suite — refusing to report green:');
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }

  console.log(
    `[e2e-complete] all ${testCount} declared tests across ${specFiles.size} spec files ran (0 skipped, 0 failed).`,
  );
}

if (require.main === module) {
  main();
}

module.exports = { countDeclaredTests, collectRanTests, evaluateE2eRun };
