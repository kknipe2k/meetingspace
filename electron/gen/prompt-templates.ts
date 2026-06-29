import type { GenTemplate } from '@shared/types';

/*
 * The shipped two-part generation prompt. The FOCUS + white-paper default text was
 * REPLACED at M08.A with the product owner's new proportionality-driven brief
 * (docs/mmetingspace prompts.md Part 1 / Part 2). App-API context (preserved from the
 * M04.A adaptation): the main process assembles the session corpus (notes as text +
 * screenshots as image content blocks) and sends it inline, so there is no file-reading
 * tool, no byte-range reads, no PDF-page parameter, and no on-disk focus document. The
 * white paper now emits BODY-LEVEL HTML (the app owns the shell + the single stylesheet
 * via the PLAN→CSS→HTML→stitch pipeline) — not a self-contained document. This text is
 * the editable DEFAULT seed; users fork it (template-store).
 */

// Part 1 — the FOCUS document. Distills the session corpus into a proportional,
// structured synthesis (Analysis → Implementation). App-API context: the corpus is
// supplied inline in the user turn; the model never reads files.
export const FOCUS_PROMPT = `Role & Objective: Act as Lead Project Analyst, Operations Strategist, and Technical Synthesizer.

Synthesize the supplied meeting content into a focused learning document and program update. Preserve the source’s intent, terminology, and tone while separating supported facts from assumptions.

The session content is supplied directly as text and images. Work with partial information. Do not invent missing facts, stakeholders, metrics, decisions, risks, or recommendations.

PROPORTIONALITY RULE:
The size and depth of the output must be commensurate with the amount and quality of source material.

- Tiny or fragmentary input: up to 250 words.
- Short input: up to 500 words.
- Moderate input: up to 1,000 words.
- Large, detailed input: up to 1,800 words.
- Never exceed 2,800 words.

These are maximums, not targets. Prefer the shortest complete response.

Produce these two sections:

A: Analysis — Know

Include only subsections supported by the evidence:

- Vocabulary: important terminology, idioms, metaphors, or technical language.
- Core Elements: the principal concepts, entities, arguments, or blockers.
- Unifying Themes: include only genuine connections supported by multiple facts.
- Proof or Examples: include only specific examples, benchmarks, metrics, or outcomes found in the source.
- Narrative Arc: for transcripts, summarize the actual progression of discussion.

B: Implementation — Do

Include only subsections supported by the evidence:

- Strategic Outcomes: tangible goals, decisions, findings, or finished states.
- Tactical Roadmap: actionable steps explicitly stated or reasonably implied by the source. Clearly label implications rather than presenting them as decisions.

COMPLETENESS AND RESTRAINT:

- Do not create material merely to fill every subsection.
- Do not turn missing context into the main subject of the document.
- Consolidate all material limitations into one brief “Information Gaps” note.
- Mention each fact, caveat, recommendation, or conclusion once.
- Merge overlapping ideas.
- Avoid introductory filler, restatements, and repetitive summaries.
- If the input is only a few words, return a correspondingly short analysis.
- Never fabricate substance to reach a perceived document length.

Output the FOCUS document directly. Do not pause, confirm, list a plan, or ask questions first.`;

