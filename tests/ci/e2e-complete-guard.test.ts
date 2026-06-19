import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

// The pure decision seam of the e2e completeness guard (D-02). The fs read +
// process.exit in scripts/e2e-complete-guard.cjs main() is the excluded OS-call
// wrapper; the count/collect/evaluate logic that decides "was this a complete
// run?" is testable against fixture reports.
const require = createRequire(import.meta.url);
const { countDeclaredTests, collectRanTests, evaluateE2eRun } =
  require('../../scripts/e2e-complete-guard.cjs') as {
    countDeclaredTests: (source: string) => number;
    collectRanTests: (report: unknown) => { ranTestCount: number; ranFiles: Set<string> };
    evaluateE2eRun: (
      report: unknown,
      declared: { specFiles: Set<string>; testCount: number },
    ) => { ok: boolean; problems: string[] };
  };

// A report with one spec file ("a.spec.ts") holding `count` passing tests.
function reportFor(file: string, count: number, stats?: Record<string, number>): unknown {
  return {
    stats: { expected: count, unexpected: 0, skipped: 0, flaky: 0, ...stats },
    suites: [
      { file, specs: Array.from({ length: count }, (_, i) => ({ title: `t${i}` })), suites: [] },
    ],
  };
}

describe('countDeclaredTests', () => {
  it('counts test() and test.only() but not describe/hooks', () => {
    const source = `
      test.describe('group', () => {
        test('one', () => {});
        test.only('two', () => {});
        test.beforeEach(() => {});
        test.afterEach(() => {});
      });
      test('three', () => {});
    `;
    expect(countDeclaredTests(source)).toBe(3);
  });

  it('does not match test embedded in another identifier', () => {
    expect(countDeclaredTests('const latest = greatest(); retest();')).toBe(0);
  });

  it('returns 0 for a source with no tests', () => {
    expect(countDeclaredTests('export const x = 1;')).toBe(0);
  });
});

describe('collectRanTests', () => {
  it('counts specs across nested suites and inherits the file name', () => {
    const report = {
      suites: [
        {
          file: 'nested.spec.ts',
          specs: [{ title: 'top' }],
          suites: [{ specs: [{ title: 'inner-a' }, { title: 'inner-b' }] }],
        },
      ],
    };
    const { ranTestCount, ranFiles } = collectRanTests(report);
    expect(ranTestCount).toBe(3);
    expect([...ranFiles]).toEqual(['nested.spec.ts']);
  });
});

describe('evaluateE2eRun', () => {
  it('passes when every declared test ran clean', () => {
    const result = evaluateE2eRun(reportFor('a.spec.ts', 5), {
      specFiles: new Set(['a.spec.ts']),
      testCount: 5,
    });
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it('fails a partial run — fewer tests ran than declared', () => {
    const result = evaluateE2eRun(reportFor('a.spec.ts', 3), {
      specFiles: new Set(['a.spec.ts']),
      testCount: 5,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/ran 3 of 5 declared/);
  });

  it('fails when a declared spec file produced no results', () => {
    const result = evaluateE2eRun(reportFor('a.spec.ts', 5), {
      specFiles: new Set(['a.spec.ts', 'b.spec.ts']),
      testCount: 5,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/b\.spec\.ts.*did not run/);
  });

  it('fails on any skipped test (a skip can mask a partial run)', () => {
    const result = evaluateE2eRun(reportFor('a.spec.ts', 4, { skipped: 1, expected: 4 }), {
      specFiles: new Set(['a.spec.ts']),
      testCount: 5,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/skipped/);
  });

  it('fails on any unexpected failure', () => {
    const result = evaluateE2eRun(reportFor('a.spec.ts', 5, { unexpected: 1 }), {
      specFiles: new Set(['a.spec.ts']),
      testCount: 5,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/failed/);
  });

  it('fails when the report has no stats at all', () => {
    const result = evaluateE2eRun({ suites: [] }, { specFiles: new Set(), testCount: 0 });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/no stats/);
  });
});
