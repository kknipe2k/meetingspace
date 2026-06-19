/*
 * PERMANENT REGRESSION FIXTURES — M07.C IRL fail #3 (2026-06-12, artifact 789c90af).
 *
 * The third output-shape incident in three consecutive real runs: the css call's
 * output opened with a ```css fence that was NEVER CLOSED (the whole-text pair regex
 * in stripFence didn't match, so the fence line passed straight into <style>), AND
 * the output was TRUNCATED mid-declaration at the 16K max_tokens ceiling (braces
 * 208/207; the tail ends `margin-bottom` with no value, no close) — yet the call
 * "succeeded" and the broken stylesheet shipped. Both shapes below preserve the
 * artifact's head/tail verbatim (distilled rules in between).
 *
 * The guards these pin: fence LINES are stripped/rejected wherever they appear (not
 * only as complete pairs), and a brace-balance check is the deterministic truncation
 * backstop — extractCss(null) → failed attempt → retry → typed failure.
 */

// The artifact's exact failure shape: unterminated opening fence + truncated tail.
// extractCss MUST return null (the truncation backstop), forever.
export const IRL_UNTERMINATED_FENCE_TRUNCATED_CSS = [
  '',
  '```css',
  '/* ============================================================',
  '   THEME STYLESHEET',
  '   How Agents Manage Other Agents: Four Subagent Patterns in 2026',
  '   ============================================================ */',
  '',
  ':root {',
  '  --color-teal: #0f766e;',
  '  --space-lg: 2rem;',
  '  --space-2xl: 4rem;',
  '}',
  '',
  '.exec-summary li {',
  '  color: rgba(240,244,248,0.8);',
  '}',
  '',
  '.section-header {',
  '  border-top: 3px solid var(--color-teal);',
  '  padding-top: var(--space-lg);',
  '  margin-top: var(--space-2xl);',
  '}',
  '',
  '.section-header h2 {',
  '  margin-top: 0;',
  '  border-bottom: none;',
  '  padding-bottom: 0;',
  '}',
  '',
  '.subsection {',
  '  margin-bottom',
  '',
].join('\n');

// The same unterminated-fence head over a COMPLETE, balanced stylesheet: the fence
// LINE must be stripped (it is not part of a pair) and the css accepted intact.
export const IRL_UNTERMINATED_FENCE_COMPLETE_CSS = [
  '',
  '```css',
  ':root {',
  '  --color-teal: #0f766e;',
  '}',
  '',
  '.section-header {',
  '  border-top: 3px solid var(--color-teal);',
  '}',
  '',
].join('\n');
