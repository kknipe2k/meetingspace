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
 * M07.C fix-#3 round, cap-fix pins — GENERATION_MAX_TOKENS calibration.
 *
 * The owner's real-key IRL run died with "Writing the document failed — output
 * truncated at the length limit." That was fix #3's stop_reason guard WORKING (a
 * clean typed failure on the HTML long pole, not a broken render) — but it revealed
 * a SEPARATE defect: the 16K cap was undersized for a real white-paper body. The
 * round-4 real bodies ran ~18–20K output tokens (55–60KB HTML after the 41KB
 * stylesheet); 16K truncates them every time. Authoritative ceilings (claude-api
 * shared/models.md): Sonnet 4.6 / Haiku 4.5 → 64K, Opus 4.8 → 128K, all streamed —
 * the client already streams. The fix raises the cap to 32K (~2.5–3× headroom over a
 * size-disciplined body, well clear of every current generation model's ceiling).
 *
 * The fake here MODELS THE CEILING rather than agreeing by construction (gotcha #6):
 * each scripted call declares the output size it NEEDS; the fake returns the
 * max_tokens truncation stop reason exactly when that need exceeds the cap the
 * service actually passed (request.maxTokens === GENERATION_MAX_TOKENS). So the run
 * outcome is genuinely a function of the constant under test.
 *
 *   Pin (a): a body needing 20K tokens — BETWEEN the old 16K cap and the new 32K cap
 *            — must COMPLETE. Fails today (16K falsely truncates it); passes at 32K.
 *   Pin (b): a body needing 40K tokens — ABOVE the new cap — must STILL fail typed.
 *            The truncation guard must SURVIVE the raise (green now + after; the
 *            worst outcome is a cap raise that silently disables the guard — verified
 *            by the guard-removed mutation at verify_gates).
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

// A scripted call: the text to stream + the output SIZE it needs (in tokens). The
// fake truncates (stop_reason max_tokens) when need > the cap the service passes.
interface Scripted {
  text: string;
  tokens: number;
}
interface Script {
  plan: Scripted[];
  css: Scripted[];
  html: Scripted[];
}

// Small parts that always fit under any sane cap, so only the HTML size is in play.
const SMALL = 500;

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
    getLatestArtifact: (_sessionId, kind) =>
      [...saved].reverse().find((d) => d.kind === kind) ?? null,
  };
}

// Ceiling-modeling client: stream the scripted text, then report max_tokens truncation
// IFF the call needed more tokens than the cap the service passed on the request.
function ceilingClient(script: Script): { client: AnthropicClientLike; seen: StreamRequest[] } {
  const seen: StreamRequest[] = [];
  const queues = { plan: [...script.plan], css: [...script.css], html: [...script.html] };
  const serve = (q: Scripted[], cap: number, onChunk: (d: string) => void) => {
    const entry = q.shift();
    if (!entry) {
      return Promise.reject(new Error('ceiling client: queue exhausted — unexpected extra call'));
    }
    onChunk(entry.text);
    const stopReason = entry.tokens > cap ? 'max_tokens' : 'end_turn';
    return Promise.resolve({ stopReason, usage: { inputTokens: 1, outputTokens: 2 }, model: 'm' });
  };
  const client: AnthropicClientLike = {
    streamMessage(request, onChunk) {
      seen.push(request);
      const cap = request.maxTokens;
      const sys = request.system ?? '';
      if (sys.includes('FOCUS-SYS')) {
        onChunk('FOCUS doc');
        return Promise.resolve({
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 2 },
          model: 'm',
        });
      }
      if (sys.includes('PLAN-SYS')) return serve(queues.plan, cap, onChunk);
      if (sys.includes('CSS-SYS')) return serve(queues.css, cap, onChunk);
      if (sys.includes('HTML-SYS')) return serve(queues.html, cap, onChunk);
      return Promise.reject(new Error(`unexpected system: ${sys.slice(0, 30)}`));
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

const REQUEST = { sessionId: 's1', templateId: 'tmpl-chunk' } as const;

describe('GENERATION_MAX_TOKENS — the cap holds a real white-paper body', () => {
  it('the cap clears the size of a real body (≥ 32K — round-4 bodies ran ~18–20K tokens)', () => {
    // Anchors the calibration to the constant itself: the IRL truncation proved 16K
    // is below a real body; the fix must clear the observed ~18–20K with headroom.
    expect(GENERATION_MAX_TOKENS).toBeGreaterThanOrEqual(32000);
  });

  it('(a) a body that EXCEEDS 16K but FITS within 32K COMPLETES — no false truncation', async () => {
    // 20K tokens: between the old cap (truncates → typed failure) and the new cap (fits).
    const { client } = ceilingClient({
      plan: [{ text: PLAN_JSON, tokens: SMALL }],
      css: [{ text: GOOD_CSS, tokens: SMALL }],
      // Two attempts at 20K: at the old 16K cap BOTH truncate and the run rejects;
      // at 32K the first completes and the second is never consumed.
      html: [
        { text: BODY, tokens: 20000 },
        { text: BODY, tokens: 20000 },
      ],
    });
    const artifacts = statefulStore([FOCUS_SEED]);
    const service = makeService(client, artifacts);

    const done = await service.generateWhitepaper(REQUEST, { onChunk: () => undefined });

    expect(done.kind).toBe('whitepaper');
    expect(artifacts.saved.some((d) => d.kind === 'whitepaper')).toBe(true);
  });

  it('(b) a body ABOVE the new cap STILL fails typed — the fix-#3 truncation guard survives the raise', async () => {
    // 40K tokens: above 32K, so even after the raise the HTML call truncates and the
    // guard must convert it to the step-tagged typed failure (never a broken doc).
    const { client, seen } = ceilingClient({
      plan: [{ text: PLAN_JSON, tokens: SMALL }],
      css: [{ text: GOOD_CSS, tokens: SMALL }],
      html: [
        { text: BODY, tokens: 40000 },
        { text: BODY, tokens: 40000 },
      ],
    });
    const artifacts = statefulStore([FOCUS_SEED]);
    const service = makeService(client, artifacts);

    try {
      await service.generateWhitepaper(REQUEST, { onChunk: () => undefined });
      throw new Error('expected the run to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(LlmServiceError);
      expect((error as LlmServiceError).code).toBe('UNKNOWN'); // no new taxonomy code
      expect((error as LlmServiceError).message).toMatch(
        /Writing the document failed — output truncated at the length limit/,
      );
    }
    // One retry then typed failure; nothing persisted as final.
    expect(seen.filter((r) => (r.system ?? '').includes('HTML-SYS'))).toHaveLength(2);
    expect(artifacts.saved.map((d) => d.kind)).toEqual(['focus']);
  });
});
