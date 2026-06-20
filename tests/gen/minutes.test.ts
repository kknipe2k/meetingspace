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
  NO_CONTENT_GENERATION_MESSAGE,
} from '../../electron/gen/generation-service';
import { MINUTES_PROMPT } from '../../electron/gen/prompt-templates';
import { DEFAULT_GENERATION_MODEL } from '@shared/models';
import type { Asset, GenDocument, Note } from '@shared/types';

/*
 * Structured minutes + raw mode (M04.C). `generateMinutes` runs a single SDK call
 * over the session corpus with the dedicated MINUTES_PROMPT system (a fixed v1
 * prompt, NOT the forkable white-paper template) and persists a `minutes` artifact.
 * `buildRawDoc` is the saved-and-searchable path: it assembles the note blocks into
 * an HTML document MAIN-SIDE with NO SDK call and NO key read — raw notes never
 * spend a token. Driven with fakes; no SDK, no network, no DB.
 */
const KEY = 'sk-ant-api03-FAKE-MINUTES-KEY';

function note(content: string): Note {
  return { id: 'n1', sessionId: 's1', content, createdAt: 1, updatedAt: 1 };
}

function notesWith(list: Note[]): CorpusNoteReader {
  return { listNotes: () => list };
}

function assetsWith(list: Asset[] = []): CorpusAssetReader {
  return { listAssets: () => list, readImage: () => ({ mediaType: 'image/png', data: 'IMG' }) };
}

const templates: GenTemplateReader = {
  getTemplate: () => ({
    id: 'default',
    name: 'Default',
    focusPrompt: 'f',
    whitepaperPrompt: 'w',
    isDefault: true,
  }),
};

