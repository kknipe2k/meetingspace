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
  type GenTemplateReader,
  GENERATION_MAX_TOKENS,
  NO_CONTENT_GENERATION_MESSAGE,
} from '../../electron/gen/generation-service';
import { FOCUS_PROMPT, SEED_TEMPLATE_ID } from '../../electron/gen/prompt-templates';
import { LlmServiceError } from '../../electron/llm/errors';
import { DEFAULT_GENERATION_MODEL } from '@shared/models';
import type { Asset, GenDocument, GenTemplate, Note } from '@shared/types';

/*
 * The generation service (M04.A): reads the key from KeyStore.getKeyForMain() PER
 * CALL (Hard Rule §10), assembles the session corpus main-side, streams Part 1
 * (FOCUS doc) over the REUSED M03 client (no second SDK surface), persists the
 * FOCUS artifact, and surfaces the M03 typed, KEY-FREE error taxonomy. An empty
 * session spends no tokens. Driven with fakes — no SDK, no network, no DB.
 */
const KEY = 'sk-ant-api03-THIS-IS-A-FAKE-TEST-KEY-000';

function note(content: string): Note {
  return { id: 'n1', sessionId: 's1', content, createdAt: 1, updatedAt: 1 };
}

function notesWith(notes: Note[] = [note('We shipped on Friday.')]): CorpusNoteReader {
  return { listNotes: () => notes };
}

function assetsWith(assets: Asset[] = []): CorpusAssetReader {
  return { listAssets: () => assets, readImage: () => ({ mediaType: 'image/png', data: 'IMG' }) };
}

const DEFAULT_TEMPLATE_OBJ: GenTemplate = {
  id: SEED_TEMPLATE_ID,
  name: 'Default',
  focusPrompt: FOCUS_PROMPT,
  whitepaperPrompt: 'wp',
  isDefault: true,
};

function templatesWith(map: Record<string, GenTemplate> = {}): GenTemplateReader {
  return {
    getTemplate: (id) => map[id] ?? (id === SEED_TEMPLATE_ID ? DEFAULT_TEMPLATE_OBJ : null),
  };
}

function artifactWriter(): GenArtifactStore & { saved: Array<Record<string, unknown>> } {
  const saved: Array<Record<string, unknown>> = [];
  return {
    saved,
    saveArtifact(input): GenDocument {
      saved.push(input as unknown as Record<string, unknown>);
      return { id: 'doc-1', createdAt: 1, ...input };
    },
    // generateFocus never reads back an artifact; null is sufficient here.
    getLatestArtifact: () => null,
  };
}

function fakeClient(
  onStream: (request: StreamRequest, onChunk: (delta: string) => void) => StreamResult,
): AnthropicClientLike {
  return { streamMessage: (request, onChunk) => Promise.resolve(onStream(request, onChunk)) };
}

const DONE: StreamResult = {
  stopReason: 'end_turn',
  usage: { inputTokens: 1, outputTokens: 2 },
  model: DEFAULT_GENERATION_MODEL,
};

