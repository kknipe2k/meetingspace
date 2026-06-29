import { describe, expect, it, vi } from 'vitest';

import type { AnthropicClientLike } from '../../electron/llm/anthropic-client';
import type { CorpusAssetReader, CorpusNoteReader } from '../../electron/gen/corpus';
import {
  createGenerationService,
  type GenArtifactStore,
  type GenTemplateReader,
} from '../../electron/gen/generation-service';
import type { Asset, GenDocument, GenTemplate, LlmUsage, Note } from '@shared/types';
import { LlmServiceError } from '../../electron/llm/errors';

/*
 * M06.D (ADR-0021) — the generation service records its REAL run usage so the passive counter
 * reflects generation spend, not just chat. Recorded on SUCCESS only; a cancelled run (which
 * already persists no artifact — F11) records no usage either.
 */
const KEY = 'sk-ant-api03-THIS-IS-A-FAKE-TEST-KEY-000';
const TEMPLATE = {
  id: 't1',
  name: 'T',
  focusPrompt: 'FOCUS-SYS',
  whitepaperPrompt: 'M',
  isDefault: false,
} as GenTemplate;

function note(content: string): Note {
  return { id: 'n1', sessionId: 's1', content, createdAt: 1, updatedAt: 1 };
}
const notes: CorpusNoteReader = { listNotes: () => [note('We shipped on Friday.')] };
const assets: CorpusAssetReader = { listAssets: () => [] as Asset[], readImage: () => null };
const templates: GenTemplateReader = {
  getTemplate: (id) => (id === TEMPLATE.id ? TEMPLATE : null),
};

function store(): GenArtifactStore & { saved: GenDocument[] } {
  const saved: GenDocument[] = [];
  return {
    saved,
    saveArtifact: (input) => {
      const doc = { id: `d${saved.length + 1}`, createdAt: 1, ...input } as GenDocument;
      saved.push(doc);
      return doc;
    },
    getLatestArtifact: (_s, kind) => saved.find((d) => d.kind === kind) ?? null,
  };
}

const FOCUS_USAGE = { inputTokens: 100, outputTokens: 200 };
function focusClient(): AnthropicClientLike {
  return {
    streamMessage: (_request, onChunk) => {
      onChunk('FOCUS DOC');
      return Promise.resolve({ stopReason: 'end_turn', usage: FOCUS_USAGE, model: 'm-gen' });
    },
  };
}

// The request asks for 'claude-sonnet-4-6', but the fake client answers AS 'm-gen' (the gateway-
// substitution shape). The usage row AND the persisted artifact must record 'm-gen' — the model the
// API actually answered with — not the requested id, so spend + badge reflect what truly ran.
const REQUEST = { sessionId: 's1', templateId: 't1', model: 'claude-sonnet-4-6' } as const;

describe('generation usage recording', () => {
  it('records the real run usage on a successful focus generation', async () => {
    const usage = { record: vi.fn() };
    const artifacts = store();
    const service = createGenerationService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory: () => focusClient(),
      templates,
      notes,
      assets,
      artifacts,
      usage,
    });

    await service.generateFocus(REQUEST, { onChunk: () => undefined });

    // Recorded + persisted as the ANSWERED model ('m-gen'), never the requested 'claude-sonnet-4-6'.
    expect(usage.record).toHaveBeenCalledWith({
      sessionId: 's1',
      kind: 'focus',
      model: 'm-gen',
      usage: FOCUS_USAGE,
    });
    expect(artifacts.saved[0]?.model).toBe('m-gen');
  });

  it('records no usage when the run is cancelled (nothing persisted — F11)', async () => {
    const usage = { record: vi.fn() };
    const service = createGenerationService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory: () => focusClient(),
      templates,
      notes,
      assets,
      artifacts: store(),
      usage,
    });

    const controller = new AbortController();
    controller.abort(); // cancelled by the time the run would persist

    await expect(
      service.generateFocus(REQUEST, { onChunk: () => undefined, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(usage.record).not.toHaveBeenCalled();
  });
});

