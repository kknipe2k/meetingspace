import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createAnthropicClient,
  DEFAULT_BYTE_IDLE_MS,
  DEFAULT_CEILING_MS,
  DEFAULT_TEXT_IDLE_MS,
} from '../../electron/llm/anthropic-client';
import { LlmServiceError } from '../../electron/llm/errors';
import type { LlmMessage } from '@shared/types';

/*
 * The main-process Anthropic client wrapper (M03.B). Driven by an INJECTED fetch
 * so the real SDK streaming path runs with no live network. Proves: text deltas
 * are forwarded in order, the chosen model crosses the wire, a multimodal (image)
 * content block is accepted, and `dangerouslyAllowBrowser` is never set.
 */
const MODEL = 'claude-haiku-4-5';
const REPO_ROOT = resolve(__dirname, '../..');

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
      delta: { type: 'text_delta', text: 'Hello' },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: ' world' },
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

function recordingFetch(): {
  fetch: typeof globalThis.fetch;
  bodies: string[];
} {
  const bodies: string[] = [];
  const fetch = (async (_url: unknown, init?: { body?: string }) => {
    if (init?.body) {
      bodies.push(init.body);
    }
    return new Response(happyStream(MODEL), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, bodies };
}

describe('createAnthropicClient.streamMessage', () => {
  it('forwards text deltas in order and returns the final usage + stop reason', async () => {
    const { fetch } = recordingFetch();
    const client = createAnthropicClient({ apiKey: 'sk-ant-fake', fetch, maxRetries: 0 });

    const chunks: string[] = [];
    const result = await client.streamMessage(
      { model: MODEL, maxTokens: 256, messages: [textMessage('hi')] },
      (delta) => chunks.push(delta),
    );

    expect(chunks).toEqual(['Hello', ' world']);
    expect(result.stopReason).toBe('end_turn');
    expect(result.model).toBe(MODEL); // the model the API actually answered with
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
  });

  it('passes the chosen model to the API', async () => {
    const { fetch, bodies } = recordingFetch();
    const client = createAnthropicClient({ apiKey: 'sk-ant-fake', fetch, maxRetries: 0 });

    await client.streamMessage(
      { model: MODEL, maxTokens: 256, messages: [textMessage('hi')] },
      () => undefined,
    );

    expect(JSON.parse(firstBody(bodies)).model).toBe(MODEL);
  });

  it('accepts a multimodal message with an image content block (M04-ready path)', async () => {
    const { fetch, bodies } = recordingFetch();
    const client = createAnthropicClient({ apiKey: 'sk-ant-fake', fetch, maxRetries: 0 });

    const imageMessage: LlmMessage = {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'aGVsbG8=' } },
        { type: 'text', text: 'describe' },
      ],
    };

    await expect(
      client.streamMessage(
        { model: MODEL, maxTokens: 256, messages: [imageMessage] },
        () => undefined,
      ),
    ).resolves.toBeDefined();

    // The SDK wire shape uses snake_case media_type — proves the mapping ran.
    const sent = JSON.parse(firstBody(bodies));
    expect(sent.messages[0].content[0].source.media_type).toBe('image/png');
  });

  it('wraps the grounding system prefix with ephemeral prompt caching (−90% cached input)', async () => {
    const { fetch, bodies } = recordingFetch();
    const client = createAnthropicClient({ apiKey: 'sk-ant-fake', fetch, maxRetries: 0 });

    await client.streamMessage(
      {
        model: MODEL,
        maxTokens: 256,
        messages: [textMessage('hi')],
        system: 'Answer using only this session.',
      },
      () => undefined,
    );

    // The system prefix crosses the wire as a cacheable text block — so a stable
    // grounding prefix is billed at cache-read rates on repeat turns (M03.C).
    const sent = JSON.parse(firstBody(bodies));
    expect(sent.system).toEqual([
      {
        type: 'text',
        text: 'Answer using only this session.',
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });

  it('never enables dangerouslyAllowBrowser (the SDK is main-process only)', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'electron/llm/anthropic-client.ts'), 'utf8');
    expect(source).not.toContain('dangerouslyAllowBrowser');
  });
});

/*
 * D-01 — the ping-aware THREE-TIER streaming watchdog (replaces the M04.C cycle-2
 * text-delta stall). Opus thinks silently 60-120s between text deltas while SSE pings
 * (~15-30s) flow, but the SDK drops pings — so a text-delta stall false-aborts every
 * long generation, and a 120s ceiling can't fit a ~7-min white paper. The fix taps the
 * RAW fetch response body (every byte, incl. pings) and runs three tiers, each ->
 * typed TIMEOUT via stream.abort():
 *   - byte-idle  : no bytes at all = dead connection (reset on every raw byte chunk);
 *   - text-idle  : pings flowing but zero text = wedged (reset on every text delta);
 *   - ceiling    : total wall-clock backstop (never reset).
 * Driven by an injected fetch returning a real ReadableStream, with tiny budgets.
 */
