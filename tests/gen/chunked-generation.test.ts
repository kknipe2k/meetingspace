import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AnthropicClientLike,
  StreamRequest,
  StreamResult,
} from '../../electron/llm/anthropic-client';
import type { CorpusAssetReader, CorpusNoteReader } from '../../electron/gen/corpus';
import {
  createGenerationService,
  type GenArtifactStore,
  type GenTemplateReader,
} from '../../electron/gen/generation-service';
import { LlmServiceError } from '../../electron/llm/errors';
import { DEFAULT_GENERATION_MODEL } from '@shared/models';
import type { Asset, GenDocument, GenProgress, GenTemplate, Note } from '@shared/types';

/*
 * M07.C round 4 (the design) — the white-paper pipeline. Per-section chunking is DEAD
 * (three IRL failure classes; independently-generated prose never ties out). The
 * pipeline is now:
 *
 *   FOCUS (existing; reuse persisted) → PLAN call (cheap, structured) → CSS call
 *   (cheap; styles the plan's inventory) → HTML call (the long pole; ONE author
 *   writing the whole body AGAINST THE ACTUAL STYLESHEET) → programmatic stitch.
 *
 * Pins: call order; the two wires (the plan's classes on the css wire; THE ACTUAL CSS
 * TEXT on the html wire); BOTH subset guards with fixtures authored to DISAGREE —
 * plan ⊆ css before the HTML call (retry naming the gaps → typed failure) and
 * body ⊆ css after it (one incremental CSS-PATCH call, NEVER an HTML retry for a
 * styling gap; patch fails → typed failure); body-only validation; the fixed 4-step
 * progress; cancel per-call AND between steps; the cached FOCUS prefix on all three
 * downstream calls. Driven with scripted fakes — no SDK, no network.
 */
const KEY = 'sk-ant-api03-THIS-IS-A-FAKE-TEST-KEY-000';

// A template carrying ALL prompt parts, with short distinct markers so the scripted
// client can route each call by its composed system prompt.
const CHUNK_TEMPLATE = {
  id: 'tmpl-chunk',
  name: 'Chunked',
  focusPrompt: 'FOCUS-SYS',
  whitepaperPrompt: 'MANDATE',
  planPrompt: 'PLAN-SYS',
  cssPrompt: 'CSS-SYS',
  htmlPrompt: 'HTML-SYS',
  isDefault: false,
} as GenTemplate;

const PLAN_JSON = JSON.stringify({
  sections: [
    { title: 'Introduction', brief: 'Set the stage' },
    { title: 'Conclusion', brief: 'Wrap up' },
  ],
  narrative: 'Open with stakes, close with action.',
  illustrations: [
    {
      name: 'Pattern Ladder',
      type: 'ladder',
      classNames: ['callout', 'ladder', 'rung'],
      structure: '4 rungs',
    },
  ],
  palette: 'light, slate, blue accent',
  typography: 'serif body, sans headings',
});

const GOOD_CSS =
  ':root{--x:1}\n.ladder{display:grid}\n.rung{border:1px solid}\n.callout{border-left:4px solid}';
// Defines callout + ladder but NOT rung — disagrees with the plan's contract.
const CSS_MISSING_RUNG = ':root{--x:1}\n.ladder{display:grid}\n.callout{border-left:4px solid}';

const BODY = [
  '<h2>Introduction</h2>',
  '<div class="callout">Key point</div>',
  '<div class="ladder"><span class="rung">P1</span></div>',
  '<p>Done.</p>',
].join('');

const FOCUS_SEED: GenDocument = {
  id: 'f1',
  sessionId: 's1',
  kind: 'focus',
  content: 'EXISTING FOCUS DOC',
  templateId: 'tmpl-chunk',
  createdAt: 1,
};

function note(content: string): Note {
  return { id: 'n1', sessionId: 's1', content, createdAt: 1, updatedAt: 1 };
}

function notesWith(): CorpusNoteReader {
  return { listNotes: () => [note('We shipped on Friday.')] };
}

function assetsWith(): CorpusAssetReader {
  return {
    listAssets: () => [] as Asset[],
    readImage: () => ({ mediaType: 'image/png', data: 'IMG' }),
  };
}

function templatesWith(template: GenTemplate = CHUNK_TEMPLATE): GenTemplateReader {
  return { getTemplate: (id) => (id === template.id ? template : null) };
}

function statefulStore(seed: GenDocument[] = []): GenArtifactStore & { saved: GenDocument[] } {
  const saved = [...seed];
  return {
    saved,
    saveArtifact(input): GenDocument {
      const doc = {
        id: `doc-${saved.length + 1}`,
        createdAt: saved.length + 1,
        ...input,
      } as GenDocument;
      saved.push(doc);
      return doc;
    },
    getLatestArtifact: (_sessionId, kind) =>
      [...saved].reverse().find((d) => d.kind === kind) ?? null,
  };
}