function artifactStore(): GenArtifactStore & { saved: Array<Record<string, unknown>> } {
  const saved: Array<Record<string, unknown>> = [];
  return {
    saved,
    saveArtifact(input): GenDocument {
      saved.push(input as unknown as Record<string, unknown>);
      return { id: 'doc-1', createdAt: 1, ...input };
    },
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

describe('createGenerationService.generateMinutes', () => {
  it('streams minutes over the corpus with the MINUTES_PROMPT system + selected model', async () => {
    let seen: StreamRequest | undefined;
    const service = createGenerationService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory: () =>
        fakeClient((request, onChunk) => {
          seen = request;
          onChunk('<h1>Minutes</h1>');
          return DONE;
        }),
      templates,
      notes: notesWith([note('Decision: ship Friday.')]),
      assets: assetsWith([
        { id: 'a1', sessionId: 's1', kind: 'screenshot', relativePath: 's1/a1.png', createdAt: 1 },
      ]),
      artifacts: artifactStore(),
    });

    const chunks: string[] = [];
    const done = await service.generateMinutes(
      { sessionId: 's1', model: 'claude-opus-4-8' },
      { onChunk: (d) => chunks.push(d) },
    );

    expect(chunks).toEqual(['<h1>Minutes</h1>']);
    expect(done.kind).toBe('minutes');
    expect(seen?.system).toBe(MINUTES_PROMPT);
    expect(seen?.model).toBe('claude-opus-4-8');
    // The corpus (notes + the screenshot image block) is fed to the model.
    const content = seen?.messages[0]?.content ?? [];
    expect(JSON.stringify(content)).toContain('Decision: ship Friday.');
    expect(content.some((b) => b.type === 'image')).toBe(true);
  });

  it("uses the template's minutesPrompt when present (editable minutes), falling back to MINUTES_PROMPT", async () => {
    let seen: StreamRequest | undefined;
    const forked: GenTemplateReader = {
      getTemplate: () => ({
        id: 'fork-1',
        name: 'Fork',
        focusPrompt: 'f',
        whitepaperPrompt: 'w',
        minutesPrompt: 'CUSTOM-MINUTES-SYSTEM',
        isDefault: false,
      }),
    };
    const service = createGenerationService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory: () =>
        fakeClient((request, onChunk) => {
          seen = request;
          onChunk('<h1>M</h1>');
          return DONE;
        }),
      templates: forked,
      notes: notesWith([note('Notes.')]),
      assets: assetsWith(),
      artifacts: artifactStore(),
    });

    await service.generateMinutes(
      { sessionId: 's1', templateId: 'fork-1' },
      { onChunk: () => undefined },
    );

    expect(seen?.system).toBe('CUSTOM-MINUTES-SYSTEM');
  });

  it('persists the streamed minutes as a `minutes` artifact', async () => {
    const artifacts = artifactStore();
    const service = createGenerationService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory: () =>
        fakeClient((_request, onChunk) => {
          onChunk('<h1>M</h1>');
          return DONE;
        }),
      templates,
      notes: notesWith([note('Notes.')]),
      assets: assetsWith(),
      artifacts,
    });

    await service.generateMinutes({ sessionId: 's1' }, { onChunk: () => undefined });

    expect(artifacts.saved).toHaveLength(1);
    // The template that produced the minutes is recorded (for the doc's template chip).
    expect(artifacts.saved[0]).toMatchObject({
      sessionId: 's1',
      kind: 'minutes',
      templateId: 'default',
    });
  });

  it('emits a no-content marker and skips the SDK for an empty session', async () => {
    const clientFactory = vi.fn(() => fakeClient(() => DONE));
    const service = createGenerationService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory,
      templates,
      notes: notesWith([note('   ')]),
      assets: assetsWith([]),
      artifacts: artifactStore(),
    });

    const chunks: string[] = [];
    const done = await service.generateMinutes(
      { sessionId: 's1' },
      { onChunk: (d) => chunks.push(d) },
    );

    expect(clientFactory).not.toHaveBeenCalled();
    expect(chunks).toEqual([NO_CONTENT_GENERATION_MESSAGE]);
    expect(done.stopReason).toBe('no_content');
  });

  it('defaults the minutes model to the generation default (Sonnet 4.6)', async () => {
    let seen: StreamRequest | undefined;
    const service = createGenerationService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory: () =>
        fakeClient((request) => {
          seen = request;
          return DONE;
        }),
      templates,
      notes: notesWith([note('Notes.')]),
      assets: assetsWith(),
      artifacts: artifactStore(),
    });

    await service.generateMinutes({ sessionId: 's1' }, { onChunk: () => undefined });

    expect(seen?.model).toBe(DEFAULT_GENERATION_MODEL);
  });
});

describe('createGenerationService.buildRawDoc', () => {
  it('assembles the saved notes into HTML with NO SDK call and NO key read (mutation-checked)', () => {
    const getKeyForMain = vi.fn(() => KEY);
    const clientFactory = vi.fn(() => fakeClient(() => DONE));
    const service = createGenerationService({
      keyStore: { getKeyForMain },
      clientFactory,
      templates,
      notes: notesWith([note('Kickoff agenda.'), note('Action: send recap.')]),
      assets: assetsWith(),
      artifacts: artifactStore(),
    });

    const html = service.buildRawDoc('s1');

    // Raw mode is the saved-and-searchable path: it spends no tokens.
    expect(clientFactory).not.toHaveBeenCalled();
    expect(getKeyForMain).not.toHaveBeenCalled();
    expect(html).toContain('Kickoff agenda.');
    expect(html).toContain('Action: send recap.');
  });

  it('HTML-escapes note content so raw note text cannot inject markup', () => {
    const service = createGenerationService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory: () => fakeClient(() => DONE),
      templates,
      notes: notesWith([note('<script>alert(1)</script> & <b>bold</b>')]),
      assets: assetsWith(),
      artifacts: artifactStore(),
    });

    const html = service.buildRawDoc('s1');

    expect(html).not.toMatch(/<script>alert/i);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });
});
