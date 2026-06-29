import { describe, expect, it, vi } from 'vitest';

import type {
  AnthropicClientLike,
  StreamRequest,
  StreamResult,
} from '../../electron/llm/anthropic-client';
import type { CorpusAssetReader, CorpusNoteReader } from '../../electron/gen/corpus';
import {
  createGenerationService,
  type GenArtifactStore,
  NO_CONTENT_GENERATION_MESSAGE,
} from '../../electron/gen/generation-service';
import { SEED_TEMPLATE_ID } from '../../electron/gen/prompt-templates';
import { LlmServiceError } from '../../electron/llm/errors';
import { DEFAULT_GENERATION_MODEL } from '@shared/models';
import type { Asset, GenDocument, GenKind, GenTemplate, Note } from '@shared/types';

/*
 * generateWhitepaper (M04.B two-call → M07.C chunked). The pipeline expands the
 * persisted FOCUS artifact through outline → per-section → css calls and persists the
 * ASSEMBLED document as ONE `whitepaper` artifact. When no FOCUS artifact exists yet
 * it runs Part 1 first (silently — those deltas are NOT streamed to the user-facing
 * handler), so a single "Generate" action just works; an empty session spends no
 * tokens. Errors reuse the M03 typed, KEY-FREE taxonomy. Driven with fakes — no SDK,
 * no network, no DB. (The full chunked call-graph/retry/cancel pins live in
 * chunked-generation.test.ts; this file keeps the M04 contract surface.)
 */
const KEY = 'sk-ant-api03-THIS-IS-A-FAKE-TEST-KEY-000';

const TEMPLATE = {
  id: SEED_TEMPLATE_ID,
  name: 'Default',
  focusPrompt: 'FOCUS-SYSTEM-PROMPT',
  whitepaperPrompt: 'WHITEPAPER-MANDATE',
  planPrompt: 'PLAN-SYS',
  cssPrompt: 'CSS-SYS',
  htmlPrompt: 'HTML-SYS',
  isDefault: true,
} as GenTemplate;

function note(content: string): Note {
  return { id: 'n1', sessionId: 's1', content, createdAt: 1, updatedAt: 1 };
}

function notesWith(notes: Note[] = [note('We shipped on Friday.')]): CorpusNoteReader {
  return { listNotes: () => notes };
}

function assetsWith(assets: Asset[] = []): CorpusAssetReader {
  return { listAssets: () => assets, readImage: () => ({ mediaType: 'image/png', data: 'IMG' }) };
}

function templatesWith(): { getTemplate: (id: string) => GenTemplate | null } {
  return { getTemplate: (id) => (id === SEED_TEMPLATE_ID ? TEMPLATE : null) };
}

// A stateful fake artifact store: saveArtifact appends, getLatestArtifact returns
// the newest of a kind — so the ensure-FOCUS path can read back the FOCUS doc it
// just persisted, mirroring the real ArtifactStore.
function fakeArtifacts(seed: GenDocument[] = []): GenArtifactStore & { saved: GenDocument[] } {
  const saved = [...seed];
  let seq = saved.length;
  return {
    saved,
    saveArtifact(input) {
      seq += 1;
      const doc: GenDocument = { id: `doc-${seq}`, createdAt: seq, ...input };
      saved.push(doc);
      return doc;
    },
    getLatestArtifact(sessionId: string, kind: GenKind) {
      const matches = saved.filter((d) => d.sessionId === sessionId && d.kind === kind);
      return matches.length > 0 ? (matches[matches.length - 1] as GenDocument) : null;
    },
  };
}

const DONE: StreamResult = {
  stopReason: 'end_turn',
  usage: { inputTokens: 1, outputTokens: 2 },
  model: DEFAULT_GENERATION_MODEL,
};

const PLAN_1 = JSON.stringify({
  sections: [{ title: 'Core', brief: 'The core themes.' }],
  narrative: 'One arc.',
  illustrations: [],
  palette: 'light',
  typography: 'serif',
});

