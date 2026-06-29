import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AnthropicClientLike, StreamRequest } from '../../electron/llm/anthropic-client';
import type { CorpusAssetReader, CorpusNoteReader } from '../../electron/gen/corpus';
import {
  createGenerationService,
  type GenArtifactStore,
  type GenTemplateReader,
} from '../../electron/gen/generation-service';
import { LlmServiceError } from '../../electron/llm/errors';
import { DEFAULT_GENERATION_MODEL } from '@shared/models';
import type { Asset, GenDocument, GenTemplate, Note } from '@shared/types';

/*
 * Independent audit 2026-06-17 — two main-side hardening pins on the generation service.
 *
 * S3-001: the renderer-supplied `model` was type-checked but never validated against the catalog,
 *   contradicting the design's "value-checked main-side" assertion. An unknown/forged id reached the
 *   SDK `model` field verbatim. The service must DEFAULT an unknown model to DEFAULT_GENERATION_MODEL
 *   (a known model still flows through). Mutation-verified: drop the validation and the forged id
 *   reaches the SDK request.
 *
 * S4-001: the white-paper structure-rejection diagnostic logged `bodyHead=<200 chars of generated
 *   HTML>` to main.log (teed console). main.log is a user-openable, shareable §10 surface and the
 *   redactor only strips credential-shaped tokens — so meeting-derived content leaked. The line must
 *   keep the marker/model/stopReason/attempt fields and DROP the body content. Mutation-verified:
 *   restore bodyHead and the sentinel reappears in the logged line.
 */
const KEY = 'sk-ant-api03-THIS-IS-A-FAKE-TEST-KEY-000';

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

// ----- S3-001: model validation on the FOCUS leg (one SDK call; the resolved model is captured) ---

const FOCUS_TEMPLATE: GenTemplate = {
  id: 'tmpl-focus',
  name: 'Focus',
  focusPrompt: 'FOCUS-SYS',
  whitepaperPrompt: 'MANDATE',
  isDefault: false,
};

function recordingClient(): { client: AnthropicClientLike; seen: StreamRequest[] } {
  const seen: StreamRequest[] = [];
  const client: AnthropicClientLike = {
    streamMessage(request, onChunk) {
      seen.push(request);
      onChunk('FOCUS doc');
      return Promise.resolve({
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 2 },
        model: request.model,
      });
    },
  };
  return { client, seen };
}

function focusService(client: AnthropicClientLike, artifacts: GenArtifactStore) {
  return createGenerationService({
    keyStore: { getKeyForMain: () => KEY },
    clientFactory: () => client,
    templates: { getTemplate: (id) => (id === FOCUS_TEMPLATE.id ? FOCUS_TEMPLATE : null) },
    notes: notesWith(),
    assets: assetsWith(),
    artifacts,
  });
}

describe('S3-001 — generation validates the renderer-supplied model main-side', () => {
  it('DEFAULTS an unknown/forged model id to the generation default before the SDK call', async () => {
    const { client, seen } = recordingClient();
    const artifacts = statefulStore();
    const service = focusService(client, artifacts);

    await service.generateFocus(
      { sessionId: 's1', templateId: FOCUS_TEMPLATE.id, model: 'forged-evil-model-xyz' },
      { onChunk: () => undefined },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.model).toBe(DEFAULT_GENERATION_MODEL);
    expect(seen[0]?.model).not.toBe('forged-evil-model-xyz');
  });

  it('passes a KNOWN catalog model through unchanged', async () => {
    const { client, seen } = recordingClient();
    const artifacts = statefulStore();
    const service = focusService(client, artifacts);

    await service.generateFocus(
      { sessionId: 's1', templateId: FOCUS_TEMPLATE.id, model: 'claude-opus-4-8' },
      { onChunk: () => undefined },
    );

    expect(seen[0]?.model).toBe('claude-opus-4-8');
  });

  it('uses the default when no model is supplied (unchanged behavior)', async () => {
    const { client, seen } = recordingClient();
    const service = focusService(client, statefulStore());

    await service.generateFocus(
      { sessionId: 's1', templateId: FOCUS_TEMPLATE.id },
      { onChunk: () => undefined },
    );

    expect(seen[0]?.model).toBe(DEFAULT_GENERATION_MODEL);
  });
});

// ----- S4-001: the structure-rejection diagnostic must not log generated body content ------------

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
  illustrations: [],
  palette: 'light',
  typography: 'serif',
});
const GOOD_CSS = ':root{--x:1}';
const SECRET = 'CONFIDENTIAL_MEETING_LEAK_9f2a';
// A body that trips fragmentViolation (it carries a <style> shell marker) AND embeds the sentinel.
const SHELL_BODY = `<style>.x{color:red}</style><h2>${SECRET}</h2>`;

function templatesWith(): GenTemplateReader {
  return { getTemplate: (id) => (id === CHUNK_TEMPLATE.id ? CHUNK_TEMPLATE : null) };
}

function rejectingClient(): AnthropicClientLike {
  const htmlQueue = [SHELL_BODY, SHELL_BODY]; // both attempts violate → run fails typed
  return {
    streamMessage(request, onChunk) {
      const sys = request.system ?? '';
      const ok = (text: string) => {
        onChunk(text);
        return Promise.resolve({
          stopReason: 'end_turn' as const,
          usage: { inputTokens: 1, outputTokens: 2 },
          model: 'm',
        });
      };
      if (sys.includes('FOCUS-SYS')) return ok('FOCUS');
      if (sys.includes('PLAN-SYS')) return ok(PLAN_JSON);
      if (sys.includes('CSS-SYS')) return ok(GOOD_CSS);
      if (sys.includes('HTML-SYS')) return ok(htmlQueue.shift() ?? SHELL_BODY);
      return Promise.reject(new Error(`unexpected system: ${sys.slice(0, 20)}`));
    },
  };
}

describe('S4-001 — structure-rejection diagnostic never logs generated body content', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs the marker/attempt fields but NOT the meeting-derived HTML body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = createGenerationService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory: () => rejectingClient(),
      templates: templatesWith(),
      notes: notesWith(),
      assets: assetsWith(),
      artifacts: statefulStore(),
    });

    await expect(
      service.generateWhitepaper(
        { sessionId: 's1', templateId: CHUNK_TEMPLATE.id },
        { onChunk: () => undefined },
      ),
    ).rejects.toBeInstanceOf(LlmServiceError);

    const allLogged = warn.mock.calls.flat().map(String).join('\n');
    // The diagnostic still ran and kept its non-sensitive fields…
    expect(allLogged).toContain('[gen:whitepaper]');
    expect(allLogged).toContain('marker=');
    expect(allLogged).toContain('attempt=');
    // …but the generated body content (derived from meeting notes) must NEVER reach the log.
    expect(allLogged).not.toContain(SECRET);
    expect(allLogged).not.toContain('bodyHead');
  });
});
