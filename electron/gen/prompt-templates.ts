import type { GenTemplate } from '@shared/types';

/*
 * The shipped two-part generation prompt (M04.A), app-adapted from the product
 * owner's agentic-CLI original (memory m04-whitepaper-generation). The
 * load-bearing translation: every Claude-Code file-reading artifact is removed —
 * the main process assembles the session corpus (notes as text + screenshots as
 * image content blocks) and sends it inline, so there is no file-reading tool,
 * no byte-range reads, no PDF-page parameter, no on-disk focus document, and no
 * proxy/timeout machinery. The FOCUS document's structural mandates (Section A
 * Analysis / Section B Implementation) and Part 2's self-contained-HTML +
 * illustration mandates are preserved verbatim in intent — those are exercised in
 * Stage B. This text is the editable DEFAULT seed; users fork it (template-store).
 */

// Part 1 — the FOCUS document. Distills the session corpus into a consistent,
// structured synthesis (Analysis → Implementation). App-API context: the corpus
// is supplied inline in the user turn; the model never reads files.
export const FOCUS_PROMPT = [
  'Role & Objective: Act as Lead Project Analyst / Operations Strategist / Technical',
  'Synthesizer. Synthesize the provided meeting content (transcripts, notes, weekly',
  'updates, project playbooks, or white papers) into a Targeted Comprehensive Learning',
  'Document and Detailed Program Update. Bridge the gap between abstract concepts and',
  'practical execution. Focus on the intent and flow of the source material to direct',
  'the voice and tone of the final output.',
  '',
  'The session content is supplied to you directly below as text and images — analyze',
  'it as given. Designed to work with partial information: if content is missing or',
  'incomplete, flag the gaps explicitly rather than silently assuming.',
  '',
  'Produce a FOCUS document with exactly these two sections:',
  '',
  'A: Analysis — Know',
  '- Vocabulary Extraction: the distinct lexicon of the corpus — idioms, metaphors,',
  '  technical terms. Capture the dominant Tone (Urgent / Objective / Persuasive).',
  '- Core Elements (3–5): the top concepts, entities, critical arguments, or blockers;',
  '  define each using the extracted vocabulary.',
  '- Unifying Themes (up to 10): coalesce the Core Elements into a cohesive whole;',
  '  explain how each theme unifies them.',
  '- Proof of Concept / Case Studies: specific case studies as proof of concept, with',
  '  benchmarks / metrics / KPIs / outcomes (time saved, revenue, error rates).',
  '- For a transcript, map the Narrative Arc / Run of Show — avoid abstract themes.',
  '',
  'B: Implementation — Do',
  '- Strategic Outcomes (3–5): the top tangible goals / results / finished states /',
  '  critical findings; what does success or conclusion look like?',
  '- Tactical Roadmap (up to 10 steps): actionable steps / protocols / stages in',
  '  logical or chronological order; each step advances at least one top goal.',
  '  Differentiate decisions (transcripts) vs standard procedures (project work) vs',
  '  proven evidence (white papers / papers).',
  '',
  'Output the FOCUS document directly. Do not pause to confirm, list a plan, or ask',
  'questions first.',
].join('\n');

