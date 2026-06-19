/*
 * The PLAN contract + the model-text seams (M07.C round 4 — the design). Per-section
 * chunking is dead (three IRL failure classes; independently-generated prose never
 * ties out — ADR-0018). The pipeline is FOCUS → PLAN → CSS → HTML → programmatic
 * stitch, and this module owns every pure seam between model text and the pipeline:
 *
 *  - parsePlan: the PLAN call's tolerant-parse / strict-validate seam. STRICT where
 *    downstream breaks (sections; illustration classNames — they are the CSS
 *    contract, token-validated), SOFT where absence merely degrades (narrative,
 *    palette, typography → ''). Bounded: ≤MAX_PLAN_SECTIONS sections,
 *    ≤MAX_PLAN_ILLUSTRATIONS illustrations — deterministic first-N truncation.
 *    Null = a failed attempt (one retry → typed failure), never silent acceptance.
 *  - stripFence/extractCss: fence/<style>-wrapper tolerance + ≥1-rule validation
 *    (IRL fix #1, carried verbatim).
 *  - extractVocabulary/unstyledClasses: the subset-guard workhorses (IRL fix #2,
 *    inverted): plan ⊆ css before the HTML call; body ⊆ css after it.
 */
export interface OutlineSection {
  readonly title: string;
  readonly brief: string;
}

export interface IllustrationSpec {
  readonly name: string;
  readonly type: string;
  readonly classNames: string[];
  readonly structure: string;
}

export interface DocPlan {
  readonly sections: OutlineSection[];
  readonly narrative: string;
  readonly illustrations: IllustrationSpec[];
  readonly palette: string;
  readonly typography: string;
}

export const MAX_PLAN_SECTIONS = 10;
export const MAX_PLAN_ILLUSTRATIONS = 12;

// A css class token — the only shape the CSS contract accepts (an invalid token
// would poison the subset guards and the stylesheet).
const CLASS_TOKEN = /^[A-Za-z_][\w-]*$/;

// Candidate JSON texts in preference order: the raw text, the first fenced block's
// body, and the first-{ … last-} slice (prose-wrapped). The first that parses into a
// valid plan wins — tolerance in parsing, strictness in validation.
function candidates(raw: string): string[] {
  const out = [raw];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  if (fenced?.[1]) {
    out.push(fenced[1]);
  }
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) {
    out.push(raw.slice(first, last + 1));
  }
  return out;
}

function softString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asSections(value: unknown): OutlineSection[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const out: OutlineSection[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      return null;
    }
    const { title, brief } = entry as { title?: unknown; brief?: unknown };
    // No silent holes: every section needs a non-empty title AND brief (a hole would
    // become an unwritable part of the document).
    if (
      typeof title !== 'string' ||
      typeof brief !== 'string' ||
      title.trim().length === 0 ||
      brief.trim().length === 0
    ) {
      return null;
    }
    out.push({ title, brief });
  }
  return out.slice(0, MAX_PLAN_SECTIONS);
}

function asIllustrations(value: unknown): IllustrationSpec[] | null {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const out: IllustrationSpec[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      return null;
    }
    const { name, type, classNames, structure } = entry as {
      name?: unknown;
      type?: unknown;
      classNames?: unknown;
      structure?: unknown;
    };
    if (
      typeof name !== 'string' ||
      name.trim().length === 0 ||
      typeof type !== 'string' ||
      type.trim().length === 0 ||
      !Array.isArray(classNames)
    ) {
      return null;
    }
    // The classNames are the CSS contract — strict token validation; one bad token
    // invalidates the plan (it would poison the subset guards downstream).
    for (const token of classNames) {
      if (typeof token !== 'string' || !CLASS_TOKEN.test(token)) {
        return null;
      }
    }
    out.push({
      name,
      type,
      classNames: classNames as string[],
      structure: softString(structure),
    });
  }
  return out.slice(0, MAX_PLAN_ILLUSTRATIONS);
}

function asPlan(parsed: unknown): DocPlan | null {
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const sections = asSections(record.sections);
  if (sections === null) {
    return null;
  }
  const illustrations = asIllustrations(record.illustrations);
  if (illustrations === null) {
    return null;
  }
  return {
    sections,
    narrative: softString(record.narrative),
    illustrations,
    palette: softString(record.palette),
    typography: softString(record.typography),
  };
}