const DONE: StreamResult = {
  stopReason: 'end_turn',
  usage: { inputTokens: 1, outputTokens: 2 },
  model: DEFAULT_GENERATION_MODEL,
};

// A scripted response: stream this text (optionally with a non-end_turn stop reason —
// the truncation seam), fail with this typed error, or stream the text and THEN abort
// the run's controller (the between-steps cancel hook).
type Scripted =
  | { text: string; stopReason?: string; abortAfter?: AbortController }
  | { error: LlmServiceError; abortFirst?: AbortController };

interface PipelineScript {
  focus?: string;
  plan: Scripted[];
  // The css queue serves the initial CSS call AND any CSS-PATCH remediation calls
  // (same system part) — script them in order.
  css: Scripted[];
  html: Scripted[];
}

// Routes each call by the composed system prompt's PART marker (the part prompt leads;
// the template's whitepaperPrompt rides along as the document mandate).
function scriptedClient(script: PipelineScript): {
  client: AnthropicClientLike;
  seen: StreamRequest[];
} {
  const seen: StreamRequest[] = [];
  const queues = { plan: [...script.plan], css: [...script.css], html: [...script.html] };

  const respond = (
    entry: Scripted | undefined,
    onChunk: (d: string) => void,
  ): Promise<StreamResult> => {
    if (!entry) {
      return Promise.reject(new Error('scripted client: queue exhausted — unexpected extra call'));
    }
    if ('error' in entry) {
      entry.abortFirst?.abort();
      return Promise.reject(entry.error);
    }
    onChunk(entry.text);
    entry.abortAfter?.abort();
    return Promise.resolve({ ...DONE, stopReason: entry.stopReason ?? 'end_turn' });
  };

  const client: AnthropicClientLike = {
    streamMessage(request, onChunk) {
      seen.push(request);
      // M08.A: PLAN/CSS/HTML parts now ride INSIDE the composed system (mandate first,
      // part last), so route by `includes` not `startsWith`. FOCUS is sent raw.
      const sys = request.system ?? '';
      if (sys.includes('FOCUS-SYS')) {
        onChunk(script.focus ?? 'FOCUS doc');
        return Promise.resolve(DONE);
      }
      if (sys.includes('PLAN-SYS')) {
        return respond(queues.plan.shift(), onChunk);
      }
      if (sys.includes('CSS-SYS')) {
        return respond(queues.css.shift(), onChunk);
      }
      if (sys.includes('HTML-SYS')) {
        return respond(queues.html.shift(), onChunk);
      }
      return Promise.reject(
        new Error(`scripted client: unexpected system prompt: ${sys.slice(0, 40)}`),
      );
    },
  };
  return { client, seen };
}

function makeService(client: AnthropicClientLike, artifacts: GenArtifactStore) {
  return createGenerationService({
    keyStore: { getKeyForMain: () => KEY },
    clientFactory: () => client,
    templates: templatesWith(),
    notes: notesWith(),
    assets: assetsWith(),
    artifacts,
  });
}

const HAPPY: PipelineScript = {
  plan: [{ text: PLAN_JSON }],
  css: [{ text: GOOD_CSS }],
  html: [{ text: BODY }],
};

const REQUEST = { sessionId: 's1', templateId: 'tmpl-chunk' } as const;

// M08.A: the part marker now rides inside the composed system (mandate first, part
// last), so extract whichever pipeline marker the call carries (FOCUS is sent raw).
const PART_MARKERS = ['FOCUS-SYS', 'PLAN-SYS', 'CSS-SYS', 'HTML-SYS'] as const;
const marker = (r: StreamRequest): string => {
  const sys = r.system ?? '';
  return PART_MARKERS.find((m) => sys.includes(m)) ?? (sys.split('\n')[0] as string);
};

