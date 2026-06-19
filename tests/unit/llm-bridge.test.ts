import { describe, expect, it } from 'vitest';

import { LLM_CHANNELS } from '../../electron/ipc/channels';
import { createLlmApi, type IpcStreamTransport } from '../../electron/ipc/llm-bridge';
import type { LlmDone, LlmErrorPayload } from '@shared/types';

/*
 * The renderer-facing streaming bridge (M03.B). `chat` invokes llm:chat with the
 * request plus a generated requestId, subscribes to chunk/done/error events
 * FILTERED by that requestId, and returns an unsubscribe (renderer-local listener
 * teardown only — the IPC-level cancel channel is deferred to Stage C/D). No key
 * ever crosses; the request carries only {sessionId, question, model}.
 */
function fakeTransport(): {
  transport: IpcStreamTransport;
  invokes: Array<{ channel: string; args: unknown[] }>;
  emit: (channel: string, payload: unknown) => void;
  listenerCount: (channel: string) => number;
} {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const invokes: Array<{ channel: string; args: unknown[] }> = [];
  return {
    invokes,
    emit: (channel, payload) => listeners.get(channel)?.forEach((listener) => listener(payload)),
    listenerCount: (channel) => listeners.get(channel)?.size ?? 0,
    transport: {
      invoke: (channel, ...args) => {
        invokes.push({ channel, args });
        return Promise.resolve(undefined);
      },
      on: (channel, listener) => {
        let set = listeners.get(channel);
        if (!set) {
          set = new Set();
          listeners.set(channel, set);
        }
        set.add(listener);
        return () => set?.delete(listener);
      },
    },
  };
}

function sequentialIds(): () => string {
  let n = 0;
  return () => `req-${(n += 1)}`;
}

const REQUEST = { sessionId: 's1', question: 'hi', model: 'claude-haiku-4-5' };
const DONE: LlmDone = { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 2 } };

describe('createLlmApi', () => {
  it('exposes exactly the chat + history methods', () => {
    const { transport } = fakeTransport();
    expect(Object.keys(createLlmApi(transport, sequentialIds())).sort()).toEqual([
      'chat',
      'history',
    ]);
  });

  it('invokes llm:chat with the request plus a generated requestId (and no key)', () => {
    const f = fakeTransport();
    createLlmApi(f.transport, sequentialIds()).chat(REQUEST, {
      onChunk: () => undefined,
      onDone: () => undefined,
      onError: () => undefined,
    });

    expect(f.invokes).toEqual([
      { channel: LLM_CHANNELS.chat, args: [{ ...REQUEST, requestId: 'req-1' }] },
    ]);
    expect(JSON.stringify(f.invokes)).not.toContain('apiKey');
  });

  it('routes only events matching its own requestId to the callbacks', () => {
    const f = fakeTransport();
    const chunks: string[] = [];
    createLlmApi(f.transport, sequentialIds()).chat(REQUEST, {
      onChunk: (d) => chunks.push(d),
      onDone: () => undefined,
      onError: () => undefined,
    });

    f.emit(LLM_CHANNELS.chunk, { requestId: 'other', delta: 'X' });
    f.emit(LLM_CHANNELS.chunk, { requestId: 'req-1', delta: 'a' });
    f.emit(LLM_CHANNELS.chunk, { requestId: 'req-1', delta: 'b' });

    expect(chunks).toEqual(['a', 'b']);
  });

  it('finalizes on done and tears down its listeners', () => {
    const f = fakeTransport();
    let result: LlmDone | undefined;
    const chunksAfter: string[] = [];
    createLlmApi(f.transport, sequentialIds()).chat(REQUEST, {
      onChunk: (d) => chunksAfter.push(d),
      onDone: (r) => (result = r),
      onError: () => undefined,
    });

    f.emit(LLM_CHANNELS.done, { requestId: 'req-1', result: DONE });
    // After done, the bridge has unsubscribed — a late chunk is ignored.
    f.emit(LLM_CHANNELS.chunk, { requestId: 'req-1', delta: 'late' });

    expect(result).toEqual(DONE);
    expect(chunksAfter).toEqual([]);
    expect(f.listenerCount(LLM_CHANNELS.chunk)).toBe(0);
    expect(f.listenerCount(LLM_CHANNELS.done)).toBe(0);
    expect(f.listenerCount(LLM_CHANNELS.error)).toBe(0);
  });

  it('routes an error payload to onError and tears down', () => {
    const f = fakeTransport();
    let error: LlmErrorPayload | undefined;
    createLlmApi(f.transport, sequentialIds()).chat(REQUEST, {
      onChunk: () => undefined,
      onDone: () => undefined,
      onError: (e) => (error = e),
    });

    f.emit(LLM_CHANNELS.error, {
      requestId: 'req-1',
      error: { code: 'RATE_LIMIT', message: 'slow' },
    });

    expect(error).toEqual({ code: 'RATE_LIMIT', message: 'slow' });
    expect(f.listenerCount(LLM_CHANNELS.error)).toBe(0);
  });

  it('the returned unsubscribe removes the listeners (renderer-local teardown)', () => {
    const f = fakeTransport();
    const cancel = createLlmApi(f.transport, sequentialIds()).chat(REQUEST, {
      onChunk: () => undefined,
      onDone: () => undefined,
      onError: () => undefined,
    });

    expect(f.listenerCount(LLM_CHANNELS.chunk)).toBe(1);
    cancel();
    expect(f.listenerCount(LLM_CHANNELS.chunk)).toBe(0);
  });
});
