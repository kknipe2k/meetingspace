import { describe, expect, it } from 'vitest';

import {
  extractCss,
  extractVocabulary,
  MAX_PLAN_ILLUSTRATIONS,
  MAX_PLAN_SECTIONS,
  parsePlan,
  planClasses,
  stripFence,
  unstyledClasses,
} from '../../electron/gen/chunk-plan';
import { IRL_DISJOINT_CSS, IRL_DISJOINT_FRAGMENTS } from './fixtures/irl-disjoint-vocabulary';
import {
  IRL_UNTERMINATED_FENCE_COMPLETE_CSS,
  IRL_UNTERMINATED_FENCE_TRUNCATED_CSS,
} from './fixtures/irl-truncated-css';

/*
 * M07.C round 4 (the design) — the PLAN contract. Per-section chunking is dead
 * (independently-generated prose never ties out — three IRL failure classes); the
 * pipeline is FOCUS → PLAN → CSS → HTML → programmatic stitch. parsePlan is the pure
 * validation seam for the PLAN call: tolerant of the wrappers models actually emit
 * (fence/prose), STRICT where downstream breaks (sections; illustration classNames —
 * they are the CSS contract), SOFT where absence merely degrades (narrative, palette,
 * typography → ''). Bounded: ≤10 sections, ≤12 illustrations — deterministic
 * truncation (the spend/size bound). Null = a failed attempt (one retry → typed
 * failure), never silent acceptance.
 */
const VALID_PLAN = {
  sections: [
    { title: 'Introduction', brief: 'Set the stage' },
    { title: 'Conclusion', brief: 'Wrap up' },
  ],
  narrative: 'Open with stakes, close with action.',
  illustrations: [
    {
      name: 'Pattern Ladder',
      type: 'ladder',
      classNames: ['ladder', 'rung', 'callout'],
      structure: '4 rungs, badge + body',
    },
  ],
  palette: 'light surface, slate text, blue accent',
  typography: 'serif body, sans headings',
};

describe('parsePlan', () => {
  it('parses a strict JSON plan (sections + narrative + illustration inventory + direction)', () => {
    const plan = parsePlan(JSON.stringify(VALID_PLAN));
    expect(plan?.sections.map((s) => s.title)).toEqual(['Introduction', 'Conclusion']);
    expect(plan?.narrative).toContain('stakes');
    expect(plan?.illustrations[0]).toMatchObject({
      name: 'Pattern Ladder',
      type: 'ladder',
      classNames: ['ladder', 'rung', 'callout'],
    });
    expect(plan?.palette).toContain('slate');
    expect(plan?.typography).toContain('serif');
  });

  it('tolerates a ```json fence and surrounding prose (the wrappers models actually emit)', () => {
    const fenced = '```json\n' + JSON.stringify(VALID_PLAN) + '\n```';
    expect(parsePlan(fenced)?.sections.length).toBe(2);
    const prose = `Here is the plan:\n\n${JSON.stringify(VALID_PLAN)}\n\nReady to proceed.`;
    expect(parsePlan(prose)?.sections.length).toBe(2);
  });

  it('STRICT on sections: empty/missing/hole-y section lists are invalid', () => {
    expect(parsePlan(JSON.stringify({ ...VALID_PLAN, sections: [] }))).toBeNull();
    expect(parsePlan(JSON.stringify({ ...VALID_PLAN, sections: undefined }))).toBeNull();
    expect(
      parsePlan(JSON.stringify({ ...VALID_PLAN, sections: [{ title: 'No brief' }] })),
    ).toBeNull();
    expect(parsePlan('not json at all')).toBeNull();
  });

  it('STRICT on illustration classNames (the CSS contract): an invalid class token is invalid', () => {
    const bad = {
      ...VALID_PLAN,
      illustrations: [
        { name: 'X', type: 'grid', classNames: ['ok', 'not a class!'], structure: 's' },
      ],
    };
    expect(parsePlan(JSON.stringify(bad))).toBeNull();
    // Missing name/type are structural too.
    const noName = {
      ...VALID_PLAN,
      illustrations: [{ type: 'grid', classNames: ['ok'], structure: 's' }],
    };
    expect(parsePlan(JSON.stringify(noName))).toBeNull();
  });

  it('SOFT on direction: missing narrative/palette/typography default to empty strings', () => {
    const thin = {
      sections: VALID_PLAN.sections,
      illustrations: [],
    };
    const plan = parsePlan(JSON.stringify(thin));
    expect(plan).not.toBeNull();
    expect(plan?.narrative).toBe('');
    expect(plan?.palette).toBe('');
    expect(plan?.typography).toBe('');
    expect(plan?.illustrations).toEqual([]);
  });

  it('bounds the plan deterministically: ≤10 sections, ≤12 illustrations (first-N, in order)', () => {
    const big = {
      ...VALID_PLAN,
      sections: Array.from({ length: 14 }, (_, i) => ({ title: `S${i + 1}`, brief: `b${i + 1}` })),
      illustrations: Array.from({ length: 15 }, (_, i) => ({
        name: `I${i + 1}`,
        type: 'grid',
        classNames: [`c${i + 1}`],
        structure: 's',
      })),
    };
    const plan = parsePlan(JSON.stringify(big));
    expect(MAX_PLAN_SECTIONS).toBe(10);
    expect(MAX_PLAN_ILLUSTRATIONS).toBe(12);
    expect(plan?.sections.length).toBe(MAX_PLAN_SECTIONS);
    expect(plan?.sections[0]?.title).toBe('S1');
    expect(plan?.illustrations.length).toBe(MAX_PLAN_ILLUSTRATIONS);
    expect(plan?.illustrations[0]?.name).toBe('I1');
  });
});

