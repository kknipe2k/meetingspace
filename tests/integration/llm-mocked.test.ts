import { describe, expect, it } from 'vitest';

import { createAnthropicClient } from '../../electron/llm/anthropic-client';
import { LlmServiceError } from '../../electron/llm/errors';
import { createLlmService } from '../../electron/llm/llm-service';
import type { LlmChatRequest } from '@shared/types';

/*
 * The M03 "Integration tests" hard gate (docs/gates.md), run by
 * `npm run test:integration`. Drives the REAL Anthropic SDK through the LLM
 * service with an INJECTED fetch — no live network, no real key. Proves the
 * mapped, key-free error taxonomy (401→AUTH, 429→RATE_LIMIT, network→OFFLINE)
 * and the happy streaming path end to end.
 */
const REQUEST: LlmChatRequest = {
  sessionId: 's1',
  question: 'Summarize the notes.',
  model: 'claude-haiku-4-5',
};

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
        model: REQUEST.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 7, output_tokens: 0 },
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
      delta: { type: 'text_delta', text: 'Decisions' },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: ': ship.' },
    }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 4 },
    }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join('');
}

function serviceWith(fetchImpl: typeof globalThis.fetch, calls?: { n: number }) {
  const fetchSpy = (async (url: unknown, init?: unknown) => {
    if (calls) {
      calls.n += 1;
    }
    return fetchImpl(url as never, init as never);
  }) as unknown as typeof globalThis.fetch;
  return createLlmService({
    keyStore: { getKeyForMain: () => 'sk-ant-fake' },
    clientFactory: (opts) =>
      createAnthropicClient({ apiKey: opts.apiKey, fetch: fetchSpy, maxRetries: 0 }),
    // A content-bearing session so grounding is non-empty and the SDK path runs
    // (the empty-session short-circuit is unit-covered in llm-service.test.ts).
    notes: {
      listNotes: () => [
        {
          id: 'n1',
          sessionId: REQUEST.sessionId,
          content: 'We shipped.',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    },
  });
}

function jsonErrorFetch(status: number, errorType: string): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify({ type: 'error', error: { type: errorType, message: 'x' } }), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
}

describe('LLM service over the real SDK with a mocked endpoint', () => {
  it('streams chunks then resolves on the happy path (no live network)', async () => {
    const calls = { n: 0 };
    const okFetch = (async () =>
      new Response(happyStream(), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof globalThis.fetch;
    const service = serviceWith(okFetch, calls);

    const chunks: string[] = [];
    const done = await service.streamChat(REQUEST, { onChunk: (d) => chunks.push(d) });

    expect(chunks).toEqual(['Decisions', ': ship.']);
    expect(done.stopReason).toBe('end_turn');
    expect(calls.n).toBeGreaterThan(0);
  });

  it('maps 401 to a key-free AUTH error', async () => {
    const service = serviceWith(jsonErrorFetch(401, 'authentication_error'));
    await expect(service.streamChat(REQUEST, { onChunk: () => undefined })).rejects.toMatchObject({
      code: 'AUTH',
    });
  });

  it('maps 429 to RATE_LIMIT', async () => {
    const service = serviceWith(jsonErrorFetch(429, 'rate_limit_error'));
    await expect(service.streamChat(REQUEST, { onChunk: () => undefined })).rejects.toMatchObject({
      code: 'RATE_LIMIT',
    });
  });

  it('maps 529 to OVERLOADED', async () => {
    const service = serviceWith(jsonErrorFetch(529, 'overloaded_error'));
    await expect(service.streamChat(REQUEST, { onChunk: () => undefined })).rejects.toMatchObject({
      code: 'OVERLOADED',
    });
  });

  it('maps a network failure to OFFLINE', async () => {
    const throwingFetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    const service = serviceWith(throwingFetch);

    const error = await service
      .streamChat(REQUEST, { onChunk: () => undefined })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LlmServiceError);
    expect((error as LlmServiceError).code).toBe('OFFLINE');
  });
});