const ENC = new TextEncoder();

function ssePrefix(model: string): string {
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

// A keep-alive SSE ping — raw bytes the SDK drops (no parsed event), exactly the
// real-world gap that false-aborted a text-delta stall.
function pingBytes(): string {
  return 'event: ping\ndata: {"type":"ping"}\n\n';
}

function suffix(text: string): string {
  return (
    textDelta(text) +
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    }) +
    sseEvent('message_stop', { type: 'message_stop' })
  );
}

interface CapturingFetch {
  fetch: typeof globalThis.fetch;
  aborted: () => boolean;
}

// prefix, then a PING every pingMs forever — raw bytes keep flowing but NO text delta.
function pingingFetch(model: string, pingMs: number): CapturingFetch {
  let signal: AbortSignal | undefined;
  const fetch = ((_url: unknown, init?: { signal?: AbortSignal }) => {
    signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(ENC.encode(ssePrefix(model)));
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
            controller.enqueue(ENC.encode(pingBytes()));
          } catch {
            return;
          }
          setTimeout(tick, pingMs);
        };
        setTimeout(tick, pingMs);
      },
    });
    return Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
  }) as unknown as typeof globalThis.fetch;
  return { fetch, aborted: () => signal?.aborted ?? false };
}

// prefix, then SILENCE forever — no bytes at all after the prefix (dead connection).
function silentAfterPrefixFetch(model: string): CapturingFetch {
  let signal: AbortSignal | undefined;
  const fetch = ((_url: unknown, init?: { signal?: AbortSignal }) => {
    signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(ENC.encode(ssePrefix(model)));
        signal?.addEventListener('abort', () => {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
      },
    });
    return Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
  }) as unknown as typeof globalThis.fetch;
  return { fetch, aborted: () => signal?.aborted ?? false };
}

// prefix, `pings` pings every pingMs (a long ping-only gap), THEN a real text delta +
// terminal events + close — a HEALTHY long-thinking response.
function pingsThenFinishFetch(
  model: string,
  pingMs: number,
  pings: number,
): typeof globalThis.fetch {
  return ((_url: unknown) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(ENC.encode(ssePrefix(model)));
        let sent = 0;
        const tick = (): void => {
          if (sent < pings) {
            sent += 1;
            controller.enqueue(ENC.encode(pingBytes()));
            setTimeout(tick, pingMs);
            return;
          }
          controller.enqueue(ENC.encode(suffix('done')));
          controller.close();
        };
        setTimeout(tick, pingMs);
      },
    });
    return Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
  }) as unknown as typeof globalThis.fetch;
}

// prefix, then a text delta every dripMs forever — keeps RESETTING the text-idle timer.
function drippingFetch(model: string, dripMs: number): typeof globalThis.fetch {
  return ((_url: unknown, init?: { signal?: AbortSignal }) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(ENC.encode(ssePrefix(model)));
        const tick = (): void => {
          if (init?.signal?.aborted) {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
            return;
          }
          try {
            controller.enqueue(ENC.encode(textDelta('x')));
          } catch {
            return;
          }
          setTimeout(tick, dripMs);
        };
        setTimeout(tick, dripMs);
      },
    });
    return Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
  }) as unknown as typeof globalThis.fetch;
}

async function streamError(
  client: ReturnType<typeof createAnthropicClient>,
  onChunk: (d: string) => void,
): Promise<unknown> {
  return client
    .streamMessage({ model: MODEL, maxTokens: 256, messages: [textMessage('hi')] }, onChunk)
    .then(() => null)
    .catch((e: unknown) => e);
}

