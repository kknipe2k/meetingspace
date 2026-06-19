/*
 * PERMANENT REGRESSION FIXTURE — M07.C IRL fail #2 (2026-06-11, artifact c88275c1).
 *
 * The real run's cross-call contract gap, distilled: the css call invented a BEM
 * vocabulary (`wp-header__*`, `pattern-ladder__*`, `exec-summary__*` — 140 classes)
 * while the section calls invented a different one (`section-heading`, `ladder-rung`,
 * `rung-badge` — 328 classes). Intersection: 3. Selector coverage: 10/190 (5.3%) —
 * only the universal base (:root, the star selector, html, body, code) plus three
 * lucky collisions matched, so the document rendered devoid of formatting while
 * every individual call "succeeded".
 *
 * The class names below are taken VERBATIM from the persisted artifact (a sample of
 * each side, preserving the 3-class lucky intersection). The subset-guard family
 * (unstyledClasses) must flag this shape forever; fakes authored to agree can never
 * re-create it.
 */

// The css call's side: rules over the vocabulary the CSS invented (verbatim names).
export const IRL_DISJOINT_CSS = [
  ':root { --color-bg: #f4f3ef; --color-accent: #2d6be4; }',
  'body { font-family: Merriweather, Georgia, serif; }',
  '.wp-header { padding: 3rem; background: var(--color-bg); }',
  '.wp-header__eyebrow { letter-spacing: 0.2em; }',
  '.wp-header__title { font-size: 2.4rem; }',
  '.wp-header__subtitle { color: #5a6a7a; }',
  '.wp-header__meta { display: flex; }',
  '.wp-header__meta-item { margin-right: 1rem; }',
  '.wp-body { max-width: 960px; }',
  '.wp-section { margin-top: 2.5rem; }',
  '.wp-section__number { font-weight: 700; }',
  '.wp-section__title { font-size: 1.6rem; }',
  '.wp-section__lead { font-size: 1.1rem; }',
  '.exec-summary { border-left: 4px solid var(--color-accent); }',
  '.exec-summary__label { text-transform: uppercase; }',
  '.exec-summary__title { font-weight: 800; }',
  '.illustration { background: #fff; }',
  '.illustration__header { display: flex; }',
  '.illustration__tag { font-size: 0.7rem; }',
  '.illustration__title { font-weight: 700; }',
  '.illustration__canvas { padding: 1.5rem; }',
  '.illustration__caption { color: #5a6a7a; }',
  '.pattern-ladder { display: grid; }',
  '.pattern-ladder__rung { border: 1px solid #d1d9e0; }',
  '.pattern-ladder__rung--p1 { background: #eef0f4; }',
  '.pattern-ladder__rung--p2 { background: #e2e8f0; }',
  '.pattern-ladder__head { font-weight: 700; }',
  '.pattern-ladder__body { padding: 1rem; }',
  // The three LUCKY collisions the real run happened to share — kept so the fixture's
  // coverage is the realistic ~3/30, not an artificial absolute zero.
  '.failure-matrix { border-collapse: collapse; }',
  '.callout { border-left: 4px solid var(--color-accent); }',
  '.callout--warning { background: #fff7ed; }',
].join('\n');

// The section calls' side: fragments using the vocabulary the SECTIONS invented
// (verbatim names from the artifact body; the same 3 collisions included).
export const IRL_DISJOINT_FRAGMENTS: readonly string[] = [
  [
    '<h2 class="section-heading">Core Elements</h2>',
    '<p class="section-intro">Lead paragraph.</p>',
    '<div class="illustration-block">',
    '<span class="illustration-label">Illustration 1</span>',
    '<div class="ladder-diagram">',
    '<div class="ladder-rung rung-1"><span class="rung-badge">P1</span>',
    '<div class="rung-body"><span class="rung-title">Pattern</span>',
    '<span class="rung-subtitle">Subtitle</span>',
    '<span class="rung-tags"><span class="tag tag-tool">tool</span><span class="tag tag-model">model</span></span>',
    '</div><span class="rung-arrow">→</span></div>',
    '<span class="ladder-axis-label"><span class="axis-arrow-up">↑</span><span class="axis-text">autonomy</span></span>',
    '</div>',
    '<p class="illustration-caption">Caption text.</p>',
    '</div>',
  ].join(''),
  [
    '<h3 class="subsection-heading">Details</h3>',
    '<ul class="detail-list"><li>One</li></ul>',
    '<div class="callout-block callout-key-insight"><span class="callout-icon">!</span>Key insight</div>',
    '<table class="failure-matrix"><tr><td>x</td></tr></table>',
    '<div class="callout callout--warning">Warning</div>',
  ].join(''),
];