describe('createGenerationService.generateFocus', () => {
  it('reads the key per call and builds the client with it', async () => {
    const getKeyForMain = vi.fn(() => KEY);
    const clientFactory = vi.fn(() => fakeClient(() => DONE));
    const service = createGenerationService({
      keyStore: { getKeyForMain },
      clientFactory,
      templates: templatesWith(),
      notes: notesWith(),
      assets: assetsWith(),
      artifacts: artifactWriter(),
    });

    await service.generateFocus({ sessionId: 's1' }, { onChunk: () => undefined });

    expect(getKeyForMain).toHaveBeenCalledTimes(1);
    expect(clientFactory).toHaveBeenCalledWith({ apiKey: KEY });
  });

  it('rejects with NO_KEY and never constructs a client when no key is configured', async () => {
    const clientFactory = vi.fn(() => fakeClient(() => DONE));
    const service = createGenerationService({
      keyStore: { getKeyForMain: () => null },
      clientFactory,
      templates: templatesWith(),
      notes: notesWith(),
      assets: assetsWith(),
      artifacts: artifactWriter(),
    });

    await expect(
      service.generateFocus({ sessionId: 's1' }, { onChunk: () => undefined }),
    ).rejects.toMatchObject({ code: 'NO_KEY' });
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('runs Part 1 with the template FOCUS prompt as the cached system, corpus + images in the user turn', async () => {
    let seen: StreamRequest | undefined;
    const service = createGenerationService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory: () =>
        fakeClient((request, onChunk) => {
          seen = request;
          onChunk('FOCUS ');
          onChunk('doc');
          return DONE;
        }),
      templates: templatesWith(),
      notes: notesWith([note('We shipped on Friday.')]),
      assets: assetsWith([
        { id: 'a1', sessionId: 's1', kind: 'screenshot', relativePath: 's1/a1.png', createdAt: 1 },
      ]),
      artifacts: artifactWriter(),
    });

    const chunks: string[] = [];
    const done = await service.generateFocus(
      { sessionId: 's1' },
      { onChunk: (d) => chunks.push(d) },
    );

    expect(chunks).toEqual(['FOCUS ', 'doc']);
    expect(done.kind).toBe('focus');
    expect(seen?.model).toBe(DEFAULT_GENERATION_MODEL);
    expect(seen?.maxTokens).toBe(GENERATION_MAX_TOKENS);
    expect(seen?.system).toBe(FOCUS_PROMPT);
    // the user turn carries the note corpus AND the screenshot as an image block
    const userContent = seen?.messages[0]?.content ?? [];
    expect(JSON.stringify(userContent)).toContain('We shipped on Friday.');
    expect(userContent.some((b) => b.type === 'image')).toBe(true);
  });

  it('persists the streamed FOCUS doc as a re-runnable artifact', async () => {
    const artifacts = artifactWriter();
    const service = createGenerationService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory: () =>
        fakeClient((_request, onChunk) => {
          onChunk('Part one ');
          onChunk('output');
          return DONE;
        }),
      templates: templatesWith(),
      notes: notesWith(),
      assets: assetsWith(),
      artifacts,
    });

    const done = await service.generateFocus({ sessionId: 's1' }, { onChunk: () => undefined });

    expect(artifacts.saved).toHaveLength(1);
    expect(artifacts.saved[0]).toMatchObject({
      sessionId: 's1',
      kind: 'focus',
      content: 'Part one output',
    });
    expect(done.artifactId).toBe('doc-1');
  });

  it('selects a forked template by id', async () => {
    const fork: GenTemplate = {
      id: 'tmpl-1',
      name: 'Mine',
      focusPrompt: 'MY CUSTOM FOCUS PROMPT',
      whitepaperPrompt: 'wp',
      isDefault: false,
    };
    let seen: StreamRequest | undefined;
    const service = createGenerationService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory: () =>
        fakeClient((request) => {
          seen = request;
          return DONE;
        }),
      templates: templatesWith({ 'tmpl-1': fork }),
      notes: notesWith(),
      assets: assetsWith(),
      artifacts: artifactWriter(),
    });

    await service.generateFocus(
      { sessionId: 's1', templateId: 'tmpl-1' },
      { onChunk: () => undefined },
    );

    expect(seen?.system).toBe('MY CUSTOM FOCUS PROMPT');
  });

  it('emits a no-content marker and skips the SDK + persistence for an empty session', async () => {
    const clientFactory = vi.fn(() => fakeClient(() => DONE));
    const artifacts = artifactWriter();
    const service = createGenerationService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory,
      templates: templatesWith(),
      notes: notesWith([note('   ')]),
      assets: assetsWith([]),
      artifacts,
    });

    const chunks: string[] = [];
    const done = await service.generateFocus(
      { sessionId: 's1' },
      { onChunk: (d) => chunks.push(d) },
    );

    expect(clientFactory).not.toHaveBeenCalled();
    expect(artifacts.saved).toHaveLength(0);
    expect(chunks).toEqual([NO_CONTENT_GENERATION_MESSAGE]);
    expect(done.stopReason).toBe('no_content');
  });

  it('maps an unrecognized client failure to a typed UNKNOWN error', async () => {
    const service = createGenerationService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory: () => ({ streamMessage: () => Promise.reject(new Error('boom')) }),
      templates: templatesWith(),
      notes: notesWith(),
      assets: assetsWith(),
      artifacts: artifactWriter(),
    });

    await expect(
      service.generateFocus({ sessionId: 's1' }, { onChunk: () => undefined }),
    ).rejects.toMatchObject({ code: 'UNKNOWN' });
  });

  it('never includes the key in a surfaced generation error (even if the cause echoes it)', async () => {
    const service = createGenerationService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory: () => ({
        streamMessage: () => Promise.reject(new Error(`failed with x-api-key: ${KEY}`)),
      }),
      templates: templatesWith(),
      notes: notesWith(),
      assets: assetsWith(),
      artifacts: artifactWriter(),
    });

    try {
      await service.generateFocus({ sessionId: 's1' }, { onChunk: () => undefined });
      throw new Error('expected generateFocus to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(LlmServiceError);
      const surfaced = error as LlmServiceError;
      expect(surfaced.message).not.toContain(KEY);
      expect(JSON.stringify(surfaced.toPayload())).not.toContain(KEY);
    }
  });
});
