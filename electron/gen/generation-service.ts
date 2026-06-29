import type {
  GenDocument,
  GenDone,
  GenFocusRequest,
  GenKind,
  GenMinutesRequest,
  GenProgress,
  GenWhitepaperRequest,
  LlmContentBlock,
  LlmHeartbeat,
  LlmUsage,
} from '@shared/types';
import { DEFAULT_GENERATION_MODEL, maxOutputTokensFor } from '@shared/models';
import { GENERATION_MAX_TOKENS } from '@shared/limits';

import type {
  AnthropicClientFactory,
  AnthropicClientOptions,
  ChunkHandler,
  StreamResult,
} from '../llm/anthropic-client';
import { LlmServiceError, mapAnthropicError } from '../llm/errors';

import { assembleDocument, fragmentViolation, isDocumentShellMarker } from './assembly';
import { normalizeBodyFragment, normalizeMinutesDocument } from './normalize-html';
import {
  extractCss,
  extractVocabulary,
  parsePlan,
  planClasses,
  stripFence,
  unstyledClasses,
  type DocPlan,
} from './chunk-plan';
import type { CorpusAssetReader, CorpusNoteReader } from './corpus';
import { buildCorpus } from './corpus';
import {
  composeSystemPrompt,
  CSS_PROMPT,
  DEFAULT_TEMPLATE,
  HTML_PROMPT,
  MINUTES_OUTPUT_CONTRACT,
  MINUTES_PROMPT,
  PLAN_PROMPT,
  SEED_TEMPLATE_ID,
} from './prompt-templates';
import type { GenTemplate } from '@shared/types';

/*
 * The generation service (M04.A → M04.B; M07.C chunks the white paper). The seam
 * between the typed gen IPC handler and the REUSED M03 Anthropic client (no second SDK
 * surface). It reads the key from KeyStore.getKeyForMain() ON EVERY CALL (never cached
 * anywhere a renderer/IPC path can reach — Hard Rule §10), assembles the session corpus
 * MAIN-SIDE, and re-raises failures as the M03 typed, KEY-FREE LlmServiceError taxonomy.
 *
 * M07.C round 4 (REVIEW-V11 F20; ADR-0018) — the white-paper pipeline. Per-section
 * chunking is DEAD (independently-generated prose never ties out): the pipeline is
 * FOCUS (existing; persisted and reused) → PLAN call (cheap, structured: sections +
 * narrative + the illustration inventory + visual direction) → CSS call (cheap;
 * subset guard #1: plan classes ⊆ stylesheet) → HTML call (the long pole; ONE author
 * writing the complete body AGAINST THE ACTUAL STYLESHEET; body-only validated) →
 * subset guard #2 (body classes ⊆ stylesheet; remedied by an incremental CSS-PATCH
 * call — the HTML call is never retried for a styling gap) → PURE programmatic stitch
 * → ONE persisted whitepaper artifact. Cheap retryable validated steps BEFORE one
 * proven-profile long call; the watchdog tiers + 1200 s ceiling apply PER CALL; spend
 * is a CONSTANT bound: ≤ 1 + 2×3 calls + 2 patch attempts. There is deliberately NO
 * whole-run ceiling — per-call tiers + the visible elapsed counter + the always-
 * available cancel + the bounded call count are the run-level controls (ADR-0018).
 *
 * The plan/css/body live in IN-RUN locals — never persisted: they are meaningless
 * outside their run, and cancel/fail semantics stay trivially provable (nothing
 * stitched or persisted as final; the persisted FOCUS intermediate is kept — A's
 * pattern). FOCUS rides as the single CACHED prefix block on every downstream call
 * (cache reads ~0.1x replace full-price re-sends — ADR-0018 cost analysis).
 *
 * Empty session: if there is nothing to ground on and no prior FOCUS artifact, the
 * service emits a single no-content marker and resolves WITHOUT calling the SDK.
 */
export interface GenKeyReader {
  getKeyForMain(): string | null;
}

export interface GenTemplateReader {
  getTemplate(id: string): GenTemplate | null;
}

export interface GenArtifactWriter {
  saveArtifact(input: {
    sessionId: string;
    kind: GenKind;
    content: string;
    templateId: string | null;
    // The answering model (M05.A migration v5) — optional; absent → stored NULL.
    model?: string | null;
  }): GenDocument;
}

// Part 2 reads the persisted FOCUS doc — so the artifact dependency must read as
// well as write.
export interface GenArtifactStore extends GenArtifactWriter {
  getLatestArtifact(sessionId: string, kind: GenKind): GenDocument | null;
}

export interface GenStreamHandlers {
  onChunk: ChunkHandler;
  // Per-step progress (M07.C open shape). Optional so single-step callers stay valid.
  onProgress?: (progress: GenProgress) => void;
  // M07.A: external cancel + heartbeat, threaded to the client. Optional so existing
  // callers (and tests) build the client with exactly { apiKey } as before. A cancelled
  // run aborts the stream AND persists nothing (the guard below each saveArtifact).
  signal?: AbortSignal;
  onHeartbeat?: (heartbeat: LlmHeartbeat) => void;
}

