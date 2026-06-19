import { describe, expect, it } from 'vitest';

import { createAnthropicClient } from '../../electron/llm/anthropic-client';
import { createCancelRegistry } from '../../electron/llm/cancel-registry';
import { LlmServiceError } from '../../electron/llm/errors';
import type { LlmMessage } from '@shared/types';

/*
 * M07.A — real cancel. Two halves:
 *   (1) the requestId-keyed abort registry the IPC handlers own (register a stream's
 *       abort thunk when it starts, cancel by id, unregister on settle);
 *   (2) the EXTERNAL AbortSignal threaded into streamMessage — the SAME stream.abort()
 *       the watchdog already fires, now reachable by the user, surfacing a typed
 *       CANCELLED (distinct from the TIMEOUT_* tiers). A signal already aborted at
 *       entry must spend NOTHING (the SDK fetch is never invoked).
 */
const MODEL = 'claude-haiku-4-5';
const ENC = new TextEncoder();

function sseEvent(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function prefix(model: string): string {
  return (
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
    }) +
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    })
  );
}

function textDelta(text: string): string {
  return sseEvent('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  });
}

function ping(): string {
  return 'event: ping\ndata: {"type":"ping"}\n\n';
}

// prefix + one real text delta, THEN pings forever (honoring abort). Counts fetch
// invocations so a pre-aborted signal can be proven to spend nothing.
function deltaThenPingFetch(model: string): {
  fetch: typeof globalThis.fetch;
  calls: () => number;
  aborted: () => boolean;
} {
  let calls = 0;
  let signal: AbortSignal | undefined;
  const fetch = ((_url: unknown, init?: { signal?: AbortSignal }) => {
    calls += 1;
    signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(ENC.encode(prefix(model) + textDelta('hi')));
        const tick = (): void => {
          if (signal?.aborted) {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
            return;
          }
          try {
            controller.enqueue(ENC.encode(ping()));
          } catch {
            return;
          }
          setTimeout(tick, 15);
        };
        setTimeout(tick, 15);
      },
    });
    return Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls: () => calls, aborted: () => signal?.aborted ?? false };
}

function textMessage(text: string): LlmMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

describe('createCancelRegistry', () => {
  it('cancel invokes the registered abort thunk and reports a hit', () => {
    const registry = createCancelRegistry();
    let aborted = 0;
    registry.register('r1', () => {
      aborted += 1;
    });

    expect(registry.cancel('r1')).toBe(true);
    expect(aborted).toBe(1);
  });

  it('cancel is idempotent: a second cancel of the same id is a no-op that reports a miss', () => {
    const registry = createCancelRegistry();
    let aborted = 0;
    registry.register('r1', () => {
      aborted += 1;
    });

    expect(registry.cancel('r1')).toBe(true);
    expect(registry.cancel('r1')).toBe(false);
    expect(aborted).toBe(1); // thunk fired exactly once
  });

  it('cancel of an unknown id is a safe no-op (false), never throws', () => {
    const registry = createCancelRegistry();
    expect(registry.cancel('nope')).toBe(false);
  });

  it('unregister removes the entry so a later cancel never fires the thunk', () => {
    const registry = createCancelRegistry();
    let aborted = 0;
    registry.register('r1', () => {
      aborted += 1;
    });
    registry.unregister('r1');

    expect(registry.cancel('r1')).toBe(false);
    expect(aborted).toBe(0);
  });
});

describe('createAnthropicClient.streamMessage — external cancel', () => {
  it('an external abort mid-stream surfaces a typed CANCELLED and tears the request down', async () => {
    const controller = new AbortController();
    const f = deltaThenPingFetch(MODEL);
    const client = createAnthropicClient({
      apiKey: 'sk-ant-fake',
      fetch: f.fetch,
      maxRetries: 0,
      byteIdleMs: 10_000,
      textIdleMs: 10_000,
      ceilingMs: 10_000,
      signal: controller.signal,
    });

    const error = await client
      // abort the moment the first real delta arrives — the user clicking Cancel
      .streamMessage({ model: MODEL, maxTokens: 256, messages: [textMessage('hi')] }, () =>
        controller.abort(),
      )
      .then(() => null)
      .catch((e: unknown) => e);

    expect((error as LlmServiceError).code).toBe('CANCELLED');
    expect(f.aborted()).toBe(true); // the external abort reached the SDK fetch
  }, 5000);

  it('a signal already aborted at entry spends NOTHING — the SDK fetch is never invoked', async () => {
    const controller = new AbortController();
    controller.abort();
    const f = deltaThenPingFetch(MODEL);
    const client = createAnthropicClient({
      apiKey: 'sk-ant-fake',
      fetch: f.fetch,
      maxRetries: 0,
      signal: controller.signal,
    });

    const error = await client
      .streamMessage(
        { model: MODEL, maxTokens: 256, messages: [textMessage('hi')] },
        () => undefined,
      )
      .then(() => null)
      .catch((e: unknown) => e);

    expect((error as LlmServiceError).code).toBe('CANCELLED');
    expect(f.calls()).toBe(0); // no token spend — the request never went out
  });

  it('CANCELLED is distinct from the timeout tiers (a cancel must never read as a timeout)', () => {
    const cancelled = new LlmServiceError('CANCELLED');
    expect(cancelled.message.length).toBeGreaterThan(0);
    expect(cancelled.message).not.toBe(new LlmServiceError('TIMEOUT_CEILING').message);
  });
});