describe('createAnthropicClient.streamMessage — ping-aware tier watchdog (D-01)', () => {
  it('exposes the default tier budgets: byte-idle 120s, text-idle 300s, ceiling 1200s (M07.A)', () => {
    expect(DEFAULT_BYTE_IDLE_MS).toBe(120_000);
    expect(DEFAULT_TEXT_IDLE_MS).toBe(300_000);
    // M07.A: the generation ceiling rises 600s -> 1200s so a long Opus white paper fits
    // (chat keeps its own tighter 120s ceiling, set in llm-service).
    expect(DEFAULT_CEILING_MS).toBe(1_200_000);
  });

  it('pings keep the byte-idle timer alive — a long ping-only gap does NOT byte-idle-abort', async () => {
    // ~160ms of pings (>> byteIdleMs) then a real text delta: a healthy long-think.
    const client = createAnthropicClient({
      apiKey: 'sk-ant-fake',
      fetch: pingsThenFinishFetch(MODEL, 20, 8),
      maxRetries: 0,
      byteIdleMs: 70, // would fire mid-pings IF pings didn't reset it
      textIdleMs: 10_000,
      ceilingMs: 10_000,
    });
    const chunks: string[] = [];
    const result = await client.streamMessage(
      { model: MODEL, maxTokens: 256, messages: [textMessage('hi')] },
      (d) => chunks.push(d),
    );
    expect(chunks).toEqual(['done']); // pings reset byte-idle; the stream completed
    expect(result.stopReason).toBe('end_turn');
  }, 5000);

  it('no bytes at all past byte-idle -> typed TIMEOUT_IDLE, and the request is aborted (branch B torn down)', async () => {
    const f = silentAfterPrefixFetch(MODEL);
    const client = createAnthropicClient({
      apiKey: 'sk-ant-fake',
      fetch: f.fetch,
      maxRetries: 0,
      byteIdleMs: 70,
      textIdleMs: 10_000,
      ceilingMs: 10_000,
    });
    const error = await streamError(client, () => undefined);

    // M07.A: byte-idle (dead connection) gets its OWN code, distinct from a wedged
    // generation or the ceiling, so the renderer can phrase per-tier copy.
    expect((error as LlmServiceError).code).toBe('TIMEOUT_IDLE');
    expect(f.aborted()).toBe(true); // abort propagated to the fetch -> tee source errors -> branch B ends
  }, 5000);

  it('pings flowing but ZERO text past text-idle -> typed TIMEOUT_STALL (wedged)', async () => {
    const f = pingingFetch(MODEL, 20);
    const client = createAnthropicClient({
      apiKey: 'sk-ant-fake',
      fetch: f.fetch,
      maxRetries: 0,
      byteIdleMs: 10_000, // large — pings keep it alive, so text-idle must be what fires
      textIdleMs: 70,
      ceilingMs: 10_000,
    });
    const error = await streamError(client, () => undefined);

    // M07.A: text-idle (wedged generation — pings flow, no text) is its own tier code.
    expect((error as LlmServiceError).code).toBe('TIMEOUT_STALL');
    expect(f.aborted()).toBe(true);
  }, 5000);

  it('enforces a total wall-clock CEILING even while text keeps dripping', async () => {
    const client = createAnthropicClient({
      apiKey: 'sk-ant-fake',
      fetch: drippingFetch(MODEL, 10),
      maxRetries: 0,
      byteIdleMs: 5_000,
      textIdleMs: 5_000,
      ceilingMs: 90,
    });
    const chunks: string[] = [];
    const error = await streamError(client, (d) => chunks.push(d));

    // M07.A: the hard wall-clock cap is its own tier code (distinct from the idle tiers).
    expect((error as LlmServiceError).code).toBe('TIMEOUT_CEILING');
    expect(chunks.length).toBeGreaterThan(0); // the cap is total time, not inactivity
  }, 5000);

  it('a clean stream completes — no tier fires on a healthy response', async () => {
    const { fetch } = recordingFetch();
    const client = createAnthropicClient({
      apiKey: 'sk-ant-fake',
      fetch,
      maxRetries: 0,
      byteIdleMs: 50,
      textIdleMs: 50,
      ceilingMs: 50, // tiny, but a healthy stream finishes ~1ms — must NOT abort it
    });
    const chunks: string[] = [];
    const result = await client.streamMessage(
      { model: MODEL, maxTokens: 256, messages: [textMessage('hi')] },
      (d) => chunks.push(d),
    );
    expect(chunks).toEqual(['Hello', ' world']);
    expect(result.stopReason).toBe('end_turn');
  });

  it('the fetch-body TEE forwards every chunk to the SDK intact — incl. the final message_stop (real stream, not fake timers)', async () => {
    // A full SSE byte stream through the tap: the SDK must still parse all deltas AND
    // the terminal events (the tee must not drop the last chunk or starve a branch).
    const { fetch } = recordingFetch();
    const client = createAnthropicClient({ apiKey: 'sk-ant-fake', fetch, maxRetries: 0 });
    const chunks: string[] = [];
    const result = await client.streamMessage(
      { model: MODEL, maxTokens: 256, messages: [textMessage('hi')] },
      (d) => chunks.push(d),
    );
    expect(chunks.join('')).toBe('Hello world');
    expect(result.stopReason).toBe('end_turn'); // message_delta survived the tee
    expect(result.usage.outputTokens).toBe(5); // final usage survived the tee
  });
});

function textMessage(text: string): LlmMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function firstBody(bodies: string[]): string {
  const body = bodies[0];
  if (body === undefined) {
    throw new Error('no request body was captured by the fake fetch');
  }
  return body;
}