describe('planClasses', () => {
  it('is the sorted dedup union of every illustration’s classNames — the CSS contract set', () => {
    const plan = parsePlan(
      JSON.stringify({
        ...VALID_PLAN,
        illustrations: [
          { name: 'A', type: 'grid', classNames: ['zeta', 'callout'], structure: 's' },
          { name: 'B', type: 'ladder', classNames: ['callout', 'alpha'], structure: 's' },
        ],
      }),
    );
    expect(planClasses(plan as NonNullable<typeof plan>)).toEqual(['alpha', 'callout', 'zeta']);
  });
});

/*
 * Salvaged seams (verbatim from the per-section experiment): fence/extraction
 * tolerance + strict validation for the css part, and the vocabulary machinery that
 * now powers BOTH subset guards (plan ⊆ css before the HTML call; body ⊆ css after).
 */
const THEME = ':root { --ink: #222; }\n.callout { border-left: 4px solid var(--ink); }';

describe('stripFence', () => {
  it('unwraps a ```lang fenced block (the real-run failure shape)', () => {
    expect(stripFence('\n```css\n' + THEME + '\n```\n')).toBe(THEME);
  });

  it('unwraps a bare ``` fence and leaves unfenced text alone', () => {
    expect(stripFence('```\n' + THEME + '\n```')).toBe(THEME);
    expect(stripFence(THEME)).toBe(THEME);
  });
});