// Part 2 — the white paper. Transforms the FOCUS document into a proportional,
// illustration-forward, BODY-LEVEL HTML white paper (the app owns the shell + the
// single stylesheet via the pipeline). This text is the document MANDATE composed with
// each pipeline call's part (PLAN/CSS/HTML); the immutable contract is composed last.
export const WHITEPAPER_PROMPT = `Role & Objective: Act as an elite Executive Technical Writer and Strategic Analyst.

Transform the supplied FOCUS document into a complete, polished, illustration-forward HTML white paper. Preserve the evidence, priorities, terminology, and uncertainty of the source.

The FOCUS document is the primary reference. Use the original session content only to verify a specific detail or quotation.

PROPORTIONALITY RULE:
Document length must be commensurate with the amount and quality of source evidence.

- Tiny or fragmentary corpus: up to 500 visible words, 2–3 substantive sections, and 1–2 illustrations.
- Short corpus: up to 1,000 visible words, 3–4 sections, and 2–4 illustrations.
- Moderate corpus: up to 2,000 visible words, up to 6 sections, and 4–7 illustrations.
- Large corpus: up to 3,500 visible words, up to 8 sections, and 6–10 illustrations.
- Very large, information-dense corpus: up to 5,500 visible words, up to 10 sections, and 8–12 illustrations.

These are maximums, not targets. Prefer the shortest document that completely communicates the supported material.

CONTENT RULES:

- Use only entities, names, acronyms, facts, decisions, metrics, and recommendations supported by the corpus.
- Do not create analysis about every missing detail.
- Consolidate missing information into one compact limitations callout.
- Do not repeat a fact, caveat, recommendation, or takeaway across sections.
- Merge overlapping sections.
- Do not restate the Executive Summary in the body or conclusion.
- If the FOCUS document is sparse, produce a short executive brief rather than padding it into a conventional white paper.
- Every section must add distinct information.

ILLUSTRATION MANDATE:

Make the document illustration-forward. Include a CSS-driven illustration for each substantive section whenever the source contains enough distinct information to visualize accurately. Prefer more useful illustrations over long prose.

For sparse input, combine related concepts into one or two compact illustrations rather than producing empty, repetitive, or speculative diagrams. An illustration may be omitted only when it would repeat nearby content, visualize missing information, or require unsupported details.

Use CSS grid, flexbox, borders, and backgrounds to create matrices, workflows, timelines, comparison tables, ladders, and callouts. Give each illustration a concise descriptive title and a brief explanation proportional to its information value.

STRUCTURE:

- A concise, striking header containing the title and optional sub-headline.
- An Executive Summary proportional to the evidence.
- Only those analytical sections supported by the FOCUS document.
- CSS-driven illustrations as directed above.
- A concise Key Takeaways section that synthesizes rather than repeats.

SCANNABILITY:

- Short paragraphs of no more than 3–4 sentences.
- Prefer bullets, compact tables, callouts, and descriptive headings.
- Use direct language and remove throat-clearing.
- Keep illustration captions concise.
- Complete every opened section, table, illustration, and HTML element.

HTML AND SECURITY:

- Output body-level HTML only unless the application explicitly requests the complete shell.
- Use semantic HTML.
- Use only classes defined in the supplied stylesheet.
- Do not emit scripts, inline event handlers, external resources, external fonts, stylesheet links, or embedded CSS.
- Do not invent class names.
- Finish the document cleanly within the assigned output budget.

Output the HTML directly. Do not pause, confirm, list a plan, or ask questions first.`;

// The structured-minutes system prompt (M04.C). This is the editable minutes mandate
// (forkable since v1.2 — the template-store carries focus + paper + minutes). Minutes
// are a single SDK call over the session corpus and, UNLIKE the white paper, return a
// complete self-contained HTML document (not body-level). M08.B composes this editable
// mandate with an immutable minutes output contract (composed last) and adds a minutes
// normalization seam. Same NO-scripts security mandate: the output renders through the
// SAME sandbox + sanitize path, so a no-scripts document keeps a prompt-injected handler
// inert. Screenshots are surfaced in-app as an adjacent gallery (the renderer adds them),
// so the minutes HTML itself references them by description, not by data URI.
export const MINUTES_PROMPT = [
  'Role & Objective: Act as a meticulous meeting secretary. Turn the supplied meeting',
  'content (transcripts, notes, screenshots) into clean, structured Meeting Minutes.',
  'Capture what was discussed, what was decided, and what happens next — faithfully,',
  'with zero embellishment (only entities / names / facts present in the content).',
  '',
  'The session content is supplied directly below as text and images. If something is',
  'missing (no attendees, no clear owner), state that explicitly rather than inventing it.',
  '',
  'Produce these sections, in order:',
  '- Header: a title and the meeting context (date/topic if present).',
  '- Summary: 2–4 sentences on the purpose and outcome.',
  '- Agenda / Topics: the discussion points, as concise bullets.',
  '- Decisions: each decision made, one per bullet.',
  '- Action Items: a table of Owner | Action | (Due, if stated). Mark unknown owners.',
  '- Notes / References: anything else worth retaining, including a brief note where a',
  '  screenshot is relevant (the app displays the screenshots alongside these minutes).',
  '',
  'Formatting — Self-Contained HTML Only (SECURITY): a single minimal <style> block in',
  '<head>; a few CSS custom properties for colors/spacing. The body (Merriweather) and',
  'header (Inter) fonts are provided by the app — do not add external font links or',
  'external stylesheet <link> tags. NO scripts of any kind, no inline event handlers.',
  'Clean, professional, scannable: clear headings, short bullets, a real <table> for',
  'action items. Output the HTML document directly — do not pause, confirm, or plan.',
].join('\n');

