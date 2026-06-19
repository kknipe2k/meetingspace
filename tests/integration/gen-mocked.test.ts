import { describe, expect, it } from 'vitest';

import { createGenerationService } from '../../electron/gen/generation-service';
import { DEFAULT_TEMPLATE } from '../../electron/gen/prompt-templates';
import { createAnthropicClient } from '../../electron/llm/anthropic-client';
import { LlmServiceError } from '../../electron/llm/errors';
import { DEFAULT_GENERATION_MODEL } from '@shared/models';
import type { GenDocument } from '@shared/types';

/*
 * The M04 generation integration gate (run via `npm run test:integration`).
 * Drives the REAL Anthropic SDK through the generation service with an INJECTED
 * fetch — no live network, no real key. Proves the happy streaming path (Part 1)
 * and the mapped, key-free error taxonomy reused from M03 (401→AUTH, 429→
 * RATE_LIMIT, network→OFFLINE).
 */
function sseEvent(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function happyStream(): string {
  return [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: DEFAULT_GENERATION_MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 9, output_tokens: 0 },
      },
    }),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'A: Analysis' },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: ' — done.' },
    }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join('');
}

function serviceWith(fetchImpl: typeof globalThis.fetch) {
  const saved: GenDocument[] = [];
  const service = createGenerationService({
    keyStore: { getKeyForMain: () => 'sk-ant-fake' },
    clientFactory: (opts) =>
      createAnthropicClient({ apiKey: opts.apiKey, fetch: fetchImpl, maxRetries: 0 }),
    templates: { getTemplate: () => DEFAULT_TEMPLATE },
    notes: {
      listNotes: () => [
        { id: 'n1', sessionId: 's1', content: 'We shipped.', createdAt: 1, updatedAt: 1 },
      ],
    },
    assets: { listAssets: () => [], readImage: () => null },
    artifacts: {
      saveArtifact: (input) => {
        const doc: GenDocument = { id: 'doc-1', createdAt: 1, ...input };
        saved.push(doc);
        return doc;
      },
      getLatestArtifact: (sessionId, kind) => {
        const matches = saved.filter((d) => d.sessionId === sessionId && d.kind === kind);
        return matches.length > 0 ? (matches[matches.length - 1] as GenDocument) : null;
      },
    },
  });
  return { service, saved };
}

function jsonErrorFetch(status: number, errorType: string): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify({ type: 'error', error: { type: errorType, message: 'x' } }), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
}

describe('generation service over the real SDK with a mocked endpoint', () => {
  it('streams Part 1 chunks, resolves, and persists the FOCUS artifact (no live network)', async () => {
    const okFetch = (async () =>
      new Response(happyStream(), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof globalThis.fetch;
    const { service, saved } = serviceWith(okFetch);

    const chunks: string[] = [];
    const done = await service.generateFocus(
      { sessionId: 's1' },
      { onChunk: (d) => chunks.push(d) },
    );

    expect(chunks).toEqual(['A: Analysis', ' — done.']);
    expect(done.kind).toBe('focus');
    expect(done.stopReason).toBe('end_turn');
    expect(saved).toHaveLength(1);
    expect(saved[0]?.content).toBe('A: Analysis — done.');
  });

  it('maps 401 to a key-free AUTH error', async () => {
    const { service } = serviceWith(jsonErrorFetch(401, 'authentication_error'));
    await expect(
      service.generateFocus({ sessionId: 's1' }, { onChunk: () => undefined }),
    ).rejects.toMatchObject({ code: 'AUTH' });
  });

  it('maps 429 to RATE_LIMIT', async () => {
    const { service } = serviceWith(jsonErrorFetch(429, 'rate_limit_error'));
    await expect(
      service.generateFocus({ sessionId: 's1' }, { onChunk: () => undefined }),
    ).rejects.toMatchObject({ code: 'RATE_LIMIT' });
  });

  it('maps a network failure to OFFLINE', async () => {
    const throwingFetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    const { service } = serviceWith(throwingFetch);

    const error = await service
      .generateFocus({ sessionId: 's1' }, { onChunk: () => undefined })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LlmServiceError);
    expect((error as LlmServiceError).code).toBe('OFFLINE');
  });
});