// Routes each call by the composed system prompt's leading part marker (the template's
// whitepaperPrompt rides along as the document mandate), recording every request.
function chunkedClient(): { client: AnthropicClientLike; seen: StreamRequest[] } {
  const seen: StreamRequest[] = [];
  const client: AnthropicClientLike = {
    streamMessage: (request, onChunk) => {
      seen.push(request);
      // M08.A: PLAN/CSS/HTML parts ride INSIDE the composed system (mandate first, part
      // last), so route by `includes`; the FOCUS call is sent raw (falls to else).
      const sys = request.system ?? '';
      if (sys.includes('PLAN-SYS')) {
        onChunk(PLAN_1);
      } else if (sys.includes('CSS-SYS')) {
        onChunk(':root{--w:1}');
      } else if (sys.includes('HTML-SYS')) {
        onChunk('<h1>Paper</h1><p>Body.</p>');
      } else {
        onChunk('FOCUS doc');
      }
      return Promise.resolve(DONE);
    },
  };
  return { client, seen };
}

function makeService(over: {
  key?: string | null;
  artifacts?: GenArtifactStore & { saved: GenDocument[] };
  client?: AnthropicClientLike;
  clientFactory?: () => AnthropicClientLike;
  notes?: CorpusNoteReader;
  assets?: CorpusAssetReader;
}): {
  service: ReturnType<typeof createGenerationService>;
  artifacts: GenArtifactStore & { saved: GenDocument[] };
} {
  const artifacts = over.artifacts ?? fakeArtifacts();
  const client = over.client ?? chunkedClient().client;
  const service = createGenerationService({
    keyStore: { getKeyForMain: () => (over.key === undefined ? KEY : over.key) },
    clientFactory: over.clientFactory ?? (() => client),
    templates: templatesWith(),
    notes: over.notes ?? notesWith(),
    assets: over.assets ?? assetsWith(),
    artifacts,
  });
  return { service, artifacts };
}

const FOCUS_SEED: GenDocument = {
  id: 'f1',
  sessionId: 's1',
  kind: 'focus',
  content: 'EXISTING FOCUS DOC',
  templateId: 'default',
  createdAt: 1,
};

