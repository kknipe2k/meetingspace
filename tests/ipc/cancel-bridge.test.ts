import { describe, expect, it } from 'vitest';

import { GEN_CHANNELS, LLM_CHANNELS } from '../../electron/ipc/channels';
import { createGenApi } from '../../electron/ipc/gen-bridge';
import { createLlmApi, type IpcStreamTransport } from '../../electron/ipc/llm-bridge';

/*
 * M07.A — the renderer cancel path (F11's three repro routes: Cancel button, modal
 * close, session switch all run the returned teardown). The unsubscribe a bridge
 * returns now ALSO invokes {llm,gen}:cancel for its requestId — so tearing down the
 * renderer listeners genuinely stops the main-side stream. The internal teardown that
 * runs on a normal done/error must NOT fire cancel (the stream already settled).
 */
interface RecordingTransport extends IpcStreamTransport {
  invoked: Array<{ channel: string; args: unknown[] }>;
  emit(channel: string, payload: unknown): void;
}

function recordingTransport(): RecordingTransport {
  const invoked: Array<{ channel: string; args: unknown[] }> = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    invoked,
    invoke(channel, ...args) {
      invoked.push({ channel, args });
      return Promise.resolve(undefined);
    },
    on(channel, listener) {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
      return () => set.delete(listener);
    },
    emit(channel, payload) {
      for (const listener of listeners.get(channel) ?? []) {
        listener(payload);
      }
    },
  };
}

const CHAT_REQUEST = { sessionId: 's1', question: 'hi', model: 'claude-haiku-4-5' };
const noopCallbacks = {
  onChunk: () => undefined,
  onDone: () => undefined,
  onError: () => undefined,
};

describe('llm bridge — returned teardown fires cancel', () => {
  it('invokes llm:cancel with the requestId when the caller tears the stream down mid-flight', () => {
    const transport = recordingTransport();
    const api = createLlmApi(transport, () => 'r1');

    const teardown = api.chat(CHAT_REQUEST, noopCallbacks);
    teardown();

    expect(transport.invoked).toContainEqual({
      channel: LLM_CHANNELS.cancel,
      args: [{ requestId: 'r1' }],
    });
  });

  it('does NOT fire cancel when the stream settles normally (done already arrived)', () => {
    const transport = recordingTransport();
    const api = createLlmApi(transport, () => 'r1');

    api.chat(CHAT_REQUEST, noopCallbacks);
    transport.emit(LLM_CHANNELS.done, {
      requestId: 'r1',
      result: { stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } },
    });

    expect(transport.invoked.some((i) => i.channel === LLM_CHANNELS.cancel)).toBe(false);
  });

  it('cancel after settle is a no-op (the teardown is guarded — no duplicate cancel)', () => {
    const transport = recordingTransport();
    const api = createLlmApi(transport, () => 'r1');

    const teardown = api.chat(CHAT_REQUEST, noopCallbacks);
    transport.emit(LLM_CHANNELS.done, {
      requestId: 'r1',
      result: { stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } },
    });
    teardown(); // user closes the modal after it already finished

    expect(transport.invoked.some((i) => i.channel === LLM_CHANNELS.cancel)).toBe(false);
  });
});

describe('gen bridge — returned teardown fires cancel', () => {
  it('invokes gen:cancel with the requestId when the caller tears the generation down mid-flight', () => {
    const transport = recordingTransport();
    const api = createGenApi(transport, () => 'g1');

    const handle = api.generateWhitepaper({ sessionId: 's1' }, noopCallbacks);
    handle.cancel();

    expect(transport.invoked).toContainEqual({
      channel: GEN_CHANNELS.cancel,
      args: [{ requestId: 'g1' }],
    });
  });

  it('does NOT fire cancel when the generation settles normally', () => {
    const transport = recordingTransport();
    const api = createGenApi(transport, () => 'g1');

    const handle = api.generateWhitepaper({ sessionId: 's1' }, noopCallbacks);
    transport.emit(GEN_CHANNELS.done, {
      requestId: 'g1',
      result: {
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0 },
        kind: 'whitepaper',
      },
    });
    handle.cancel(); // a post-settle cancel is a guarded no-op

    expect(transport.invoked.some((i) => i.channel === GEN_CHANNELS.cancel)).toBe(false);
  });
});