/*
 * M08.B — the IMMUTABLE minutes output contract. Composed LAST (composeSystemPrompt)
 * after the editable minutes mandate above, so an edited prompt can no longer fight the
 * structural + security rules (the contract block declares it overrides conflicting
 * mandate instructions). It is application-owned and is NEVER user-editable. The editable
 * mandate still controls tone, section selection, organization, and presentation; this
 * block fixes the OUTPUT SHAPE. "No scripts/handlers/external resources" here is necessary
 * but NOT sufficient — the minutes normalizer strips prohibited constructs structurally
 * (M08.B/ADR-0026) and the renderer DOMPurify + sandbox + CSP (ADR-0010) remain the
 * load-bearing security controls.
 */
export const MINUTES_OUTPUT_CONTRACT = [
  'Output a SINGLE complete, self-contained HTML document — and nothing else:',
  '- Exactly one <html> document containing one <head> and one <body>.',
  '- At most one minimal <style> block, placed inside <head>.',
  '- NO scripts, inline event handlers, iframes, forms, external resources, external',
  '  fonts, stylesheet <link> tags, @import rules, or remote URLs of any kind.',
  '- Semantic, scannable meeting-minutes markup (headings, short bullet lists, and a',
  '  real <table> for action items).',
  '- A COMPLETE response: every opened element is closed.',
  '- HTML only — no markdown code fences and no explanatory prose before or after the',
  '  document.',
].join('\n');

/*
 * M07.C round 4 — the pipeline prompt parts (REVIEW-V11 F20; ADR-0018). The white
 * paper runs FOCUS → PLAN → CSS → HTML → programmatic stitch: cheap, retryable,
 * validated steps BEFORE one proven-profile long call, and never two independent
 * authors of the same prose. M08.A flips the composition (composeSystemPrompt): each
 * call's system prompt is the template's whitepaperPrompt as the editable
 * <document_mandate> FIRST, then the part below as the immutable
 * <non_negotiable_output_contract> LAST. The contract carries recency weight and
 * declares it overrides conflicting mandate instructions — so a fork's voice/content
 * customization still shapes the output, but an edited mandate can no longer fight the
 * pipeline's per-call output shape.
 *
 * SECURITY NOTE: the "no shell / no scripts" wording below is necessary but NOT
 * sufficient — the stitch rejects shell-bearing bodies structurally (recoverable full
 * documents are normalized to a body fragment first — M08.A/ADR-0026), and the sanitize
 * + sandbox + CSP layers (ADR-0010) remain the load-bearing controls.
 */

/*
 * Contract-LAST composition (M08.A). The editable mandate is composed FIRST and the
 * immutable contract LAST, with the contract block declaring it overrides conflicting
 * mandate instructions. Shared by the white-paper PLAN/CSS/HTML calls and (M08.B) the
 * minutes call, so the precedence is identical and unit-testable in one seam.
 */
export function composeSystemPrompt(mandate: string, contract: string): string {
  return [
    '<document_mandate>',
    mandate,
    '</document_mandate>',
    '',
    '<non_negotiable_output_contract>',
    'These output rules are non-negotiable and OVERRIDE any conflicting instruction in the document mandate above.',
    contract,
    '</non_negotiable_output_contract>',
  ].join('\n');
}