describe('createGenerationService.generateWhitepaper', () => {
  it('rejects with NO_KEY and never builds a client when no key is configured', async () => {
    const clientFactory = vi.fn(() => chunkedClient().client);
    const { service } = makeService({ key: null, clientFactory });

    await expect(
      service.generateWhitepaper({ sessionId: 's1' }, { onChunk: () => undefined }),
    ).rejects.toMatchObject({ code: 'NO_KEY' });
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('reuses an existing FOCUS artifact — no Part-1 re-run before the pipeline calls', async () => {
    const { client, seen } = chunkedClient();
    const artifacts = fakeArtifacts([FOCUS_SEED]);
    const { service } = makeService({ client, artifacts });

    const done = await service.generateWhitepaper(
      { sessionId: 's1' },
      { onChunk: () => undefined },
    );

    // No FOCUS-system call: the run goes straight into the pipeline.
    expect(seen.some((r) => r.system?.startsWith('FOCUS-SYSTEM-PROMPT'))).toBe(false);
    // M08.A: the PLAN part now rides inside the composed system (mandate first, part last).
    expect(seen[0]?.system?.startsWith('<document_mandate>')).toBe(true);
    expect(seen[0]?.system?.includes('PLAN-SYS')).toBe(true);
    // The persisted FOCUS doc is the pipeline calls' primary reference.
    expect(JSON.stringify(seen[0]?.messages)).toContain('EXISTING FOCUS DOC');
    expect(done.kind).toBe('whitepaper');
  });

  it('reanalyze:true re-runs Part 1 even when a FOCUS artifact exists, then writes from the FRESH FOCUS', async () => {
    const { client, seen } = chunkedClient();
    const artifacts = fakeArtifacts([FOCUS_SEED]);
    const { service } = makeService({ client, artifacts });

    const done = await service.generateWhitepaper(
      { sessionId: 's1', reanalyze: true },
      { onChunk: () => undefined },
    );

    // Part 1 (FOCUS) re-ran despite an existing FOCUS doc — it leads the call sequence.
    expect(seen[0]?.system?.startsWith('FOCUS-SYSTEM-PROMPT')).toBe(true);
    // A fresh FOCUS artifact was persisted (the seed + the re-analysis).
    expect(artifacts.saved.filter((d) => d.kind === 'focus')).toHaveLength(2);
    // The pipeline wrote from the FRESH FOCUS ("FOCUS doc"), not the stale seed.
    const planCall = seen.find((r) => r.system?.includes('PLAN-SYS'));
    expect(JSON.stringify(planCall?.messages)).toContain('FOCUS doc');
    expect(JSON.stringify(planCall?.messages)).not.toContain('EXISTING FOCUS DOC');
    expect(done.kind).toBe('whitepaper');
  });

  it('persists the ASSEMBLED document as ONE whitepaper artifact (code-owned shell)', async () => {
    const artifacts = fakeArtifacts([FOCUS_SEED]);
    const { service } = makeService({ artifacts });

    const done = await service.generateWhitepaper(
      { sessionId: 's1' },
      { onChunk: () => undefined },
    );

    const wp = artifacts.saved.filter((d) => d.kind === 'whitepaper');
    expect(wp).toHaveLength(1);
    const doc = wp[0]?.content ?? '';
    expect(doc.toLowerCase().startsWith('<!doctype html>')).toBe(true);
    expect(doc).toContain('<h1>Paper</h1>');
    expect(doc).toContain('--w:1');
    expect(done.artifactId).toBe(wp[0]?.id);
  });

  it('runs Part 1 first when no FOCUS exists, streaming the body deltas but never the FOCUS analysis', async () => {
    const { client, seen } = chunkedClient();
    const artifacts = fakeArtifacts(); // no focus yet
    const { service } = makeService({ client, artifacts });

    const chunks: string[] = [];
    await service.generateWhitepaper({ sessionId: 's1' }, { onChunk: (d) => chunks.push(d) });

    // Part 1 (focus prompt) leads, then the pipeline in order. M08.A: the pipeline parts
    // ride inside the composed system, so extract the embedded marker (FOCUS is raw).
    const partMarker = (r: { system?: string }): string => {
      const sys = r.system ?? '';
      return (
        ['FOCUS-SYSTEM-PROMPT', 'PLAN-SYS', 'CSS-SYS', 'HTML-SYS'].find((m) => sys.includes(m)) ??
        sys.split('\n')[0] ??
        ''
      );
    };
    expect(seen.map(partMarker)).toEqual([
      'FOCUS-SYSTEM-PROMPT',
      'PLAN-SYS',
      'CSS-SYS',
      'HTML-SYS',
    ]);
    // A FOCUS artifact was persisted by the silent Part-1 step.
    expect(artifacts.saved.some((d) => d.kind === 'focus')).toBe(true);
    // The user-facing stream carries the body deltas only — never the FOCUS
    // analysis, the plan JSON, or the raw css.
    expect(chunks.join('')).toContain('<h1>Paper</h1>');
    expect(chunks.join('')).not.toContain('FOCUS doc');
    expect(chunks.join('')).not.toContain('"sections"');
  });

  it('emits the no-content marker and spends no tokens for an empty session with no FOCUS', async () => {
    const clientFactory = vi.fn(() => chunkedClient().client);
    const artifacts = fakeArtifacts();
    const { service } = makeService({
      clientFactory,
      artifacts,
      notes: notesWith([note('   ')]),
      assets: assetsWith([]),
    });

    const chunks: string[] = [];
    const done = await service.generateWhitepaper(
      { sessionId: 's1' },
      { onChunk: (d) => chunks.push(d) },
    );

    expect(clientFactory).not.toHaveBeenCalled();
    expect(artifacts.saved).toHaveLength(0);
    expect(chunks).toEqual([NO_CONTENT_GENERATION_MESSAGE]);
    expect(done.stopReason).toBe('no_content');
    expect(done.kind).toBe('whitepaper');
  });

  it('maps a chunked-call client failure to a typed, key-free error', async () => {
    const artifacts = fakeArtifacts([FOCUS_SEED]);
    const failing: AnthropicClientLike = {
      streamMessage: () => Promise.reject(new Error(`boom x-api-key: ${KEY}`)),
    };
    const { service } = makeService({ artifacts, client: failing });

    try {
      await service.generateWhitepaper({ sessionId: 's1' }, { onChunk: () => undefined });
      throw new Error('expected generateWhitepaper to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(LlmServiceError);
      expect((error as LlmServiceError).message).not.toContain(KEY);
      expect(JSON.stringify((error as LlmServiceError).toPayload())).not.toContain(KEY);
    }
  });
});
