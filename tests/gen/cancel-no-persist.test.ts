import { describe, expect, it } from 'vitest';

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
import { FOCUS_PROMPT, SEED_TEMPLATE_ID } from '../../electron/gen/prompt-templates';
import { DEFAULT_GENERATION_MODEL } from '@shared/models';
import type { Asset, GenDocument, GenTemplate, Note } from '@shared/types';

/*
 * M07.A — cancelled work must be FREE (no artifact persisted). The persist guard sits
 * in generation-service before EACH saveArtifact: if the run's signal aborted, the
 * service throws CANCELLED and writes nothing. The one documented keep: a FOCUS
 * artifact persisted BEFORE a later-stage cancel is a valid intermediate — the guard
 * never deletes prior intermediates, it only refuses the save at the cancelled step.
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

function templatesWith(): GenTemplateReader {
  return { getTemplate: (id) => (id === SEED_TEMPLATE_ID ? DEFAULT_TEMPLATE_OBJ : null) };
}

// A stateful store so generateWhitepaper can read back the FOCUS it persisted in Part 1.
function statefulStore(): GenArtifactStore & { saved: GenDocument[] } {
  const saved: GenDocument[] = [];
  return {
    saved,
    saveArtifact(input): GenDocument {
      const doc = { id: `doc-${saved.length + 1}`, createdAt: 1, ...input } as GenDocument;
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

function fakeClient(
  onStream: (request: StreamRequest, onChunk: (delta: string) => void) => StreamResult,
): AnthropicClientLike {
  return { streamMessage: (request, onChunk) => Promise.resolve(onStream(request, onChunk)) };
}

describe('generation cancel — no artifact persists', () => {
  it('a minutes run cancelled during streaming throws CANCELLED and persists ZERO rows', async () => {
    const controller = new AbortController();
    const artifacts = statefulStore();
    const service = createGenerationService({
      keyStore: { getKeyForMain: () => KEY },
      // The stream "completes" but the user cancelled mid-flight (signal aborts before
      // the service reaches its saveArtifact) — the guard must refuse the persist.
      clientFactory: () =>
        fakeClient((_request, onChunk) => {
          onChunk('<html>partial');
          controller.abort();
          return DONE;
        }),
      templates: templatesWith(),
      notes: notesWith(),
      assets: assetsWith(),
      artifacts,
    });

    await expect(
      service.generateMinutes(
        { sessionId: 's1' },
        { onChunk: () => undefined, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(artifacts.saved).toHaveLength(0);
  });

  it('whitepaper cancelled after Part 1 keeps the FOCUS intermediate but writes no whitepaper (M07.C chunked)', async () => {
    const controller = new AbortController();
    const artifacts = statefulStore();
    const service = createGenerationService({
      keyStore: { getKeyForMain: () => KEY },
      // Part 1 (FOCUS system) streams + persists normally; the user cancels during the
      // NEXT chunked step (the outline call) — abort fires there, after FOCUS is saved.
      // The cancelled run must assemble and persist nothing (the FOCUS stays — A's
      // documented intermediate keep).
      clientFactory: () =>
        fakeClient((request, onChunk) => {
          if (request.system === FOCUS_PROMPT) {
            onChunk('FOCUS doc');
          } else {
            onChunk('{');
            controller.abort();
          }
          return DONE;
        }),
      templates: templatesWith(),
      notes: notesWith(),
      assets: assetsWith(),
      artifacts,
    });

    await expect(
      service.generateWhitepaper(
        { sessionId: 's1' },
        { onChunk: () => undefined, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'CANCELLED' });

    // FOCUS kept (a valid intermediate); the cancelled chunked run persisted nothing else.
    expect(artifacts.saved.map((d) => d.kind)).toEqual(['focus']);
  });
});
