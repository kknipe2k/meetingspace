import { describe, expect, it } from 'vitest';

import type { AnthropicClientLike, StreamRequest } from '../../electron/llm/anthropic-client';
import type { CorpusAssetReader, CorpusNoteReader } from '../../electron/gen/corpus';
import {
  createGenerationService,
  GENERATION_MAX_TOKENS,
  type GenArtifactStore,
  type GenTemplateReader,
} from '../../electron/gen/generation-service';
import { LlmServiceError } from '../../electron/llm/errors';
import type { Asset, GenDocument, GenTemplate, Note } from '@shared/types';

/*
 * M07.D item 7 — the model-aware GENERATION_MAX_TOKENS cap (M07.C carry-forward). The
 * static 32000 becomes min(32000, maxOutputTokens(activeModel)) resolved ONCE per run from
 * the STATIC seeds; unknown → static 32000; the fix-#3 truncation guard still fires at the
 * RESOLVED ceiling. The fake MODELS THE CEILING — it reads the REAL request.maxTokens the
 * service passes and truncates iff need > that value (gotcha #8: a genuine function of the
 * constant, not agreement by construction), and we assert request.maxTokens directly. The
 * resolver is injected so both the below-32K and above-32K branches are deterministic.
 */
const KEY = 'sk-ant-api03-THIS-IS-A-FAKE-TEST-KEY-000';

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
  sections: [{ title: 'Introduction', brief: 'Set the stage' }],
  narrative: 'Open with stakes, close with action.',
  illustrations: [
    { name: 'Pattern Ladder', type: 'ladder', classNames: ['callout'], structure: '4 rungs' },
  ],
  palette: 'light, slate, blue accent',
  typography: 'serif body, sans headings',
});
const GOOD_CSS = ':root{--x:1}\n.callout{border-left:4px solid}';
const BODY = ['<h2>Introduction</h2>', '<div class="callout">Key point</div>', '<p>Done.</p>'].join(
  '',
);
const FOCUS_SEED: GenDocument = {
  id: 'f1',
  sessionId: 's1',
  kind: 'focus',
  content: 'EXISTING FOCUS DOC',
  templateId: 'tmpl-chunk',
  createdAt: 1,
};
const SMALL = 500;

interface Scripted {
  text: string;
  tokens: number;
}
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
function templatesWith(): GenTemplateReader {
  return { getTemplate: (id) => (id === CHUNK_TEMPLATE.id ? CHUNK_TEMPLATE : null) };
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
    getLatestArtifact: (_s, kind) => [...saved].reverse().find((d) => d.kind === kind) ?? null,
  };
}

function ceilingClient(htmlTokens: number): { client: AnthropicClientLike; seen: StreamRequest[] } {
  const seen: StreamRequest[] = [];
  const plan: Scripted = { text: PLAN_JSON, tokens: SMALL };
  const css: Scripted = { text: GOOD_CSS, tokens: SMALL };
  const htmlQueue: Scripted[] = [
    { text: BODY, tokens: htmlTokens },
    { text: BODY, tokens: htmlTokens },
  ];
  const serve = (entry: Scripted | undefined, cap: number, onChunk: (d: string) => void) => {
    if (!entry) return Promise.reject(new Error('queue exhausted'));
    onChunk(entry.text);
    return Promise.resolve({
      stopReason: entry.tokens > cap ? 'max_tokens' : 'end_turn',
      usage: { inputTokens: 1, outputTokens: 2 },
      model: 'm',
    });
  };
  const client: AnthropicClientLike = {
    streamMessage(request, onChunk) {
      seen.push(request);
      const cap = request.maxTokens; // the REAL value the service passed
      const sys = request.system ?? '';
      if (sys.includes('FOCUS-SYS')) {
        onChunk('FOCUS');
        return Promise.resolve({
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 2 },
          model: 'm',
        });
      }
      if (sys.includes('PLAN-SYS')) return serve(plan, cap, onChunk);
      if (sys.includes('CSS-SYS')) return serve(css, cap, onChunk);
      if (sys.includes('HTML-SYS')) return serve(htmlQueue.shift(), cap, onChunk);
      return Promise.reject(new Error(`unexpected system: ${sys.slice(0, 20)}`));
    },
  };
  return { client, seen };
}

function makeService(
  client: AnthropicClientLike,
  artifacts: GenArtifactStore,
  modelMaxTokens?: (model: string) => number | null,
) {
  return createGenerationService({
    keyStore: { getKeyForMain: () => KEY },
    clientFactory: () => client,
    templates: templatesWith(),
    notes: notesWith(),
    assets: assetsWith(),
    artifacts,
    ...(modelMaxTokens ? { modelMaxTokens } : {}),
  });
}

const REQUEST = { sessionId: 's1', templateId: 'tmpl-chunk' } as const;

describe('model-aware GENERATION_MAX_TOKENS cap', () => {
  it('caps at the MODEL ceiling when it is below 32000 (a 20K body that fits 32K now truncates typed)', async () => {
    // Resolver reports a 16000-token model ceiling → resolved cap 16000 → the 20K body
    // truncates and the guard converts it to a typed failure. (Reverting to the static
    // 32000 makes this body complete — the mutation that proves the cap is model-aware.)
    const { client, seen } = ceilingClient(20000);
    const artifacts = statefulStore([FOCUS_SEED]);
    const service = makeService(client, artifacts, () => 16000);

    await expect(
      service.generateWhitepaper(REQUEST, { onChunk: () => undefined }),
    ).rejects.toBeInstanceOf(LlmServiceError);
    // Every call carried the resolved 16000 cap (read off the real request).
    expect(seen.every((r) => r.maxTokens === 16000)).toBe(true);
    expect(artifacts.saved.map((d) => d.kind)).toEqual(['focus']);
  });

  it('caps at the app bound (32000) when the model ceiling is HIGHER — a 20K body completes', async () => {
    const { client, seen } = ceilingClient(20000);
    const artifacts = statefulStore([FOCUS_SEED]);
    const service = makeService(client, artifacts, () => 64000);

    const done = await service.generateWhitepaper(REQUEST, { onChunk: () => undefined });

    expect(done.kind).toBe('whitepaper');
    expect(seen.every((r) => r.maxTokens === GENERATION_MAX_TOKENS)).toBe(true);
  });

  it('falls soft to the static 32000 for an unknown model (resolver returns null)', async () => {
    const { client, seen } = ceilingClient(20000);
    const artifacts = statefulStore([FOCUS_SEED]);
    const service = makeService(client, artifacts, () => null);

    const done = await service.generateWhitepaper(REQUEST, { onChunk: () => undefined });

    expect(done.kind).toBe('whitepaper');
    expect(seen.every((r) => r.maxTokens === GENERATION_MAX_TOKENS)).toBe(true);
  });

  it('the truncation guard still fires at the resolved ceiling (a 40K body fails typed even at 32000)', async () => {
    const { client } = ceilingClient(40000);
    const artifacts = statefulStore([FOCUS_SEED]);
    const service = makeService(client, artifacts, () => 64000); // resolved cap 32000

    await expect(
      service.generateWhitepaper(REQUEST, { onChunk: () => undefined }),
    ).rejects.toMatchObject({ code: 'UNKNOWN' });
  });
});