/*
 * M08.C — white-paper usage is recorded PER COMPLETED CALL (plan/css/html/patch), not via a single
 * end-of-run aggregate write. The fix nets to no double-count: removing the aggregate `record()`
 * and recording each call once leaves the same total, but now (a) stages completed before a later
 * failure/cancel are accounted, and (b) a retried call's attempts are each counted. The aggregate is
 * retained ONLY in `GenDone.usage`. The internal FOCUS call records its own `focus` row (unchanged).
 *
 * M08.D (M08.V 🔴-1) — the css-PATCH leg is now ACTUALLY exercised: the original M08.C fixtures kept
 * body ⊆ css so subset-guard #2 never fired, leaving the "/patch" claim above unbacked while the
 * production patch loop in fact omitted its `recordCall`. The patch-path case below fires the guard
 * and is mutation-verified, so plan/css/html/**patch** are all proven recorded exactly once.
 */
const ANSWERED = 'm-gen';
const WP_TEMPLATE = {
  id: 'wp',
  name: 'WP',
  focusPrompt: 'FOCUS-SYS',
  whitepaperPrompt: 'MANDATE',
  planPrompt: 'PLAN-SYS',
  cssPrompt: 'CSS-SYS',
  htmlPrompt: 'HTML-SYS',
  isDefault: false,
} as GenTemplate;
const wpTemplates: GenTemplateReader = {
  getTemplate: (id) => (id === WP_TEMPLATE.id ? WP_TEMPLATE : null),
};
const WP_REQUEST = { sessionId: 's1', templateId: 'wp', model: 'claude-sonnet-4-6' } as const;

// Plan/css/body authored to AGREE (plan classes ⊆ css; body classes ⊆ css) so the pipeline reaches
// the final persist without a styling retry/patch — three calls: plan, css, html.
const PLAN_JSON = JSON.stringify({
  sections: [{ title: 'Introduction', brief: 'Set the stage' }],
  narrative: 'Open with stakes, close with action.',
  illustrations: [
    {
      name: 'Ladder',
      type: 'ladder',
      classNames: ['callout', 'ladder', 'rung'],
      structure: '4 rungs',
    },
  ],
  palette: 'light',
  typography: 'serif',
});
const GOOD_CSS =
  ':root{--x:1}\n.ladder{display:grid}\n.rung{border:1px solid}\n.callout{border-left:4px solid}';
// Missing the required `.rung` class → the deterministic subset-guard rejection that forces a real
// same-step CSS retry (consistent with A: a rejected attempt is a FAILED attempt, never accepted).
const INCOMPLETE_CSS = ':root{--x:1}\n.ladder{display:grid}\n.callout{border-left:4px solid}';
const BODY = [
  '<h2>Introduction</h2>',
  '<div class="callout">Key</div>',
  '<div class="ladder"><span class="rung">P1</span></div>',
  '<p>Done.</p>',
].join('');

// A FOCUS doc is seeded so the pipeline runs plan → css → html directly (no Part-1 call).
function seededStore(): GenArtifactStore & { saved: GenDocument[] } {
  const saved: GenDocument[] = [
    {
      id: 'f1',
      sessionId: 's1',
      kind: 'focus',
      content: 'FOCUS',
      templateId: WP_TEMPLATE.id,
      createdAt: 1,
    } as GenDocument,
  ];
  return {
    saved,
    saveArtifact: (input) => {
      const doc = {
        id: `d${saved.length + 1}`,
        createdAt: saved.length + 1,
        ...input,
      } as GenDocument;
      saved.push(doc);
      return doc;
    },
    getLatestArtifact: (_s, kind) => [...saved].reverse().find((d) => d.kind === kind) ?? null,
  };
}

// Body that uses `.spotlight` — a class GOOD_CSS does NOT define — so subset guard #2 fires and the
// css-PATCH remediation call runs (the path the M08.C per-call recording missed; M08.V 🔴-1).
const BODY_NEEDS_PATCH = [
  '<h2>Introduction</h2>',
  '<div class="callout">Key</div>',
  '<div class="ladder"><span class="rung">P1</span></div>',
  '<div class="spotlight">Extra</div>',
  '<p>Done.</p>',
].join('');
// The incremental patch CSS that defines exactly the missing `.spotlight` class.
const PATCH_CSS = '.spotlight{outline:2px solid}';

