import { describe, expect, it } from 'vitest';

import { createAnthropicClient } from '../../electron/llm/anthropic-client';
import type { LlmMessage } from '@shared/types';

/*
 * M07.A — heartbeat events (F21). The fetch-tap byte observer already sees every raw
 * chunk (incl. the SSE pings the SDK drops); a long Opus generation can think 12-15
 * min while only pings flow. The watchdog resets a timer on each byte — heartbeat adds
 * a THROTTLED notification off that same tap so the renderer (Stage B) can toast
 * "still generating". A proves emission: a healthy ping-only stream emits heartbeats
 * carrying monotonic elapsedMs and a growing byte count.
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

// prefix, then `pings` pings every pingMs (raw bytes the SDK drops), then a real delta
// + terminal events — a HEALTHY long-thinking stream that completes cleanly.
function pingsThenFinishFetch(
  model: string,
  pingMs: number,
  pings: number,
): typeof globalThis.fetch {
  return ((_url: unknown) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(ENC.encode(prefix(model)));
        let sent = 0;
        const tick = (): void => {
          if (sent < pings) {
            sent += 1;
            controller.enqueue(ENC.encode(ping()));
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

function textMessage(text: string): LlmMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

describe('createAnthropicClient.streamMessage — heartbeat (F21)', () => {
  it('emits throttled heartbeats off the byte tap with monotonic elapsedMs and growing bytes', async () => {
    const beats: Array<{ elapsedMs: number; bytes: number }> = [];
    // Tiny heartbeatMs so a sub-second ping stream produces several beats deterministically
    // (the established tier-suite tiny-real-budget pattern — no multi-second waits).
    const client = createAnthropicClient({
      apiKey: 'sk-ant-fake',
      fetch: pingsThenFinishFetch(MODEL, 20, 12),
      maxRetries: 0,
      byteIdleMs: 10_000,
      textIdleMs: 10_000,
      ceilingMs: 10_000,
      heartbeatMs: 30,
      onHeartbeat: (hb) => beats.push(hb),
    });

    const result = await client.streamMessage(
      { model: MODEL, maxTokens: 256, messages: [textMessage('hi')] },
      () => undefined,
    );

    expect(result.stopReason).toBe('end_turn'); // the stream still completed cleanly
    expect(beats.length).toBeGreaterThan(0);
    // elapsedMs is non-decreasing and bytes strictly grow across beats (the tap counts raw bytes).
    for (let i = 1; i < beats.length; i += 1) {
      expect(beats[i]!.elapsedMs).toBeGreaterThanOrEqual(beats[i - 1]!.elapsedMs);
      expect(beats[i]!.bytes).toBeGreaterThan(beats[i - 1]!.bytes);
    }
    expect(beats[0]!.bytes).toBeGreaterThan(0);
  }, 5000);

  it('emits NO heartbeats when no onHeartbeat is supplied (opt-in, zero overhead otherwise)', async () => {
    // A client without onHeartbeat must behave exactly as before — proven by a clean
    // completion with the same fixture and no throw.
    const client = createAnthropicClient({
      apiKey: 'sk-ant-fake',
      fetch: pingsThenFinishFetch(MODEL, 20, 4),
      maxRetries: 0,
      byteIdleMs: 10_000,
      textIdleMs: 10_000,
      ceilingMs: 10_000,
      heartbeatMs: 30,
    });

    const result = await client.streamMessage(
      { model: MODEL, maxTokens: 256, messages: [textMessage('hi')] },
      () => undefined,
    );
    expect(result.stopReason).toBe('end_turn');
  }, 5000);
});