describe('white-paper pipeline — call graph + wires', () => {
  it('runs PLAN → CSS → HTML when a FOCUS artifact exists (no Part-1 re-run)', async () => {
    const { client, seen } = scriptedClient(HAPPY);
    const artifacts = statefulStore([FOCUS_SEED]);
    const service = makeService(client, artifacts);

    const done = await service.generateWhitepaper(REQUEST, { onChunk: () => undefined });

    expect(seen.map(marker)).toEqual(['PLAN-SYS', 'CSS-SYS', 'HTML-SYS']);
    // Every call carries the template's whitepaperPrompt as the document mandate.
    for (const r of seen) {
      expect(r.system).toContain('MANDATE');
    }
    expect(done.kind).toBe('whitepaper');
  });

  it('runs Part 1 first when no FOCUS exists: FOCUS → PLAN → CSS → HTML', async () => {
    const { client, seen } = scriptedClient(HAPPY);
    const artifacts = statefulStore();
    const service = makeService(client, artifacts);

    await service.generateWhitepaper(REQUEST, { onChunk: () => undefined });

    expect(seen.map(marker)).toEqual(['FOCUS-SYS', 'PLAN-SYS', 'CSS-SYS', 'HTML-SYS']);
    expect(artifacts.saved.some((d) => d.kind === 'focus')).toBe(true);
  });

  it('FOCUS rides as the CACHED prefix block on all three downstream calls', async () => {
    const { client, seen } = scriptedClient(HAPPY);
    const service = makeService(client, statefulStore([FOCUS_SEED]));

    await service.generateWhitepaper(REQUEST, { onChunk: () => undefined });

    for (const r of seen) {
      const first = r.messages[0]?.content[0] as { type: string; text?: string; cache?: boolean };
      expect(first?.type).toBe('text');
      expect(first?.cache).toBe(true);
      expect(first?.text).toContain('EXISTING FOCUS DOC');
    }
  });

  it('the css call’s wire carries the PLAN’s inventory classes (the first contract)', async () => {
    const { client, seen } = scriptedClient(HAPPY);
    const service = makeService(client, statefulStore([FOCUS_SEED]));

    await service.generateWhitepaper(REQUEST, { onChunk: () => undefined });

    const cssCall = seen.find((r) => marker(r) === 'CSS-SYS');
    const turn = JSON.stringify(cssCall?.messages);
    expect(turn).toContain('ladder');
    expect(turn).toContain('rung');
    expect(turn).toContain('callout');
    // The plan's direction travels too (palette/typography steer the theme).
    expect(turn).toContain('blue accent');
  });

  it('the html call’s wire carries THE ACTUAL CSS TEXT (one author, writing against the real stylesheet)', async () => {
    const { client, seen } = scriptedClient(HAPPY);
    const service = makeService(client, statefulStore([FOCUS_SEED]));

    await service.generateWhitepaper(REQUEST, { onChunk: () => undefined });

    const htmlCall = seen.find((r) => marker(r) === 'HTML-SYS');
    const turn = JSON.stringify(htmlCall?.messages);
    expect(turn).toContain('.ladder{display:grid}');
    expect(turn).toContain('.rung{border:1px solid}');
    // …and the plan's structure (sections + narrative) for the single author.
    expect(turn).toContain('Introduction');
    expect(turn).toContain('Open with stakes');
  });

  it('persists ONE whitepaper artifact: the STITCHED doc (code-owned shell + css + body)', async () => {
    const { client } = scriptedClient(HAPPY);
    const artifacts = statefulStore([FOCUS_SEED]);
    const service = makeService(client, artifacts);

    const done = await service.generateWhitepaper(REQUEST, { onChunk: () => undefined });

    const wp = artifacts.saved.filter((d) => d.kind === 'whitepaper');
    expect(wp).toHaveLength(1);
    const doc = wp[0]?.content ?? '';
    expect(doc.toLowerCase().startsWith('<!doctype html>')).toBe(true);
    expect(doc).toContain('.ladder{display:grid}');
    expect(doc).toContain('<div class="callout">Key point</div>');
    expect(done.artifactId).toBe(wp[0]?.id);
  });

  it('streams the HTML deltas to the caller but never the plan JSON or raw css', async () => {
    const { client } = scriptedClient(HAPPY);
    const service = makeService(client, statefulStore([FOCUS_SEED]));

    const chunks: string[] = [];
    await service.generateWhitepaper(REQUEST, { onChunk: (d) => chunks.push(d) });

    const streamed = chunks.join('');
    expect(streamed).toContain('<h2>Introduction</h2>');
    expect(streamed).not.toContain('"sections"');
    expect(streamed).not.toContain('--x:1');
  });
});

describe('white-paper pipeline — fixed 4-step progress', () => {
  it('emits plan 2/4 → css 3/4 → html 4/4 when FOCUS is reused (focus 1/4 leads a fresh run)', async () => {
    const { client } = scriptedClient(HAPPY);
    const service = makeService(client, statefulStore([FOCUS_SEED]));

    const steps: GenProgress[] = [];
    await service.generateWhitepaper(REQUEST, {
      onChunk: () => undefined,
      onProgress: (p) => steps.push(p),
    });

    expect(steps).toEqual([
      { step: 'plan', index: 2, total: 4, label: 'Planning the document…' },
      { step: 'css', index: 3, total: 4, label: 'Styling document…' },
      { step: 'html', index: 4, total: 4, label: 'Writing the document…' },
    ]);
  });
});