export interface GenerationService {
  generateFocus(request: GenFocusRequest, handlers: GenStreamHandlers): Promise<GenDone>;
  generateWhitepaper(request: GenWhitepaperRequest, handlers: GenStreamHandlers): Promise<GenDone>;
  generateMinutes(request: GenMinutesRequest, handlers: GenStreamHandlers): Promise<GenDone>;
  // Raw mode: assemble the saved notes into a document MAIN-SIDE with NO SDK call
  // (the saved-and-searchable path) — synchronous, spends no tokens, reads no key.
  buildRawDoc(sessionId: string): string;
}

export interface GenerationServiceDeps {
  keyStore: GenKeyReader;
  clientFactory: AnthropicClientFactory;
  templates: GenTemplateReader;
  notes: CorpusNoteReader;
  assets: CorpusAssetReader;
  artifacts: GenArtifactStore;
  // M07.D (D.3 item 7): the per-model output ceiling source for the model-aware cap. Injected
  // so the below-32K branch is deterministically testable; defaults to the static seeds. A
  // DEFENSIVE FLOOR — for every current model (≥64K) it resolves to the static 32000, identical
  // to before; its live value only guards a sub-32K/gateway-presented model from a max_tokens
  // 400 (using the 32–64K band stays deliberately deferred). Returns null → static fallback.
  modelMaxTokens?: (model: string) => number | null;
  // Audit S3-001: validates the renderer-supplied model against the catalog main-side. Injected so
  // production can use the LIVE catalog (main.ts → modelCatalog.isKnownModel); defaults to the
  // static-catalog floor (maxOutputTokensFor) so the check is ALWAYS on, never contingent on wiring.
  isKnownModel?: (model: string) => boolean;
  // M06.D (ADR-0021): the passive usage recorder. Records a run's REAL usage on SUCCESS only — a
  // cancelled run (which persists no artifact, F11) records nothing. Optional so existing callers/
  // tests are valid; never carries the key.
  usage?: GenUsageRecorder;
}

export interface GenUsageRecorder {
  record(input: { sessionId: string; kind: GenKind; model?: string | null; usage: LlmUsage }): void;
}

// The white-paper generation output cap (single-sourced in shared/limits at M06.D so the
// Settings FYI label and this cap agree). Re-exported so existing importers are unchanged.
export { GENERATION_MAX_TOKENS };

// Streamed back in place of an SDK call when the session has nothing to generate
// from — a graceful affordance, not an error.
export const NO_CONTENT_GENERATION_MESSAGE =
  "This session doesn't have any notes or screenshots yet. Add some content, then generate a document.";

// The user-turn directive that follows the assembled corpus (Part 1).
const FOCUS_DIRECTIVE = 'Produce the FOCUS document from the session content above.';

// The user-turn directive that follows the assembled corpus for minutes (M04.C).
const MINUTES_DIRECTIVE = 'Produce the meeting minutes from the session content above.';

// The pipeline directives (M07.C round 4). The cached FOCUS prefix precedes them.
const PLAN_DIRECTIVE = 'Produce the structured document plan from the FOCUS document above.';
const CSS_DIRECTIVE = 'Write the theme stylesheet for the planned document above.';
const HTML_DIRECTIVE =
  'Write the complete document body per the plan above, using ONLY the stylesheet’s classes plus semantic HTML elements.';

// One retry per LLM call (plan / css / html / css-patch) — bounded containment,
// never elastic, and NEVER on CANCELLED (a cancel is not a failure to retry away).
const CALL_ATTEMPTS = 2;

/*
 * Step-tagged typed failures (M07.C fix #4 — no blind UNKNOWN). The copy is composed
 * ONLY from the fixed labels below — never model output, never anything dynamic
 * (Hard Rule §10 stays intact) — so the user learns WHICH step and WHICH validation
 * failed ("Styling the document failed — stylesheet validation."). The taxonomy code
 * stays UNKNOWN: no new error model, just a static detail on the existing class.
 */
type PipelineStep = 'plan' | 'css' | 'html' | 'patch';
type PipelineValidation = 'plan' | 'stylesheet' | 'structure' | 'truncated';

const STEP_LABEL: Record<PipelineStep, string> = {
  plan: 'Planning the document',
  css: 'Styling the document',
  html: 'Writing the document',
  patch: 'Repairing the stylesheet',
};

const VALIDATION_LABEL: Record<PipelineValidation, string> = {
  plan: 'plan validation',
  stylesheet: 'stylesheet validation',
  structure: 'document-structure validation',
  truncated: 'output truncated at the length limit',
};

function stepFailure(step: PipelineStep, validation: PipelineValidation): LlmServiceError {
  return new LlmServiceError(
    'UNKNOWN',
    `${STEP_LABEL[step]} failed — ${VALIDATION_LABEL[validation]}.`,
  );
}

// M08.B: minutes failures reuse the white-paper UNKNOWN code + VALIDATION_LABEL phrasing so
// the user sees ALIGNED copy ("Writing the minutes failed — output truncated at the length
// limit." / "— document-structure validation."). Static + content-free (Hard Rule §10) —
// never carries model output, never the generated body.
function minutesFailure(validation: 'truncated' | 'structure'): LlmServiceError {
  return new LlmServiceError(
    'UNKNOWN',
    `Writing the minutes failed — ${VALIDATION_LABEL[validation]}.`,
  );
}