// The PLAN call: FOCUS doc in, ONE structured plan out — section list, narrative arc,
// the illustration inventory (the CSS contract), and the visual direction.
export const PLAN_PROMPT = [
  'Plan the white paper. From the FOCUS document supplied below, produce ONE',
  'structured plan as STRICT JSON ONLY — no prose, no markdown fence, exactly:',
  '{"sections": [{"title": "...", "brief": "..."}],',
  ' "narrative": "the document’s narrative arc in 2-3 sentences",',
  ' "illustrations": [{"name": "...", "type": "matrix|ladder|timeline|grid|callout|...",',
  '   "classNames": ["css-class-names-this-illustration-will-use"],',
  '   "structure": "a one-line structural hint"}],',
  ' "palette": "color direction in a phrase", "typography": "type direction in a phrase"}',
  '',
  'Size the plan to the corpus (PROPORTIONALITY): fewer sections and illustrations for',
  'sparse input, more for large, information-dense input — AT MOST 10 sections and AT',
  'MOST 12 illustrations. One illustration per substantive section plus extras at',
  'high-impact moments. classNames are lowercase-hyphen css class tokens; they become',
  'the contract the stylesheet MUST define.',
  'Output the JSON directly. Do not pause, confirm, or plan further.',
].join('\n');

// The CSS call: FOCUS + the plan in, the theme stylesheet text out — written BEFORE
// the body, so the HTML author writes against a finished stylesheet.
export const CSS_PROMPT = [
  'Write the theme stylesheet for the PLANNED white paper as RAW CSS TEXT.',
  '',
  'Output rules (non-negotiable — they override any conflicting instruction in the',
  'document mandate above):',
  '- Output ONLY CSS — no <style> tag, no HTML, no markdown fence.',
  '- Define EVERY class in the plan’s illustration inventory (grid/flexbox/borders/',
  '  backgrounds per each structure hint) — the inventory is a contract, not a hint.',
  '- Also style the base semantic elements (h1-h4, p, ul/ol/li, blockquote, table/',
  '  th/td, code) plus a small set of generic layout/utility classes.',
  '- 8-10 CSS custom properties (colors/spacing) following the plan’s palette and',
  '  typography direction; body serif (Merriweather), heading sans (Inter) — the',
  '  fonts are provided by the app; NO @import, NO external URLs.',
  '- Keep the whole stylesheet MINIMAL and under 400 lines: shared rules over',
  '  per-illustration duplication — a stylesheet that runs long gets truncated and',
  '  rejected.',
  'Output the CSS directly. Do not pause, confirm, or plan.',
].join('\n');

// The HTML call — the long pole: FOCUS + the plan + THE ACTUAL STYLESHEET in, the
// complete document body out. One author, the whole output budget on content.
export const HTML_PROMPT = [
  'Write the COMPLETE white-paper body per the plan above, as body-level HTML.',
  '',
  'Output rules (non-negotiable — they override any conflicting instruction in the',
  'document mandate above):',
  '- Use ONLY the supplied stylesheet’s classes plus plain semantic HTML elements',
  '  (h1-h4, p, ul/ol, blockquote, table, div/span with the stylesheet’s classes).',
  '  Do NOT invent new class names — every class you write must exist in the',
  '  stylesheet.',
  '- Output the BODY CONTENT ONLY: no <!doctype>, <html>, <head>, <body>, and NO',
  '  <style> block or CSS of any kind — the app owns the shell and the stylesheet.',
  '- NO scripts of any kind, no inline event handlers, no external resources.',
  '- Build every planned illustration with the stylesheet’s classes per its',
  '  structure hint; follow the narrative arc and the section briefs in order.',
  'Output the HTML directly. Do not pause, confirm, or plan.',
].join('\n');

// The shipped default template is an immutable seed. Forks reference it but are
// stored separately (template-store) — the seed is never written to disk and never
// deleted or overwritten.
export const SEED_TEMPLATE_ID = 'default';

export const DEFAULT_TEMPLATE: GenTemplate = {
  id: SEED_TEMPLATE_ID,
  name: 'Default',
  focusPrompt: FOCUS_PROMPT,
  whitepaperPrompt: WHITEPAPER_PROMPT,
  planPrompt: PLAN_PROMPT,
  cssPrompt: CSS_PROMPT,
  htmlPrompt: HTML_PROMPT,
  minutesPrompt: MINUTES_PROMPT,
  isDefault: true,
};