describe('white-paper pipeline — PLAN validation', () => {
  it('retries a malformed plan once, then fails the run typed (no downstream calls)', async () => {
    const { client, seen } = scriptedClient({
      plan: [{ text: 'not json' }, { text: 'still not json' }],
      css: [],
      html: [],
    });
    const artifacts = statefulStore([FOCUS_SEED]);
    const service = makeService(client, artifacts);

    await expect(
      service.generateWhitepaper(REQUEST, { onChunk: () => undefined }),
    ).rejects.toBeInstanceOf(LlmServiceError);

    expect(seen.map(marker)).toEqual(['PLAN-SYS', 'PLAN-SYS']);
    expect(artifacts.saved.map((d) => d.kind)).toEqual(['focus']);
  });
});

describe('white-paper pipeline — subset guard #1: plan ⊆ css (before the HTML call)', () => {
  it('a stylesheet missing a plan class is rejected: one retry NAMING the gap, then recovery (fixtures authored to DISAGREE)', async () => {
    const { client, seen } = scriptedClient({
      plan: [{ text: PLAN_JSON }],
      css: [{ text: CSS_MISSING_RUNG }, { text: GOOD_CSS }],
      html: [{ text: BODY }],
    });
    const artifacts = statefulStore([FOCUS_SEED]);
    const service = makeService(client, artifacts);

    await service.generateWhitepaper(REQUEST, { onChunk: () => undefined });

    const cssCalls = seen.filter((r) => marker(r) === 'CSS-SYS');
    expect(cssCalls).toHaveLength(2);
    const retryTurn = JSON.stringify(cssCalls[1]?.messages);
    expect(retryTurn).toMatch(/missing/i);
    expect(retryTurn).toContain('rung');
    expect(artifacts.saved.find((d) => d.kind === 'whitepaper')?.content).toContain(
      '.rung{border:1px solid}',
    );
  });

  it('a second miss fails the run typed — the HTML call never runs against an incomplete stylesheet (mutation: guard removed → fails)', async () => {
    const { client, seen } = scriptedClient({
      plan: [{ text: PLAN_JSON }],
      css: [{ text: CSS_MISSING_RUNG }, { text: CSS_MISSING_RUNG }],
      html: [{ text: BODY }],
    });
    const artifacts = statefulStore([FOCUS_SEED]);
    const service = makeService(client, artifacts);

    await expect(
      service.generateWhitepaper(REQUEST, { onChunk: () => undefined }),
    ).rejects.toBeInstanceOf(LlmServiceError);

    expect(seen.some((r) => marker(r) === 'HTML-SYS')).toBe(false);
    expect(artifacts.saved.map((d) => d.kind)).toEqual(['focus']);
  });

  it('a FENCED css part is still unwrapped before the guard runs (fix #1 carried)', async () => {
    const { client } = scriptedClient({
      plan: [{ text: PLAN_JSON }],
      css: [{ text: '```css\n' + GOOD_CSS + '\n```' }],
      html: [{ text: BODY }],
    });
    const artifacts = statefulStore([FOCUS_SEED]);
    const service = makeService(client, artifacts);

    await service.generateWhitepaper(REQUEST, { onChunk: () => undefined });

    const doc = artifacts.saved.find((d) => d.kind === 'whitepaper')?.content ?? '';
    expect(doc).toContain('.ladder{display:grid}');
    expect(doc).not.toContain('```');
  });
});

describe('white-paper pipeline — structure-rejection diagnostic (M06.E IRL fix #3)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a diagnostic log line (marker + model + stop_reason) WITHOUT the body content (S4-001)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // M08.A: a <style>-only body has NO document shell to recover a body from — it is a
    // fragment smuggling a style block, so it stays a REJECTION (the normalizer recovers
    // genuine documents, not stray style blocks). The retry returns a clean body so the
    // run still SUCCEEDS — the diagnostic is instrumentation only, reject/retry unchanged.
    const SECRET = 'CONFIDENTIAL_BODY_MARKER_a17c';
    const offending = `<style>.x{color:red}</style><h2>${SECRET}</h2>`;
    const { client } = scriptedClient({
      plan: [{ text: PLAN_JSON }],
      css: [{ text: GOOD_CSS }],
      html: [{ text: offending, stopReason: 'end_turn' }, { text: BODY }],
    });
    const service = makeService(client, statefulStore([FOCUS_SEED]));

    await service.generateWhitepaper(REQUEST, { onChunk: () => undefined });

    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('[gen:whitepaper]') && l.includes('rejected'));
    expect(line).toBeDefined();
    // The shell marker found in the body (the marker NAME, not body content).
    expect(line).toContain('marker=<style');
    // The answering model + the HTML call's stop_reason are captured for triage.
    expect(line).toContain(`model=${DEFAULT_GENERATION_MODEL}`);
    expect(line).toContain('stopReason=end_turn');
    // S4-001: the generated body content (derived from meeting notes) must NEVER reach main.log
    // (a user-openable, shareable §10 surface whose redactor only strips credential-shaped tokens).
    expect(line).not.toContain('bodyHead=');
    expect(line).not.toContain(SECRET);
  });
});