describe('extractCss', () => {
  it('passes clean raw css through', () => {
    expect(extractCss(THEME)).toBe(THEME);
  });

  it('unwraps a ```css fence (the persisted-artifact repro)', () => {
    expect(extractCss('\n```css\n' + THEME + '\n```\n')).toBe(THEME);
  });

  it('unwraps a model-emitted <style> wrapper', () => {
    expect(extractCss(`<style>\n${THEME}\n</style>`)).toBe(THEME);
  });

  it('unwraps a fence wrapping a <style> wrapper (belt over braces)', () => {
    expect(extractCss('```html\n<style>' + THEME + '</style>\n```')).toBe(THEME);
  });

  it('returns null for prose / empty / rule-less text (a failed attempt, never silent)', () => {
    expect(extractCss('Sorry, I could not produce a stylesheet.')).toBeNull();
    expect(extractCss('')).toBeNull();
    expect(extractCss('```css\n\n```')).toBeNull();
  });

  /*
   * M07.C IRL fix #3 (artifact 789c90af — the third output-shape incident in three
   * consecutive real runs): an UNTERMINATED ```css fence sailed past the whole-text
   * pair regex into <style>, AND the output was truncated mid-declaration at the 16K
   * ceiling yet accepted as success. Hardening: fence LINES are stripped wherever
   * they appear (not only as complete pairs), and brace balance is the deterministic
   * truncation backstop.
   */
  it('strips fence LINES anywhere — an UNTERMINATED leading fence is removed, not passed through', () => {
    const out = extractCss('```css\n' + THEME);
    expect(out).toBe(THEME);
    expect(out).not.toContain('```');
  });

  it('strips a trailing lone fence line and a mid-text fence line', () => {
    expect(extractCss(THEME + '\n```')).toBe(THEME);
    const mid = extractCss(':root { --a: 1; }\n```\n.callout { padding: 1rem; }');
    expect(mid).not.toBeNull();
    expect(mid).not.toContain('```');
    expect(mid).toContain('.callout { padding: 1rem; }');
  });

  it('rejects UNBALANCED braces — the deterministic truncation backstop', () => {
    // Truncated mid-declaration (an open block never closed).
    expect(extractCss(':root { --a: 1; }\n.subsection {\n  margin-bottom')).toBeNull();
    // A stray close is just as unbalanced.
    expect(extractCss(':root { --a: 1; } }')).toBeNull();
  });

  it('PERMANENT REGRESSION (789c90af): the unterminated-fence + truncated-tail shape is REJECTED', () => {
    expect(extractCss(IRL_UNTERMINATED_FENCE_TRUNCATED_CSS)).toBeNull();
  });

  it('PERMANENT REGRESSION (789c90af): the unterminated-fence head over COMPLETE css is cleaned and accepted', () => {
    const out = extractCss(IRL_UNTERMINATED_FENCE_COMPLETE_CSS);
    expect(out).not.toBeNull();
    expect(out).not.toContain('```');
    expect(out).toContain('--color-teal: #0f766e');
    expect(out).toContain('.section-header');
  });
});

describe('extractVocabulary', () => {
  it('collects tags + classes, sorted and deduped (deterministic)', () => {
    const vocab = extractVocabulary([
      '<h2 class="title">A</h2><div class="callout warn"><p>x</p></div>',
      '<ul class=\'warn\'><li class="item">y</li></ul>',
    ]);
    expect(vocab.tags).toEqual(['div', 'h2', 'li', 'p', 'ul']);
    expect(vocab.classes).toEqual(['callout', 'item', 'title', 'warn']);
  });

  it('returns empty vocabularies for class-less, tag-less input', () => {
    expect(extractVocabulary(['plain text'])).toEqual({ tags: [], classes: [] });
  });
});

describe('unstyledClasses — the subset-guard workhorse', () => {
  it('names exactly the classes a stylesheet leaves undefined', () => {
    expect(unstyledClasses('.a{x:1} .b{x:1}', ['a', 'b', 'c'])).toEqual(['c']);
    expect(unstyledClasses('.a{x:1} .b{x:1}', ['a', 'b'])).toEqual([]);
  });

  it('matches class tokens with boundaries — `.tag-tool` styled does not cover `tag`', () => {
    expect(unstyledClasses('.tag-tool { color: red; }', ['tag'])).toEqual(['tag']);
    expect(unstyledClasses('.tag{} .tag-tool{}', ['tag', 'tag-tool'])).toEqual([]);
  });

  it('PERMANENT REGRESSION: the IRL artifact’s disjoint-vocabulary shape trips the guard family forever', () => {
    // The per-section experiment's terminal evidence (2026-06-11, artifact c88275c1):
    // css and body vocabularies disjoint but every call "succeeded". Any subset guard
    // over this shape must report nearly everything unstyled.
    const vocab = extractVocabulary([...IRL_DISJOINT_FRAGMENTS]);
    const missing = unstyledClasses(IRL_DISJOINT_CSS, vocab.classes);
    expect(missing.length).toBeGreaterThan(vocab.classes.length * 0.8);
    // …and an honest stylesheet over the ACTUAL vocabulary clears it completely.
    const honest = vocab.classes.map((c) => `.${c} { color: #222; }`).join('\n');
    expect(unstyledClasses(honest, vocab.classes)).toEqual([]);
  });
});