// Part 2 — the white paper. Expands the FOCUS document into a visually rich,
// illustration-first self-contained HTML document. Exercised in Stage B; shipped
// here so the editable default carries both parts.
export const WHITEPAPER_PROMPT = [
  'Role & Objective: Act as an elite Executive Technical Writer and Strategic Analyst.',
  'Synthesize the session content and the FOCUS Document (from Part 1) into a visually',
  'rich, deeply analytical, scannable, illustration-first HTML-based White Paper.',
  '',
  'Context: the FOCUS Document is your primary reference (supplied as the persisted',
  'session artifact). Proceed directly to HTML generation; do not pause, confirm, list,',
  'or plan. Reference the original session content only for a specific quote or detail —',
  'do not bulk re-read it.',
  '',
  'Content Mandates: Zero embellishment (only corpus entities / names / acronyms /',
  'facts). Verbose and detailed (4–5 sentences per subsection; each illustration plus a',
  '100–150 word explanation). Tone executive / analytical / objective / authoritative.',
  'Scannable (short paragraphs, bullets, callouts).',
  '',
  'Formatting — Self-Contained HTML Only (SECURITY): a single minimal <style> block in',
  '<head> (under 400 lines); 8–10 CSS custom properties (colors / spacing). The body',
  '(Merriweather) and header (Inter) fonts are provided by the app; do not add external font',
  'links or external stylesheet <link> tags. NO scripts of any kind. Typography:',
  'Merriweather (serif) body, Inter (sans) headers / callouts / illustrations. Palette:',
  'light background, dark slate text, professional accents. Short paragraphs (max 3–4',
  'sentences), frequent bullets.',
  '',
  'Illustration Mandate: CSS-driven illustrations — one per major FOCUS section',
  '(Vocabulary, Core Elements, Unifying Themes, Proof of Concept, Strategic Outcomes,',
  'Tactical Roadmap) plus extra at high-impact moments. Use CSS grid / flexbox / borders',
  '/ backgrounds as named classes to build matrices, workflow diagrams, tables, and',
  'callouts. Wrap each: "Illustration X: [Concept]" + a 100–150 word explanation + the',
  'CSS layout.',
  '',
  'Output Steps: a striking dark-themed header (title + sub-headline); an Executive',
  'Summary (250–350 words from the FOCUS Document); cover each major FOCUS section with',
  'expanded prose (4–5 sentences) plus one named illustration with a detailed caption;',
  'strategic illustrations for rhythm; close with a Conclusion / Key Takeaways section',
  '(150–200 words).',
].join('\n');

// The structured-minutes system prompt (M04.C). UNLIKE the two-part white-paper
// prompt, this ships FIXED in v1 — it is NOT part of the forkable TemplateStore
// (the editable default is the white-paper FOCUS + paper pair). Minutes are a
// single SDK call over the session corpus. Same self-contained-HTML + NO-scripts
// security mandate as the white paper: the output renders through the SAME sandbox
// + sanitize path, so a no-scripts document is what keeps a prompt-injected handler
// inert. Screenshots are surfaced in-app as an adjacent gallery (the renderer adds
// them), so the minutes HTML itself references them by description, not by data URI.
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
 * M07.C round 4 — the pipeline prompt parts (REVIEW-V11 F20; ADR-0018). The white
 * paper runs FOCUS → PLAN → CSS → HTML → programmatic stitch: cheap, retryable,
 * validated steps BEFORE one proven-profile long call, and never two independent
 * authors of the same prose. Each call's system prompt is the part below COMPOSED
 * with the template's whitepaperPrompt as the <document_mandate> (so a fork's voice/
 * content customization keeps shaping the output). The output rules in each part
 * OVERRIDE conflicting format instructions in the mandate — the mandate describes
 * the whole document; the part governs this call's output shape.
 *
 * SECURITY NOTE: the "no shell / no scripts" wording below is necessary but NOT
 * sufficient — the stitch rejects shell-bearing bodies structurally, and the
 * sanitize + sandbox + CSP layers (ADR-0010) remain the load-bearing controls.
 */

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
  'Typically 4–6 sections — more only when the content genuinely demands it (AT MOST',
  '10). One illustration per major section plus extras at high-impact moments',
  '(bounded — at most 12). classNames are lowercase-hyphen css class tokens; they',
  'become the contract the stylesheet MUST define.',
  'Output the JSON directly. Do not pause, confirm, or plan further.',
].join('\n');

// The CSS call: FOCUS + the plan in, the theme stylesheet text out — written BEFORE
// the body, so the HTML author writes against a finished stylesheet.
export const CSS_PROMPT = [
  'Write the theme stylesheet for the PLANNED white paper as RAW CSS TEXT.',
  '',
  'Output rules (these override any conflicting format instruction in the document',
  'mandate below):',
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
  'Output rules (these override any conflicting format instruction in the document',
  'mandate below):',
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