describe('white-paper pipeline — full-document RECOVERY via parse5 normalizer (M08.A / ADR-0026)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A genuine complete document (doctype/<html>/<head>/<style>/<body>) returned where a
  // body fragment was expected. Previously a hard structure rejection; now the normalizer
  // extracts the body children, discards the model shell/style, and the run SUCCEEDS.
  const FULL_DOC_BODY = `<!doctype html><html><head><style>.model{color:red}</style></head><body>${BODY}</body></html>`;

  it('normalizes a recoverable full-document HTML response and persists it — NO retry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { client, seen } = scriptedClient({
      plan: [{ text: PLAN_JSON }],
      css: [{ text: GOOD_CSS }],
      html: [{ text: FULL_DOC_BODY }],
    });
    const artifacts = statefulStore([FOCUS_SEED]);
    const service = makeService(client, artifacts);

    await service.generateWhitepaper(REQUEST, { onChunk: () => undefined });

    // The long pole ran exactly ONCE — recovery is not a retry.
    expect(seen.filter((r) => marker(r) === 'HTML-SYS')).toHaveLength(1);
    const doc = artifacts.saved.find((d) => d.kind === 'whitepaper')?.content ?? '';
    // The recovered body content is present; the model's shell + style are gone; the
    // stitched doc has exactly the app-owned shell + the app's css (not the model's).
    expect(doc).toContain('<div class="callout">Key point</div>');
    expect(doc.match(/<html/gi)).toHaveLength(1);
    expect(doc.match(/<style/gi)).toHaveLength(1);
    expect(doc).not.toContain('.model{color:red}');
  });

  it('emits a content-free RECOVERY diagnostic on successful normalization (spec §E)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const SECRET = 'CONFIDENTIAL_RECOVERED_BODY_3f9d';
    const recovered = `<!doctype html><html><body>${BODY}<p>${SECRET}</p></body></html>`;
    const { client } = scriptedClient({
      plan: [{ text: PLAN_JSON }],
      css: [{ text: GOOD_CSS }],
      html: [{ text: recovered }],
    });
    const service = makeService(client, statefulStore([FOCUS_SEED]));

    await service.generateWhitepaper(REQUEST, { onChunk: () => undefined });

    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('[gen:whitepaper]') && l.includes('recovered'));
    expect(line).toBeDefined();
    // Observability fields for the watched intermittent-rejection item: the marker that
    // tripped, the model, and the stop_reason — NEVER the recovered body content (S4-001).
    expect(line).toContain('marker=<');
    expect(line).toContain(`model=${DEFAULT_GENERATION_MODEL}`);
    expect(line).not.toContain(SECRET);
  });

  it('a max_tokens full document is TRUNCATED first — never parse5-repaired into success (mutation: move the truncation check after the normalizer → this fails)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { client, seen } = scriptedClient({
      plan: [{ text: PLAN_JSON }],
      css: [{ text: GOOD_CSS }],
      html: [
        { text: FULL_DOC_BODY, stopReason: 'max_tokens' },
        { text: FULL_DOC_BODY, stopReason: 'max_tokens' },
      ],
    });
    const artifacts = statefulStore([FOCUS_SEED]);
    const service = makeService(client, artifacts);

    try {
      await service.generateWhitepaper(REQUEST, { onChunk: () => undefined });
      throw new Error('expected the run to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(LlmServiceError);
      // Truncation is the failure class — NOT structure, and the doc is never persisted.
      expect((error as LlmServiceError).message).toMatch(
        /Writing the document failed — output truncated at the length limit/,
      );
    }
    expect(seen.filter((r) => marker(r) === 'HTML-SYS')).toHaveLength(2);
    expect(artifacts.saved.map((d) => d.kind)).toEqual(['focus']);
  });
});

