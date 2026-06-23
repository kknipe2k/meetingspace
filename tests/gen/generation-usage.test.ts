import { describe, expect, it, vi } from 'vitest';

import type { AnthropicClientLike } from '../../electron/llm/anthropic-client';
import type { CorpusAssetReader, CorpusNoteReader } from '../../electron/gen/corpus';
import {
  createGenerationService,
  type GenArtifactStore,
  type GenTemplateReader,
} from '../../electron/gen/generation-service';
import type { Asset, GenDocument, GenTemplate, Note } from '@shared/types';

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