interface WpScript {
  controller?: AbortController;
  cssRetryFirst?: boolean; // first css attempt misses `.rung` → rejected + retried (real same-step retry)
  htmlThrows?: boolean; // the html call throws on every attempt (no terminal usage)
  abortOnCss?: boolean; // abort the controller as the css call resolves
  bodyNeedsPatch?: boolean; // html body uses a class absent from css → subset guard #2 → patch call
}
// State that must PERSIST across callModel's per-call client instances (a fresh client is built per
// call), so the css-attempt counter actually advances between the rejected attempt and its retry.
interface WpState {
  cssCalls: number;
}
function wpClient(script: WpScript, state: WpState): AnthropicClientLike {
  const reply = (onChunk: (d: string) => void, text: string, usage: LlmUsage) => {
    onChunk(text);
    return Promise.resolve({ stopReason: 'end_turn' as const, usage, model: ANSWERED });
  };
  return {
    streamMessage(request, onChunk) {
      const sys = request.system ?? '';
      if (sys.includes('FOCUS-SYS'))
        return reply(onChunk, 'FOCUS DOC', { inputTokens: 1, outputTokens: 1 });
      if (sys.includes('PLAN-SYS'))
        return reply(onChunk, PLAN_JSON, { inputTokens: 10, outputTokens: 1 });
      if (sys.includes('CSS-SYS')) {
        // The css-PATCH remediation call shares the CSS-SYS system but carries the patch directive;
        // detect it by its marker and answer with the incremental rule (its OWN per-call usage).
        const directive = request.messages
          .flatMap((m) => m.content)
          .map((b) => ('text' in b ? b.text : ''))
          .join('\n');
        if (directive.includes('does not define')) {
          return reply(onChunk, PATCH_CSS, { inputTokens: 40, outputTokens: 4 });
        }
        const attempt = state.cssCalls;
        state.cssCalls += 1;
        if (script.abortOnCss) script.controller?.abort();
        // First css attempt is INCOMPLETE when cssRetryFirst → subset-guard rejects → real retry.
        const incomplete = script.cssRetryFirst === true && attempt === 0;
        return reply(
          onChunk,
          incomplete ? INCOMPLETE_CSS : GOOD_CSS,
          attempt === 0
            ? { inputTokens: 20, outputTokens: 2 }
            : { inputTokens: 22, outputTokens: 2 },
        );
      }
      if (sys.includes('HTML-SYS')) {
        if (script.htmlThrows) return Promise.reject(new Error('network blip'));
        return reply(onChunk, script.bodyNeedsPatch ? BODY_NEEDS_PATCH : BODY, {
          inputTokens: 30,
          outputTokens: 3,
        });
      }
      return Promise.reject(new Error(`unexpected system: ${sys.slice(0, 24)}`));
    },
  };
}
function wpService(
  artifacts: GenArtifactStore,
  usage: { record: ReturnType<typeof vi.fn> },
  script: WpScript = {},
) {
  const state: WpState = { cssCalls: 0 };
  return createGenerationService({
    keyStore: { getKeyForMain: () => KEY },
    clientFactory: () => wpClient(script, state),
    templates: wpTemplates,
    notes,
    assets,
    artifacts,
    usage,
  });
}
function wpRecords(usage: { record: ReturnType<typeof vi.fn> }): Array<{ usage: LlmUsage }> {
  return usage.record.mock.calls.map((c) => c[0]).filter((r) => r.kind === 'whitepaper');
}