describe('white-paper pipeline — HTML body-only validation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('an UNRECOVERABLE shell-only body (no document to extract) is a prompt bug: retried once, never an assembly input', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // A <style>-only fragment carries no document shell — there is no body to recover, so
    // it stays a rejection (one retry → success here). The recoverable full-document case
    // is covered by the M08.A recovery suite above.
    const { client, seen } = scriptedClient({
      plan: [{ text: PLAN_JSON }],
      css: [{ text: GOOD_CSS }],
      html: [{ text: `<style>.smuggled{}</style>${BODY}` }, { text: BODY }],
    });
    const artifacts = statefulStore([FOCUS_SEED]);
    const service = makeService(client, artifacts);

    await service.generateWhitepaper(REQUEST, { onChunk: () => undefined });

    expect(seen.filter((r) => marker(r) === 'HTML-SYS')).toHaveLength(2);
    const doc = artifacts.saved.find((d) => d.kind === 'whitepaper')?.content ?? '';
    expect(doc.match(/<html/gi)).toHaveLength(1);
    expect(doc.match(/<body/gi)).toHaveLength(1);
    // The smuggled style block never reached the assembly input.
    expect(doc).not.toContain('.smuggled{}');
  });

  it('a FENCED body is unwrapped (no literal fence in the stitched doc)', async () => {
    const { client } = scriptedClient({
      plan: [{ text: PLAN_JSON }],
      css: [{ text: GOOD_CSS }],
      html: [{ text: '```html\n' + BODY + '\n```' }],
    });
    const artifacts = statefulStore([FOCUS_SEED]);
    const service = makeService(client, artifacts);

    await service.generateWhitepaper(REQUEST, { onChunk: () => undefined });

    const doc = artifacts.saved.find((d) => d.kind === 'whitepaper')?.content ?? '';
    expect(doc).toContain('<h2>Introduction</h2>');
    expect(doc).not.toContain('```');
  });
});

describe('white-paper pipeline — subset guard #2: body ⊆ css (the CSS-PATCH remediation)', () => {
  const BODY_WITH_EXTRA = BODY + '<div class="extra-box">Surprise</div>';

  it('a body class the stylesheet misses triggers ONE incremental CSS-PATCH call — NEVER an HTML retry', async () => {
    const { client, seen } = scriptedClient({
      plan: [{ text: PLAN_JSON }],
      // Queue order: the initial css, then the patch response.
      css: [{ text: GOOD_CSS }, { text: '.extra-box{padding:1rem}' }],
      html: [{ text: BODY_WITH_EXTRA }],
    });
    const artifacts = statefulStore([FOCUS_SEED]);
    const service = makeService(client, artifacts);

    await service.generateWhitepaper(REQUEST, { onChunk: () => undefined });

    // The long pole ran ONCE; the styling gap was remedied on the cheap css side.
    expect(seen.filter((r) => marker(r) === 'HTML-SYS')).toHaveLength(1);
    const cssCalls = seen.filter((r) => marker(r) === 'CSS-SYS');
    expect(cssCalls).toHaveLength(2);
    const patchTurn = JSON.stringify(cssCalls[1]?.messages);
    expect(patchTurn).toMatch(/missing/i);
    expect(patchTurn).toContain('extra-box');

    // The patch is APPENDED to the theme — the stitched doc carries both.
    const doc = artifacts.saved.find((d) => d.kind === 'whitepaper')?.content ?? '';
    expect(doc).toContain('.ladder{display:grid}');
    expect(doc).toContain('.extra-box{padding:1rem}');
  });

  it('a patch that fails to define the missing classes fails the run typed — never a silently broken doc (mutation: guard removed → fails)', async () => {
    const { client, seen } = scriptedClient({
      plan: [{ text: PLAN_JSON }],
      css: [
        { text: GOOD_CSS },
        { text: '.unrelated{margin:0}' }, // patch attempt 1: defines nothing required
        { text: '.still-unrelated{margin:0}' }, // patch attempt 2: same
      ],
      html: [{ text: BODY_WITH_EXTRA }],
    });
    const artifacts = statefulStore([FOCUS_SEED]);
    const service = makeService(client, artifacts);

    await expect(
      service.generateWhitepaper(REQUEST, { onChunk: () => undefined }),
    ).rejects.toBeInstanceOf(LlmServiceError);

    expect(seen.filter((r) => marker(r) === 'HTML-SYS')).toHaveLength(1);
    expect(artifacts.saved.map((d) => d.kind)).toEqual(['focus']);
  });

  it('no gap → no patch call (the remediation is not a fixed cost)', async () => {
    const { client, seen } = scriptedClient(HAPPY);
    const service = makeService(client, statefulStore([FOCUS_SEED]));

    await service.generateWhitepaper(REQUEST, { onChunk: () => undefined });

    expect(seen.filter((r) => marker(r) === 'CSS-SYS')).toHaveLength(1);
  });
});