/*
 * M07.B (REVIEW-V11 F12/F14) — generation DECOUPLES from the modal. The gen streaming
 * methods return a {detach, cancel} handle instead of a single teardown:
 *   - detach() stops the renderer listening but leaves the main-side run ALIVE (the
 *     modal can close and the run keeps going — reattach on reopen);
 *   - cancel() detaches AND fires gen:cancel (the explicit-stop spend guard).
 * `attach(requestId, …)` re-subscribes to an already-running stream (after gen:status
 * reports it in-flight) WITHOUT firing a fresh generate invoke.
 */
describe('gen bridge — {detach, cancel} handle + attach (the decouple)', () => {
  it('detach() leaves the main-side run alive — it does NOT fire gen:cancel', () => {
    const transport = recordingTransport();
    const api = createGenApi(transport, () => 'g1');

    const handle = api.generateWhitepaper({ sessionId: 's1' }, noopCallbacks);
    handle.detach(); // modal closed — keep the run going

    expect(transport.invoked.some((i) => i.channel === GEN_CHANNELS.cancel)).toBe(false);
    // The generate invoke still happened (the run is live).
    expect(transport.invoked.some((i) => i.channel === GEN_CHANNELS.generateWhitepaper)).toBe(true);
  });

  it('cancel() fires gen:cancel for the requestId (explicit stop = no further spend)', () => {
    const transport = recordingTransport();
    const api = createGenApi(transport, () => 'g1');

    const handle = api.generateWhitepaper({ sessionId: 's1' }, noopCallbacks);
    handle.cancel();

    expect(transport.invoked).toContainEqual({
      channel: GEN_CHANNELS.cancel,
      args: [{ requestId: 'g1' }],
    });
  });

  it('a detached run that later finishes does not error and never fired cancel', () => {
    const transport = recordingTransport();
    const api = createGenApi(transport, () => 'g1');
    let dones = 0;
    const handle = api.generateWhitepaper(
      { sessionId: 's1' },
      { ...noopCallbacks, onDone: () => (dones += 1) },
    );
    handle.detach();

    // The (now-unsubscribed) renderer must not receive the late done — detach removed it.
    transport.emit(GEN_CHANNELS.done, {
      requestId: 'g1',
      result: {
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0 },
        kind: 'whitepaper',
      },
    });
    expect(dones).toBe(0);
    expect(transport.invoked.some((i) => i.channel === GEN_CHANNELS.cancel)).toBe(false);
  });

  it('attach(requestId) subscribes to an existing run WITHOUT a fresh generate invoke', () => {
    const transport = recordingTransport();
    const api = createGenApi(transport, () => 'unused');
    let phase: string | null = null;
    let done = 0;

    const handle = api.attach('live-7', {
      onChunk: () => undefined,
      onProgress: (p) => (phase = p.label),
      onDone: () => (done += 1),
      onError: () => undefined,
    });

    // No invoke at all — attach only listens.
    expect(transport.invoked).toEqual([]);

    // Events keyed by the existing requestId reach the reattached callbacks.
    transport.emit(GEN_CHANNELS.progress, {
      requestId: 'live-7',
      progress: { step: 'section', index: 4, total: 9, label: 'Section 2 of 6 — Themes' },
    });
    expect(phase).toBe('Section 2 of 6 — Themes');
    transport.emit(GEN_CHANNELS.done, {
      requestId: 'live-7',
      result: {
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0 },
        kind: 'whitepaper',
      },
    });
    expect(done).toBe(1);

    handle.detach();
  });
});