// IRL fix #3 (artifact 789c90af): a call that hit the max_tokens ceiling produced a
// TRUNCATED output that was accepted as success. stop_reason is now checked on EVERY
// pipeline call — truncation is a failed attempt, never a result.
const isTruncated = (result: StreamResult): boolean => result.stopReason === 'max_tokens';

// The fixed pipeline length: focus 1 → plan 2 → css 3 → html 4 (the css-patch
// remediation, when it fires, stays inside step 4 — no fifth step).
const TOTAL_STEPS = 4;

// The deterministic plan rendering shared by the css and html calls (sorted inputs in,
// stable bytes out — it rides AFTER the cached FOCUS block).
function renderPlan(plan: DocPlan): string {
  return [
    'Document plan:',
    `Narrative arc: ${plan.narrative}`,
    'Sections:',
    ...plan.sections.map((section, i) => `${i + 1}. ${section.title} — ${section.brief}`),
    'Illustration inventory:',
    ...plan.illustrations.map(
      (il) => `- ${il.name} (${il.type}): classes ${il.classNames.join(', ')} — ${il.structure}`,
    ),
    `Palette direction: ${plan.palette}`,
    `Typography direction: ${plan.typography}`,
  ].join('\n');
}

const NO_CONTENT_USAGE = { inputTokens: 0, outputTokens: 0 } as const;

const ZERO_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0 };

function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  const cacheRead = (a.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0);
  const cacheCreation = (a.cacheCreationInputTokens ?? 0) + (b.cacheCreationInputTokens ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(cacheRead > 0 ? { cacheReadInputTokens: cacheRead } : {}),
    ...(cacheCreation > 0 ? { cacheCreationInputTokens: cacheCreation } : {}),
  };
}

function isCancelled(error: unknown): boolean {
  return error instanceof LlmServiceError && error.code === 'CANCELLED';
}

// HTML-escape note text for raw mode so a note's own angle brackets render as text,
// not markup — defense-in-depth ahead of the renderer's sanitize + sandbox layers.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The raw-notes document shell — a self-contained, SCRIPT-FREE HTML page (rendered
// through the same sandbox + sanitize path as the LLM documents).
function rawDocHtml(body: string): string {
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8" />',
    '<style>',
    ':root{--ink:#2a2a33;--muted:#6b6b76;--line:#e6e6ec;--accent:#5e6ad2;}',
    'body{font-family:Georgia,"Times New Roman",serif;color:var(--ink);',
    'max-width:46rem;margin:2rem auto;padding:0 1.25rem;line-height:1.6;}',
    'h1{font-family:Inter,system-ui,sans-serif;font-size:1.5rem;}',
    '.note{white-space:pre-wrap;border-left:3px solid var(--accent);',
    'padding:.4rem 0 .4rem .9rem;margin:1rem 0;}',
    '.empty{color:var(--muted);font-style:italic;}',
    '</style></head><body>',
    '<h1>Raw notes</h1>',
    body,
    '</body></html>',
  ].join('');
}

