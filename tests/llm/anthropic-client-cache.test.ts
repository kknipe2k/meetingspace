import { describe, expect, it } from 'vitest';

import { createAnthropicClient } from '../../electron/llm/anthropic-client';
import type { LlmMessage } from '@shared/types';

/*
 * M07.C (amendment carry-in) — prompt-cache annotation for the shared chunked prefix.
 * The domain text block gains an optional `cache` flag; the client maps it to the
 * SDK's `cache_control: {type:"ephemeral"}` INSIDE messages[].content[] — the SDK
 * shape never leaks into shared (same pattern as mediaType → media_type).
 *
 * F29 RE-PROOF: the annotation must NOT change the serialized body's top-level key
 * set — it stays exactly {max_tokens, messages, model, stream, system}. The read-only
 * lock and prompt caching coexist because cache_control is a content-block property,
 * not a capability key.
 */
const KEY = 'sk-ant-api03-THIS-IS-A-FAKE-TEST-KEY-000';
const ALLOWED_BODY_KEYS = ['max_tokens', 'messages', 'model', 'stream', 'system'];

function sseEvent(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function happyStream(model: string): string {
  return [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
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
      delta: { type: 'text_delta', text: 'ok' },
    }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 2 },
    }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join('');
}

function capturingClient(bodies: string[]) {
  const fetch = (async (_url: unknown, init?: { body?: string }) => {
    if (init?.body) {
      bodies.push(init.body);
    }
    return new Response(happyStream('claude-opus-4-8'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as unknown as typeof globalThis.fetch;
  return createAnthropicClient({ apiKey: KEY, fetch, maxRetries: 0 });
}

describe('domain cache flag → cache_control mapping (shared chunked prefix)', () => {
  it('maps `cache: true` on a text block to cache_control on THAT block only', async () => {
    const bodies: string[] = [];
    const client = capturingClient(bodies);

    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'SHARED FOCUS+OUTLINE PREFIX', cache: true },
          { type: 'text', text: 'Varying section brief' },
        ],
      },
    ] as unknown as LlmMessage[];

    await client.streamMessage(
      { model: 'claude-opus-4-8', messages, system: 'SYS', maxTokens: 100 },
      () => undefined,
    );

    expect(bodies).toHaveLength(1);
    const body = JSON.parse(bodies[0] ?? '{}') as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    const [shared, brief] = body.messages[0]?.content ?? [];
    // The shared prefix block carries the breakpoint…
    expect(shared?.cache_control).toEqual({ type: 'ephemeral' });
    // …the varying block after it does NOT (prefix-match caching), and the domain
    // flag itself never leaks onto the wire.
    expect(brief?.cache_control).toBeUndefined();
    expect(shared?.cache).toBeUndefined();
    expect(brief?.cache).toBeUndefined();
  });

  it('F29 re-proof: the annotation leaves the top-level body key set exactly read-only-shaped', async () => {
    const bodies: string[] = [];
    const client = capturingClient(bodies);

    await client.streamMessage(
      {
        model: 'claude-opus-4-8',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'SHARED', cache: true }],
          },
        ] as unknown as LlmMessage[],
        system: 'SYS',
        maxTokens: 100,
      },
      () => undefined,
    );

    const keys = Object.keys(JSON.parse(bodies[0] ?? '{}')).sort();
    expect(keys).toEqual(ALLOWED_BODY_KEYS);
    expect(keys).not.toContain('tools');
    expect(keys).not.toContain('tool_choice');
  });

  it('an unflagged block gets NO cache_control (zero behavior change for existing callers)', async () => {
    const bodies: string[] = [];
    const client = capturingClient(bodies);

    await client.streamMessage(
      {
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'plain' }] }],
        maxTokens: 100,
      },
      () => undefined,
    );

    const body = JSON.parse(bodies[0] ?? '{}') as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    expect(body.messages[0]?.content[0]?.cache_control).toBeUndefined();
  });
});