export function parsePlan(raw: string): DocPlan | null {
  for (const candidate of candidates(raw)) {
    try {
      const plan = asPlan(JSON.parse(candidate));
      if (plan !== null) {
        return plan;
      }
    } catch {
      // Not JSON in this form — try the next candidate.
    }
  }
  return null;
}

/** The sorted dedup union of every illustration's classNames — the CSS contract set. */
export function planClasses(plan: DocPlan): string[] {
  const all = new Set<string>();
  for (const illustration of plan.illustrations) {
    for (const name of illustration.classNames) {
      all.add(name);
    }
  }
  return [...all].sort();
}

/*
 * The fence/extraction seams (IRL fix #1, carried verbatim): models wrap output in
 * markdown fences and <style> tags despite prompts — tolerate the wrappers, then
 * validate strictly. Prompt mandates are necessary, not sufficient.
 */
const FENCE = /^\s*```[a-z]*\s*\n?([\s\S]*?)\n?\s*```\s*$/i;

/** Unwrap a whole-text markdown fence (```lang … ``` or ``` … ```); pass-through otherwise. */
export function stripFence(raw: string): string {
  const match = FENCE.exec(raw);
  return match?.[1] ?? raw;
}

const STYLE_WRAP = /^<style[^>]*>([\s\S]*?)<\/style>\s*$/i;

// A line that is nothing but a markdown fence. IRL fix #3 (artifact 789c90af): an
// UNTERMINATED ```css fence sailed past the whole-text PAIR regex straight into
// <style> — fence lines are stripped wherever they appear, pairs or strays alike.
const FENCE_LINE = /^\s*```[a-z]*\s*$/i;

function stripFenceLines(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => !FENCE_LINE.test(line))
    .join('\n');
}

/**
 * The css part's tolerant-extraction + strict-validation seam: unwrap fences (paired
 * OR stray lines — 789c90af) and a model-emitted <style> wrapper, then require at
 * least one actual rule AND balanced braces — the brace balance is the deterministic
 * TRUNCATION backstop (a stylesheet cut at the max_tokens ceiling ends mid-block).
 * Null = a failed attempt (the service retries once, then fails the run typed) — a
 * broken stylesheet must NEVER be silently accepted.
 */
export function extractCss(raw: string): string | null {
  let css = stripFenceLines(stripFence(raw)).trim();
  const wrapped = STYLE_WRAP.exec(css);
  if (wrapped?.[1] !== undefined) {
    css = stripFenceLines(stripFence(wrapped[1].trim())).trim();
  }
  if (css.length === 0 || !/\{[^{}]*\}/.test(css)) {
    return null;
  }
  if ((css.match(/\{/g) ?? []).length !== (css.match(/\}/g) ?? []).length) {
    return null;
  }
  return css;
}

/*
 * The subset-guard workhorses (IRL fix #2, inverted for round 4). The cross-call
 * contract lesson: independent generations share no vocabulary unless one side is fed
 * the other's ground truth AND the result is guarded at run time — agreeing fixtures
 * are structurally blind to the gap (it shipped past a fully green board twice).
 */
export interface MarkupVocabulary {
  readonly tags: string[];
  readonly classes: string[];
}

/** The markup's REAL vocabulary — sorted + deduped (deterministic). */
export function extractVocabulary(fragments: ReadonlyArray<string>): MarkupVocabulary {
  const tags = new Set<string>();
  const classes = new Set<string>();
  for (const html of fragments) {
    for (const match of html.matchAll(/<([a-z][a-z0-9-]*)/gi)) {
      tags.add((match[1] as string).toLowerCase());
    }
    for (const match of html.matchAll(/class\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      for (const name of (match[1] ?? match[2] ?? '').split(/\s+/)) {
        if (name.length > 0) {
          classes.add(name);
        }
      }
    }
  }
  return { tags: [...tags].sort(), classes: [...classes].sort() };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Token-bounded: `.tag-tool` styled does NOT cover the class `tag`.
function isStyled(css: string, className: string): boolean {
  return new RegExp(`\\.${escapeRegExp(className)}(?![\\w-])`).test(css);
}

/** The classes a stylesheet leaves undefined — both subset guards + the repair asks. */
export function unstyledClasses(css: string, classes: ReadonlyArray<string>): string[] {
  return classes.filter((name) => !isStyled(css, name));
}