export function createGenerationService({
  keyStore,
  clientFactory,
  templates,
  notes,
  assets,
  artifacts,
  modelMaxTokens = maxOutputTokensFor,
  isKnownModel = (model) => maxOutputTokensFor(model) !== null,
  // Renamed locally to avoid shadowing generateWhitepaper's `usage` accumulator.
  usage: usageRecorder,
}: GenerationServiceDeps): GenerationService {
  const resolveTemplate = (templateId: string | undefined): GenTemplate =>
    templates.getTemplate(templateId ?? SEED_TEMPLATE_ID) ?? DEFAULT_TEMPLATE;

  // Validate the renderer-supplied model main-side (audit S3-001): an unsupplied OR unknown/forged
  // id falls back to the generation default, so a compromised renderer / direct IPC can never pin
  // generation to an arbitrary or unintended model. A known catalog id passes through unchanged.
  const resolveModel = (requested: string | undefined): string =>
    requested !== undefined && isKnownModel(requested) ? requested : DEFAULT_GENERATION_MODEL;

  // The model-aware cap (D.3 item 7), resolved ONCE per run (not per call): a model whose
  // ceiling is below the app bound caps there; a higher-ceiling (or unknown) model caps at
  // the 32000 app bound. The fix-#3 truncation guard then fires at THIS resolved value.
  const resolveMaxTokens = (model: string): number =>
    Math.min(GENERATION_MAX_TOKENS, modelMaxTokens(model) ?? GENERATION_MAX_TOKENS);

  // Build the client options for a run, threading cancel + heartbeat ONLY when the caller
  // supplied them — so the common path stays { apiKey } (preserving existing call shapes).
  const clientOptionsFor = (
    apiKey: string,
    handlers: GenStreamHandlers,
  ): AnthropicClientOptions => ({
    apiKey,
    ...(handlers.signal ? { signal: handlers.signal } : {}),
    ...(handlers.onHeartbeat ? { onHeartbeat: handlers.onHeartbeat } : {}),
  });

  // The no-persist-after-cancel guard (M07.A; F11). Sits in the SERVICE (not the client —
  // the client doesn't know about artifacts) before each saveArtifact AND between the
  // chunked loop's iterations (M07.C — cancel applies per-call AND to the loop): a run
  // cancelled by the time we'd continue throws CANCELLED and writes nothing. A FOCUS
  // artifact persisted BEFORE a later-stage cancel is a valid intermediate and is kept.
  const throwIfCancelled = (handlers: GenStreamHandlers): void => {
    if (handlers.signal?.aborted) {
      throw new LlmServiceError('CANCELLED');
    }
  };

  // One streaming call: a FRESH client per call (preserves the client's one-stream-
  // per-client invariant and gives every chunked call its own watchdog tiers + ceiling
  // for free), the streamed text collected, deltas optionally forwarded.
  async function callModel(input: {
    apiKey: string;
    handlers: GenStreamHandlers;
    model: string;
    maxTokens: number;
    system: string;
    content: LlmContentBlock[];
    onDelta?: ChunkHandler;
  }): Promise<{ text: string; result: StreamResult }> {
    const client = clientFactory(clientOptionsFor(input.apiKey, input.handlers));
    let text = '';
    try {
      const result = await client.streamMessage(
        {
          model: input.model,
          messages: [{ role: 'user', content: input.content }],
          system: input.system,
          maxTokens: input.maxTokens,
        },
        (delta) => {
          text += delta;
          input.onDelta?.(delta);
        },
      );
      return { text, result };
    } catch (error) {
      throw mapAnthropicError(error);
    }
  }

  async function generateFocus(
    request: GenFocusRequest,
    handlers: GenStreamHandlers,
  ): Promise<GenDone> {
    const apiKey = keyStore.getKeyForMain();
    if (apiKey === null) {
      throw new LlmServiceError('NO_KEY');
    }

    const corpus = buildCorpus(request.sessionId, { notes, assets });
    if (corpus.noteCount === 0 && corpus.imageBlocks.length === 0) {
      // Nothing to generate from — emit the marker, skip the SDK (no token spend),
      // persist nothing.
      handlers.onChunk(NO_CONTENT_GENERATION_MESSAGE);
      return { stopReason: 'no_content', usage: NO_CONTENT_USAGE, kind: 'focus' };
    }

    const template = resolveTemplate(request.templateId);
    const model = resolveModel(request.model);
    const maxTokens = resolveMaxTokens(model);

    const content: LlmContentBlock[] = [];
    if (corpus.text.length > 0) {
      content.push({ type: 'text', text: corpus.text });
    }
    content.push(...corpus.imageBlocks);
    content.push({ type: 'text', text: FOCUS_DIRECTIVE });

    // Step 1 of the fixed pipeline: analyzing the session into the FOCUS doc.
    handlers.onProgress?.({
      step: 'focus',
      index: 1,
      total: TOTAL_STEPS,
      label: 'Analyzing session…',
    });

    const { text: document, result } = await callModel({
      apiKey,
      handlers,
      model,
      maxTokens,
      system: template.focusPrompt,
      content,
      onDelta: handlers.onChunk,
    });

    // Cancelled by the time we'd persist? Write nothing (F11).
    throwIfCancelled(handlers);

    // Persist + record the model the API ACTUALLY ANSWERED WITH (result.model), not the
    // requested/selected id — so the badge and the usage row reflect what truly ran. This
    // matches chat (llm-service records result.model) and, crucially, surfaces a gateway that
    // substitutes a different model than requested (e.g. a corp Bedrock gateway that serves
    // 3.5 Sonnet for an id it doesn't map). Fall back to the resolved request id only if the
    // provider returned no model string.
    const answeredModel = result.model || model;
    const saved = artifacts.saveArtifact({
      sessionId: request.sessionId,
      kind: 'focus',
      content: document,
      templateId: template.id,
      model: answeredModel,
    });

    usageRecorder?.record({
      sessionId: request.sessionId,
      kind: 'focus',
      model: answeredModel,
      usage: result.usage,
    });

    return { ...result, kind: 'focus', artifactId: saved.id };
  }

  async function generateWhitepaper(
    request: GenWhitepaperRequest,
    handlers: GenStreamHandlers,
  ): Promise<GenDone> {
    const apiKey = keyStore.getKeyForMain();
    if (apiKey === null) {
      throw new LlmServiceError('NO_KEY');
    }

    // The chunked pipeline's primary reference is the persisted FOCUS doc; reuse it
    // when present so a re-run never redoes Part 1 (M04.A decision #3) — UNLESS the caller
    // asked to reanalyze (Start over), which forces a fresh Part 1 before the write. This
    // is what folds Start over into ONE run instead of a renderer-orchestrated focus leg.
    let focusDoc = request.reanalyze
      ? null
      : (artifacts.getLatestArtifact(request.sessionId, 'focus')?.content ?? null);
    if (focusDoc === null) {
      const corpus = buildCorpus(request.sessionId, { notes, assets });
      if (corpus.noteCount === 0 && corpus.imageBlocks.length === 0) {
        // No FOCUS doc and nothing to build one from — emit the marker, no SDK call.
        handlers.onChunk(NO_CONTENT_GENERATION_MESSAGE);
        return { stopReason: 'no_content', usage: NO_CONTENT_USAGE, kind: 'whitepaper' };
      }
      // Run Part 1 SILENTLY — the FOCUS deltas are intermediate analysis, not the
      // white paper, so they are not surfaced to the user-facing handler. The PROGRESS
      // marker IS forwarded, so the user sees "Analyzing session…" during Part 1.
      await generateFocus(request, {
        onChunk: () => undefined,
        ...(handlers.onProgress ? { onProgress: handlers.onProgress } : {}),
        // Forward cancel + heartbeat so a Part-1 cancel aborts (and persists no FOCUS).
        ...(handlers.signal ? { signal: handlers.signal } : {}),
        ...(handlers.onHeartbeat ? { onHeartbeat: handlers.onHeartbeat } : {}),
      });
      focusDoc = artifacts.getLatestArtifact(request.sessionId, 'focus')?.content ?? '';
    }

    const template = resolveTemplate(request.templateId);
    const model = resolveModel(request.model);
    const maxTokens = resolveMaxTokens(model);

    // The pipeline prompt parts: the template's own when present, the factory part
    // otherwise (v1 forks carry none — they keep working unchanged). M08.A flips the
    // composition: the template's whitepaperPrompt is the editable <document_mandate>
    // FIRST, and each call's part is the immutable <non_negotiable_output_contract>
    // LAST — so the pipeline's output-shape rules carry recency weight and an edited
    // mandate can no longer fight them (the contract block declares it overrides
    // conflicting mandate instructions).
    const composeSystem = (part: string): string =>
      composeSystemPrompt(template.whitepaperPrompt, part);
    const systems = {
      plan: composeSystem(template.planPrompt ?? PLAN_PROMPT),
      css: composeSystem(template.cssPrompt ?? CSS_PROMPT),
      html: composeSystem(template.htmlPrompt ?? HTML_PROMPT),
    };
    // FOCUS rides as the single CACHED prefix block on every downstream call
    // (prefix-match caching; the plan/css text follows it uncached — small).
    const focusBlock: LlmContentBlock = { type: 'text', text: focusDoc, cache: true };

    let usage = ZERO_USAGE;
    let lastResult: StreamResult | null = null;

    // M08.C: record each COMPLETED pipeline call's real usage ONCE (kind 'whitepaper', the model the
    // call answered with). This replaces the single end-of-run aggregate write — so stages completed
    // before a later failure/cancel are accounted, and a retried call's attempts are each counted.
    // The aggregate is retained ONLY in the returned GenDone.usage (the per-call rows sum to it, so
    // there is no double-count). A call that THREW returned no usage and is never recorded (usage is
    // never invented). The internal FOCUS call records its own 'focus' row in generateFocus.
    const recordCall = (result: StreamResult): void =>
      usageRecorder?.record({
        sessionId: request.sessionId,
        kind: 'whitepaper',
        model: result.model ?? model,
        usage: result.usage,
      });

    // ---- PLAN call (cheap; one retry; parse failure shares the attempt budget) -----
    throwIfCancelled(handlers);
    handlers.onProgress?.({
      step: 'plan',
      index: 2,
      total: TOTAL_STEPS,
      label: 'Planning the document…',
    });
    let plan: DocPlan | null = null;
    for (let attempt = 1; attempt <= CALL_ATTEMPTS && plan === null; attempt += 1) {
      throwIfCancelled(handlers);
      let text: string;
      let truncatedCall: boolean;
      try {
        const call = await callModel({
          apiKey,
          handlers,
          model,
          maxTokens,
          system: systems.plan,
          content: [focusBlock, { type: 'text', text: PLAN_DIRECTIVE }],
        });
        text = call.text;
        truncatedCall = isTruncated(call.result);
        usage = addUsage(usage, call.result.usage);
        recordCall(call.result);
        lastResult = call.result;
      } catch (error) {
        if (isCancelled(error) || attempt === CALL_ATTEMPTS) {
          throw error;
        }
        continue;
      }
      if (truncatedCall) {
        if (attempt === CALL_ATTEMPTS) {
          throw stepFailure('plan', 'truncated');
        }
        continue;
      }
      plan = parsePlan(text);
      if (plan === null && attempt === CALL_ATTEMPTS) {
        // The model could not produce a valid bounded plan twice — fail typed.
        throw stepFailure('plan', 'plan');
      }
    }
    if (plan === null) {
      throw stepFailure('plan', 'plan');
    }
    const planText = renderPlan(plan);
    // The plan's illustration classNames are the FIRST contract: the stylesheet must
    // define every one BEFORE the html author writes against it (subset guard #1).
    const required = planClasses(plan);

    // ---- CSS call (cheap; one retry; subset guard #1) -------------------------------
    throwIfCancelled(handlers);
    handlers.onProgress?.({
      step: 'css',
      index: 3,
      total: TOTAL_STEPS,
      label: 'Styling document…',
    });
    let cssText: string | null = null;
    let gaps: string[] = [];
    for (let attempt = 1; attempt <= CALL_ATTEMPTS && cssText === null; attempt += 1) {
      throwIfCancelled(handlers);
      const directive = [
        planText,
        '',
        CSS_DIRECTIVE,
        `Required classes (every one MUST be defined): ${required.join(', ')}`,
        'Also style the base semantic elements (headings, paragraphs, lists,',
        'blockquotes, tables, code) and a small set of generic layout utilities.',
        ...(gaps.length > 0
          ? [
              'Your previous stylesheet was REJECTED — these required classes are',
              `missing and every one must be defined this time: ${gaps.join(', ')}`,
            ]
          : []),
      ].join('\n');
      let text: string;
      let truncatedCall: boolean;
      try {
        const call = await callModel({
          apiKey,
          handlers,
          model,
          maxTokens,
          system: systems.css,
          content: [focusBlock, { type: 'text', text: directive }],
        });
        text = call.text;
        truncatedCall = isTruncated(call.result);
        usage = addUsage(usage, call.result.usage);
        recordCall(call.result);
        lastResult = call.result;
      } catch (error) {
        if (isCancelled(error) || attempt === CALL_ATTEMPTS) {
          throw error;
        }
        continue;
      }
      if (truncatedCall) {
        if (attempt === CALL_ATTEMPTS) {
          throw stepFailure('css', 'truncated');
        }
        continue;
      }
      // Tolerant extraction + strict validation (IRL fix #1, carried; #3 hardens it
      // with stray-fence stripping + the brace-balance truncation backstop): a broken
      // part is a FAILED attempt — never silently accepted.
      const extracted = extractCss(text);
      if (extracted === null) {
        if (attempt === CALL_ATTEMPTS) {
          throw stepFailure('css', 'stylesheet');
        }
        continue;
      }
      // Subset guard #1 (deterministic): plan classes ⊆ stylesheet classes. The HTML
      // author must never write against an incomplete stylesheet; the retry NAMES the
      // missing classes; a second miss fails the run typed.
      gaps = unstyledClasses(extracted, required);
      if (gaps.length > 0) {
        if (attempt === CALL_ATTEMPTS) {
          throw stepFailure('css', 'stylesheet');
        }
        continue;
      }
      cssText = extracted;
    }
    if (cssText === null) {
      throw stepFailure('css', 'stylesheet');
    }

    // ---- HTML call (the long pole; one retry; body-only validation) ----------------
    // ONE author writes the complete body AGAINST THE ACTUAL STYLESHEET (the round-4
    // design: never stitch independently-generated prose — ADR-0018). The full output
    // budget goes to content; no CSS in the output.
    throwIfCancelled(handlers);
    handlers.onProgress?.({
      step: 'html',
      index: 4,
      total: TOTAL_STEPS,
      label: 'Writing the document…',
    });
    const htmlDirective = [
      planText,
      '',
      'The theme stylesheet (already final — write against it):',
      cssText,
      '',
      HTML_DIRECTIVE,
    ].join('\n');
    let body: string | null = null;
    for (let attempt = 1; attempt <= CALL_ATTEMPTS && body === null; attempt += 1) {
      throwIfCancelled(handlers);
      let text: string;
      let truncatedCall: boolean;
      try {
        const call = await callModel({
          apiKey,
          handlers,
          model,
          maxTokens,
          system: systems.html,
          content: [focusBlock, { type: 'text', text: htmlDirective }],
          onDelta: handlers.onChunk,
        });
        text = call.text;
        truncatedCall = isTruncated(call.result);
        usage = addUsage(usage, call.result.usage);
        recordCall(call.result);
        lastResult = call.result;
      } catch (error) {
        if (isCancelled(error) || attempt === CALL_ATTEMPTS) {
          throw error;
        }
        continue;
      }
      if (truncatedCall) {
        if (attempt === CALL_ATTEMPTS) {
          throw stepFailure('html', 'truncated');
        }
        continue;
      }
      // Unwrap a whole-body markdown fence, THEN validate body-only. NOTE: truncation
      // (max_tokens) is already handled ABOVE — a truncated response hard-fails before
      // we ever reach the normalizer, so parse5 can never repair a truncated document
      // into apparent success (M08.A; ADR-0026 completeness caution).
      const unwrapped = stripFence(text).trim();
      const shellMarker = fragmentViolation(unwrapped);
      if (shellMarker !== null) {
        // M08.A recovery: when the model returned a (partial) DOCUMENT instead of a body
        // fragment, extract only the body's children via parse5 BEFORE failing — discard
        // the model shell/head/style and proceed. A bare <style> marker carries no
        // document to extract, so it is not normalized (it stays a rejection).
        const normalized = isDocumentShellMarker(shellMarker)
          ? normalizeBodyFragment(unwrapped)
          : null;
        if (normalized?.ok) {
          // §E — a DISTINCT, content-free "recovered" diagnostic (separate category from
          // the rejection line below), teed to main.log for the watched intermittent
          // structure-rejection item. Log the marker + provider metadata ONLY, NEVER the
          // recovered body (derived from meeting content; S4-001).
          console.warn(
            `[gen:whitepaper] HTML structure recovered via normalizer — marker=${shellMarker} ` +
              `model=${lastResult?.model ?? model} stopReason=${lastResult?.stopReason ?? 'unknown'} ` +
              `attempt=${attempt}/${CALL_ATTEMPTS}`,
          );
          body = normalized.fragment;
          continue;
        }
        // Diagnostic instrumentation (M06.E IRL fix #3) — the reject/retry semantics are
        // UNCHANGED. The structure-validation rejection is the ~50% white-paper failure
        // mode and main.log captured nothing about it. Log WHICH shell marker tripped, the
        // normalize reason when extraction was attempted, the model + stop_reason of the
        // offending HTML call, and the attempt — but NEVER the body itself. Audit S4-001:
        // `redactSecrets` only strips credential-shaped tokens, and main.log is a
        // user-openable, shareable §10 surface, so logging a slice of the generated body
        // (derived from meeting content) would leak the user's own content. The marker +
        // provider metadata are enough to triage the failure without the content.
        const reasonSuffix = normalized ? ` reason=${normalized.reason}` : '';
        console.warn(
          `[gen:whitepaper] HTML structure validation rejected the body — marker=${shellMarker}${reasonSuffix} ` +
            `model=${lastResult?.model ?? model} stopReason=${lastResult?.stopReason ?? 'unknown'} ` +
            `attempt=${attempt}/${CALL_ATTEMPTS}`,
        );
        if (attempt === CALL_ATTEMPTS) {
          throw stepFailure('html', 'structure');
        }
        continue;
      }
      body = unwrapped;
    }
    if (body === null) {
      throw stepFailure('html', 'structure');
    }

    // ---- Subset guard #2: body ⊆ css → the CSS-PATCH remediation --------------------
    // The HTML call is NEVER retried for a styling gap (the long pole's output is
    // good content); the first remedy is a cheap INCREMENTAL css call defining exactly
    // the missing classes. Patch failure → typed failure — never a silently broken doc.
    const missing = unstyledClasses(cssText, extractVocabulary([body]).classes);
    if (missing.length > 0) {
      let patch: string | null = null;
      for (let attempt = 1; attempt <= CALL_ATTEMPTS && patch === null; attempt += 1) {
        throwIfCancelled(handlers);
        const patchDirective = [
          'The document body uses classes the final stylesheet below does not define.',
          'Output ONLY additional RAW CSS rules (no <style> tag, no fence) that define',
          `exactly these missing classes, consistent with the theme: ${missing.join(', ')}`,
          '',
          'The existing stylesheet:',
          cssText,
        ].join('\n');
        let text: string;
        let truncatedCall: boolean;
        try {
          const call = await callModel({
            apiKey,
            handlers,
            model,
            maxTokens,
            system: systems.css,
            content: [focusBlock, { type: 'text', text: patchDirective }],
          });
          text = call.text;
          truncatedCall = isTruncated(call.result);
          usage = addUsage(usage, call.result.usage);
          // M08.D (M08.V 🔴-1): the css-PATCH remediation is a COMPLETED API call like plan/css/html —
          // record it per-call too. M08.C added per-call recording everywhere EXCEPT here, so when
          // subset guard #2 fires the patch tokens (still summed into GenDone.usage) were counted zero
          // times in the persisted counter. Record once, in the same place the other loops do.
          recordCall(call.result);
          lastResult = call.result;
        } catch (error) {
          if (isCancelled(error) || attempt === CALL_ATTEMPTS) {
            throw error;
          }
          continue;
        }
        if (truncatedCall) {
          if (attempt === CALL_ATTEMPTS) {
            throw stepFailure('patch', 'truncated');
          }
          continue;
        }
        const extracted = extractCss(text);
        if (extracted === null || unstyledClasses(`${cssText}\n${extracted}`, missing).length > 0) {
          if (attempt === CALL_ATTEMPTS) {
            throw stepFailure('patch', 'stylesheet');
          }
          continue;
        }
        patch = extracted;
      }
      if (patch === null) {
        throw stepFailure('patch', 'stylesheet');
      }
      cssText = `${cssText}\n${patch}`;
    }

    // ---- The programmatic stitch + the single final persist ------------------------
    // Cancelled by the time we'd persist? Nothing is stitched or persisted as final;
    // the FOCUS intermediate stays (F11 / M07.C).
    throwIfCancelled(handlers);
    const html = assembleDocument({ title: 'White paper', css: cssText, body });
    // Persist + record the model the API ACTUALLY ANSWERED WITH (the last pipeline call's
    // result.model), not the requested id — same rationale as focus/chat: a truthful badge
    // that reveals a gateway model substitution. Fall back to the resolved request id only if
    // no call surfaced a model.
    const answeredModel = lastResult?.model || model;
    const saved = artifacts.saveArtifact({
      sessionId: request.sessionId,
      kind: 'whitepaper',
      content: html,
      templateId: template.id,
      model: answeredModel,
    });

    // No aggregate usage write here (M08.C): each completed call was recorded individually above, so
    // a final summed record() would double-count. The aggregate is still RETURNED in GenDone.usage.

    return {
      stopReason: lastResult?.stopReason ?? 'end_turn',
      usage,
      ...(lastResult ? { model: lastResult.model } : {}),
      kind: 'whitepaper',
      artifactId: saved.id,
    };
  }

  async function generateMinutes(
    request: GenMinutesRequest,
    handlers: GenStreamHandlers,
  ): Promise<GenDone> {
    const apiKey = keyStore.getKeyForMain();
    if (apiKey === null) {
      throw new LlmServiceError('NO_KEY');
    }

    const corpus = buildCorpus(request.sessionId, { notes, assets });
    if (corpus.noteCount === 0 && corpus.imageBlocks.length === 0) {
      handlers.onChunk(NO_CONTENT_GENERATION_MESSAGE);
      return { stopReason: 'no_content', usage: NO_CONTENT_USAGE, kind: 'minutes' };
    }

    const template = resolveTemplate(request.templateId);
    const model = resolveModel(request.model);
    const maxTokens = resolveMaxTokens(model);

    const content: LlmContentBlock[] = [];
    if (corpus.text.length > 0) {
      content.push({ type: 'text', text: corpus.text });
    }
    content.push(...corpus.imageBlocks);
    content.push({ type: 'text', text: MINUTES_DIRECTIVE });

    // Minutes is a single SDK call — one step. (The screenshots themselves are
    // surfaced by the renderer as an adjacent gallery, not embedded inline here.)
    handlers.onProgress?.({ step: 'minutes', index: 1, total: 1, label: 'Writing minutes…' });

    const { text: html, result } = await callModel({
      apiKey,
      handlers,
      model,
      maxTokens,
      // M08.B: the editable minutes mandate composed FIRST with the IMMUTABLE output
      // contract LAST (composeSystemPrompt) — so an edited prompt can't fight the
      // structural/security rules (the contract declares it overrides conflicting mandate
      // instructions). Absent OR cleared-to-empty (it's a user-editable textarea) → the
      // factory default, so minutes never runs prompt-less.
      system: composeSystemPrompt(
        template.minutesPrompt || MINUTES_PROMPT,
        MINUTES_OUTPUT_CONTRACT,
      ),
      content,
      onDelta: handlers.onChunk,
    });

    // Cancelled by the time we'd persist? Write nothing (F11). Cancel is FREE — it records
    // no usage; it is checked before the spend-accounting paths below.
    throwIfCancelled(handlers);

    // The model the API ACTUALLY ANSWERED WITH (result.model), not the requested id — same
    // rationale as focus/chat (truthful badge; surfaces a gateway substitution). Fall back
    // to the resolved request id only if none was returned.
    const answeredModel = result.model || model;

    // Spend principle (M08.B): account the REAL provider usage on EVERY terminal path that
    // returned terminal usage — success, truncation-reject, AND normalize-reject. The tokens
    // were spent, so they are never discarded at a throw and never invented. (Whether the
    // per-call truncation/reject ledger keeps exactly this shape is Stage C's charter; here
    // we only guarantee real-usage-not-discarded.)
    const recordUsage = (): void =>
      usageRecorder?.record({
        sessionId: request.sessionId,
        kind: 'minutes',
        model: answeredModel,
        usage: result.usage,
      });

    // Truncation BEFORE the normalizer (ADR-0026 completeness caution): a max_tokens
    // response is incomplete by definition and must hard-fail into the typed error — never
    // be parse5-repaired into apparent success. The incomplete HTML is never persisted; the
    // body is never logged (S4-001) — only the category + provider metadata.
    if (result.stopReason === 'max_tokens') {
      recordUsage();
      console.warn(
        `[gen:minutes] rejected — reason=truncated model=${answeredModel} ` +
          `stopReason=${result.stopReason}`,
      );
      throw minutesFailure('truncated');
    }

    // Normalize the SINGLE self-contained minutes document (parse5; M08.B/ADR-0026): keep
    // one shell + at most one head stylesheet, strip prohibited constructs structurally,
    // require meaningful body content. Minutes are NOT routed through the white-paper
    // fragmentViolation validator (a full <html> minutes doc is valid). A document that
    // cannot be recovered safely hard-fails the typed error rather than persisting. The
    // renderer DOMPurify + sandbox + CSP remain the load-bearing security layer.
    const normalized = normalizeMinutesDocument(html);
    if (!normalized.ok) {
      recordUsage();
      console.warn(
        `[gen:minutes] rejected — reason=${normalized.reason} model=${answeredModel} ` +
          `stopReason=${result.stopReason ?? 'unknown'}`,
      );
      throw minutesFailure('structure');
    }

    const saved = artifacts.saveArtifact({
      sessionId: request.sessionId,
      kind: 'minutes',
      content: normalized.document,
      // Record the template that produced these minutes (it has an editable prompt now),
      // so the renderer can show the template chip on the persisted doc too.
      templateId: template.id,
      model: answeredModel,
    });

    recordUsage();

    return { ...result, kind: 'minutes', artifactId: saved.id };
  }

  function buildRawDoc(sessionId: string): string {
    // The saved-and-searchable path: render the saved note blocks as a document with
    // NO SDK call and NO key read — raw notes spend no tokens. Note text is escaped
    // so a note's own markup renders as text (the renderer still sanitizes+sandboxes).
    const blocks = notes
      .listNotes(sessionId)
      .map((note) => note.content)
      .filter((content) => content.trim().length > 0);

    const body =
      blocks.length > 0
        ? blocks
            .map((content) => `<section class="note">${escapeHtml(content)}</section>`)
            .join('\n')
        : '<p class="empty">This session has no notes yet.</p>';

    return rawDocHtml(body);
  }

  return { generateFocus, generateWhitepaper, generateMinutes, buildRawDoc };
}