describe('white-paper usage recorded per completed call — no double-count aggregate (M08.C)', () => {
  it('records each completed pipeline call exactly once with its own usage; aggregate only in GenDone', async () => {
    const artifacts = seededStore();
    const usage = { record: vi.fn() };
    const done = await wpService(artifacts, usage).generateWhitepaper(WP_REQUEST, {
      onChunk: () => undefined,
    });

    const recs = wpRecords(usage);
    // Exactly three whitepaper rows — plan, css, html — each with its OWN per-call usage…
    expect(recs.map((r) => r.usage)).toEqual([
      { inputTokens: 10, outputTokens: 1 },
      { inputTokens: 20, outputTokens: 2 },
      { inputTokens: 30, outputTokens: 3 },
    ]);
    // …and NO summed-aggregate row (the double-count source is gone).
    expect(recs).not.toContainEqual(
      expect.objectContaining({ usage: { inputTokens: 60, outputTokens: 6 } }),
    );
    // The aggregate is still RETURNED in GenDone, and the per-call rows sum to exactly it.
    expect(done.usage).toEqual({ inputTokens: 60, outputTokens: 6 });
    const summed = recs.reduce(
      (a, r) => ({
        inputTokens: a.inputTokens + r.usage.inputTokens,
        outputTokens: a.outputTokens + r.usage.outputTokens,
      }),
      { inputTokens: 0, outputTokens: 0 },
    );
    expect(summed).toEqual(done.usage);
  });

  it('records the css-PATCH remediation call (subset guard #2) — the completed call counts exactly once (M08.V 🔴-1)', async () => {
    const artifacts = seededStore();
    const usage = { record: vi.fn() };
    // The html body uses `.spotlight`, absent from the stylesheet → subset guard #2 fires → a real
    // incremental css-PATCH call runs. Before D.fix this completed call was added to GenDone.usage but
    // NEVER recorded per-call, so its spend vanished from the persisted counter (the exact M08.C defect
    // class, on the patch trigger). After the fix it records exactly one row like every other call.
    const done = await wpService(artifacts, usage, { bodyNeedsPatch: true }).generateWhitepaper(
      WP_REQUEST,
      { onChunk: () => undefined },
    );

    const recs = wpRecords(usage);
    // plan + css + html + patch — four completed calls, each recorded exactly once with its OWN usage.
    expect(recs.map((r) => r.usage)).toEqual([
      { inputTokens: 10, outputTokens: 1 },
      { inputTokens: 20, outputTokens: 2 },
      { inputTokens: 30, outputTokens: 3 },
      { inputTokens: 40, outputTokens: 4 },
    ]);
    // The aggregate is still RETURNED in GenDone, and the per-call rows (incl. the patch) sum to it.
    expect(done.usage).toEqual({ inputTokens: 100, outputTokens: 10 });
    const summed = recs.reduce(
      (a, r) => ({
        inputTokens: a.inputTokens + r.usage.inputTokens,
        outputTokens: a.outputTokens + r.usage.outputTokens,
      }),
      { inputTokens: 0, outputTokens: 0 },
    );
    expect(summed).toEqual(done.usage);
  });

  it('records BOTH attempts of a retried call (the rejected first attempt spent real tokens too)', async () => {
    const artifacts = seededStore();
    const usage = { record: vi.fn() };
    // css attempt #1 misses a required class → subset-guard rejects → a REAL same-step retry.
    const done = await wpService(artifacts, usage, { cssRetryFirst: true }).generateWhitepaper(
      WP_REQUEST,
      { onChunk: () => undefined },
    );

    const recs = wpRecords(usage);
    // plan + css attempt #1 (rejected, but real spend) + css attempt #2 (accepted) + html.
    expect(recs.map((r) => r.usage)).toEqual([
      { inputTokens: 10, outputTokens: 1 },
      { inputTokens: 20, outputTokens: 2 },
      { inputTokens: 22, outputTokens: 2 },
      { inputTokens: 30, outputTokens: 3 },
    ]);
    expect(done.usage).toEqual({ inputTokens: 82, outputTokens: 8 });
  });

  it('records the stages completed BEFORE a later failure (none lost to a missing end-of-run write)', async () => {
    const artifacts = seededStore();
    const usage = { record: vi.fn() };
    await expect(
      wpService(artifacts, usage, { htmlThrows: true }).generateWhitepaper(WP_REQUEST, {
        onChunk: () => undefined,
      }),
    ).rejects.toBeInstanceOf(LlmServiceError);

    // plan + css completed and are accounted; the html call threw (no terminal usage) → never invented.
    expect(wpRecords(usage).map((r) => r.usage)).toEqual([
      { inputTokens: 10, outputTokens: 1 },
      { inputTokens: 20, outputTokens: 2 },
    ]);
    expect(artifacts.saved.some((d) => d.kind === 'whitepaper')).toBe(false);
  });

  it('on cancel, counts only the calls that completed — never the interrupted one', async () => {
    const artifacts = seededStore();
    const usage = { record: vi.fn() };
    const controller = new AbortController();
    await expect(
      wpService(artifacts, usage, { abortOnCss: true, controller }).generateWhitepaper(WP_REQUEST, {
        onChunk: () => undefined,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });

    // plan + css completed before the cancel landed; the html call never ran → never recorded.
    expect(wpRecords(usage).map((r) => r.usage)).toEqual([
      { inputTokens: 10, outputTokens: 1 },
      { inputTokens: 20, outputTokens: 2 },
    ]);
  });
});