describe('white-paper pipeline — truncation is a FAILED attempt (IRL fix #3: stop_reason checked on every call)', () => {
  // Artifact 789c90af shipped a stylesheet cut mid-declaration at the 16K ceiling,
  // accepted as success. Now: stop_reason !== end_turn (max_tokens truncation) is a
  // failed attempt on EVERY pipeline call — retry → typed failure naming the step.
  const expectTypedStepError = async (run: Promise<unknown>, pattern: RegExp): Promise<void> => {
    try {
      await run;
      throw new Error('expected the run to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(LlmServiceError);
      expect((error as LlmServiceError).code).toBe('UNKNOWN'); // no new taxonomy code
      expect((error as LlmServiceError).message).toMatch(pattern);
    }
  };

  it('a TRUNCATED plan (valid JSON, stop_reason max_tokens) retries, then fails typed naming the step', async () => {
    const { client, seen } = scriptedClient({
      plan: [
        { text: PLAN_JSON, stopReason: 'max_tokens' },
        { text: PLAN_JSON, stopReason: 'max_tokens' },
      ],
      css: [],
      html: [],
    });
    const artifacts = statefulStore([FOCUS_SEED]);
    const service = makeService(client, artifacts);

    await expectTypedStepError(
      service.generateWhitepaper(REQUEST, { onChunk: () => undefined }),
      /Planning the document failed — output truncated at the length limit/,
    );
    expect(seen.filter((r) => marker(r) === 'PLAN-SYS')).toHaveLength(2);
    expect(artifacts.saved.map((d) => d.kind)).toEqual(['focus']);
  });

  it('a TRUNCATED stylesheet retries, then fails typed — never accepted as success (the 789c90af bug)', async () => {
    const { client, seen } = scriptedClient({
      plan: [{ text: PLAN_JSON }],
      css: [
        { text: GOOD_CSS, stopReason: 'max_tokens' },
        { text: GOOD_CSS, stopReason: 'max_tokens' },
      ],
      html: [{ text: BODY }],
    });
    const artifacts = statefulStore([FOCUS_SEED]);
    const service = makeService(client, artifacts);

    await expectTypedStepError(
      service.generateWhitepaper(REQUEST, { onChunk: () => undefined }),
      /Styling the document failed — output truncated at the length limit/,
    );
    expect(seen.filter((r) => marker(r) === 'CSS-SYS')).toHaveLength(2);
    expect(seen.some((r) => marker(r) === 'HTML-SYS')).toBe(false);
    expect(artifacts.saved.map((d) => d.kind)).toEqual(['focus']);
  });

  it('a truncated first attempt recovers on a clean retry', async () => {
    const { client, seen } = scriptedClient({
      plan: [{ text: PLAN_JSON }],
      css: [{ text: GOOD_CSS, stopReason: 'max_tokens' }, { text: GOOD_CSS }],
      html: [{ text: BODY }],
    });
    const artifacts = statefulStore([FOCUS_SEED]);
    const service = makeService(client, artifacts);

    await service.generateWhitepaper(REQUEST, { onChunk: () => undefined });

    expect(seen.filter((r) => marker(r) === 'CSS-SYS')).toHaveLength(2);
    expect(artifacts.saved.some((d) => d.kind === 'whitepaper')).toBe(true);
  });

  it('a TRUNCATED body retries, then fails typed naming the step', async () => {
    const { client, seen } = scriptedClient({
      plan: [{ text: PLAN_JSON }],
      css: [{ text: GOOD_CSS }],
      html: [
        { text: BODY, stopReason: 'max_tokens' },
        { text: BODY, stopReason: 'max_tokens' },
      ],
    });
    const artifacts = statefulStore([FOCUS_SEED]);
    const service = makeService(client, artifacts);

    await expectTypedStepError(
      service.generateWhitepaper(REQUEST, { onChunk: () => undefined }),
      /Writing the document failed — output truncated at the length limit/,
    );
    expect(seen.filter((r) => marker(r) === 'HTML-SYS')).toHaveLength(2);
    expect(artifacts.saved.map((d) => d.kind)).toEqual(['focus']);
  });

  it('a TRUNCATED css-patch retries, then fails typed naming the step', async () => {
    const { client } = scriptedClient({
      plan: [{ text: PLAN_JSON }],
      css: [
        { text: GOOD_CSS },
        { text: '.extra-box{padding:1rem}', stopReason: 'max_tokens' },
        { text: '.extra-box{padding:1rem}', stopReason: 'max_tokens' },
      ],
      html: [{ text: BODY + '<div class="extra-box">Surprise</div>' }],
    });
    const artifacts = statefulStore([FOCUS_SEED]);
    const service = makeService(client, artifacts);

    await expectTypedStepError(
      service.generateWhitepaper(REQUEST, { onChunk: () => undefined }),
      /Repairing the stylesheet failed — output truncated at the length limit/,
    );
    expect(artifacts.saved.map((d) => d.kind)).toEqual(['focus']);
  });
});

describe('white-paper pipeline — typed failures NAME the step + validation (IRL fix #4: no blind UNKNOWN)', () => {
  // The body-structure case below emits the M06.E structure-rejection diagnostic (console.warn,
  // teed to main.log) — silence it here so the suite output stays clean.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const reject = async (run: Promise<unknown>): Promise<LlmServiceError> => {
    try {
      await run;
      throw new Error('expected the run to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(LlmServiceError);
      return error as LlmServiceError;
    }
  };

  it('plan validation double-failure → "Planning the document failed — plan validation."', async () => {
    const { client } = scriptedClient({
      plan: [{ text: 'LEAK-MARKER not json' }, { text: 'LEAK-MARKER still not json' }],
      css: [],
      html: [],
    });
    const service = makeService(client, statefulStore([FOCUS_SEED]));

    const error = await reject(service.generateWhitepaper(REQUEST, { onChunk: () => undefined }));
    expect(error.message).toMatch(/Planning the document failed — plan validation/);
    // Step + validation class ONLY — never model output content.
    expect(error.message).not.toContain('LEAK-MARKER');
    expect(JSON.stringify(error.toPayload())).not.toContain('LEAK-MARKER');
  });

  it('stylesheet subset double-failure → "Styling the document failed — stylesheet validation."', async () => {
    const { client } = scriptedClient({
      plan: [{ text: PLAN_JSON }],
      css: [{ text: CSS_MISSING_RUNG }, { text: CSS_MISSING_RUNG }],
      html: [{ text: BODY }],
    });
    const service = makeService(client, statefulStore([FOCUS_SEED]));

    const error = await reject(service.generateWhitepaper(REQUEST, { onChunk: () => undefined }));
    expect(error.message).toMatch(/Styling the document failed — stylesheet validation/);
  });

  it('body-structure double-failure → "Writing the document failed — document-structure validation."', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // M08.A: an UNRECOVERABLE body (a <style>-only fragment with no document shell to
    // extract) double-fails on structure — a recoverable full document would normalize.
    const shell = `<style>.x{}</style><h2>only a smuggled style block</h2>`;
    const { client } = scriptedClient({
      plan: [{ text: PLAN_JSON }],
      css: [{ text: GOOD_CSS }],
      html: [{ text: shell }, { text: shell }],
    });
    const service = makeService(client, statefulStore([FOCUS_SEED]));

    const error = await reject(service.generateWhitepaper(REQUEST, { onChunk: () => undefined }));
    expect(error.message).toMatch(/Writing the document failed — document-structure validation/);
  });

  it('patch double-failure → "Repairing the stylesheet failed — stylesheet validation."', async () => {
    const { client } = scriptedClient({
      plan: [{ text: PLAN_JSON }],
      css: [{ text: GOOD_CSS }, { text: '.unrelated{margin:0}' }, { text: '.unrelated{margin:0}' }],
      html: [{ text: BODY + '<div class="extra-box">Surprise</div>' }],
    });
    const service = makeService(client, statefulStore([FOCUS_SEED]));

    const error = await reject(service.generateWhitepaper(REQUEST, { onChunk: () => undefined }));
    expect(error.message).toMatch(/Repairing the stylesheet failed — stylesheet validation/);
  });
});

describe('white-paper pipeline — cancel semantics (A) apply per-call AND between steps', () => {
  it('cancel MID-CALL stops the run: no further calls, no final persist, FOCUS kept', async () => {
    const controller = new AbortController();
    const { client, seen } = scriptedClient({
      plan: [{ text: PLAN_JSON }],
      css: [{ error: new LlmServiceError('CANCELLED'), abortFirst: controller }],
      html: [{ text: BODY }],
    });
    const artifacts = statefulStore([FOCUS_SEED]);
    const service = makeService(client, artifacts);

    await expect(
      service.generateWhitepaper(REQUEST, {
        onChunk: () => undefined,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });

    // CANCELLED is never retried; the html step never runs.
    expect(seen.map(marker)).toEqual(['PLAN-SYS', 'CSS-SYS']);
    expect(artifacts.saved.map((d) => d.kind)).toEqual(['focus']);
  });

  it('cancel BETWEEN steps stops before the next call (the phase-doc trap)', async () => {
    const controller = new AbortController();
    const { client, seen } = scriptedClient({
      // The plan call completes normally, but the abort lands right after it settles —
      // the pipeline must check the signal BETWEEN steps, not just inside calls.
      plan: [{ text: PLAN_JSON, abortAfter: controller }],
      css: [{ text: GOOD_CSS }],
      html: [{ text: BODY }],
    });
    const artifacts = statefulStore([FOCUS_SEED]);
    const service = makeService(client, artifacts);

    await expect(
      service.generateWhitepaper(REQUEST, {
        onChunk: () => undefined,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });

    expect(seen.map(marker)).toEqual(['PLAN-SYS']);
    expect(artifacts.saved.map((d) => d.kind)).toEqual(['focus']);
  });
});
