import { describe, expect, it } from 'vitest';

import { GEN_CHANNELS, LLM_CHANNELS } from '../../electron/ipc/channels';
import { registerGenHandlers, type GenIpcService } from '../../electron/ipc/gen-handlers';
import { registerLlmHandlers } from '../../electron/ipc/llm-handlers';
import { createCancelRegistry } from '../../electron/llm/cancel-registry';
import type { LlmService } from '../../electron/llm/llm-service';

/*
 * M07.A — the cancel IPC surface. Each streaming handler now creates an AbortController
 * per invocation, registers its abort in a requestId-keyed registry, threads the signal
 * into the service call, and unregisters on settle. `llm:cancel` / `gen:cancel` look the
 * id up and fire the abort — so a renderer Cancel genuinely stops the main-side stream.
 * The llm and gen registries are SEPARATE instances so a gen:cancel can never abort a chat.
 */
type Handler = (event: unknown, ...args: unknown[]) => unknown;

function fakeRegistrar(): {
  handle: (c: string, h: Handler) => void;
  handlers: Map<string, Handler>;
} {
  const handlers = new Map<string, Handler>();
  return { handle: (channel, handler) => handlers.set(channel, handler), handlers };
}

function fakeEvent(): { event: unknown; sent: Array<{ channel: string; payload: unknown }> } {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return {
    sent,
    event: {
      sender: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
    },
  };
}

const CHAT_REQUEST = {
  requestId: 'r1',
  sessionId: 's1',
  question: 'hi',
  model: 'claude-haiku-4-5',
};
const GEN_REQUEST = { requestId: 'g1', sessionId: 's1' };

// A service whose stream stays pending until we release it, capturing the handlers
// object so the test can observe the threaded AbortSignal.
function pendingChatService(): {
  service: LlmService;
  captured: { signal: AbortSignal | undefined };
  release: () => void;
} {
  const captured: { signal: AbortSignal | undefined } = { signal: undefined };
  let release = (): void => undefined;
  const service: LlmService = {
    streamChat: (_request, handlers) => {
      captured.signal = (handlers as { signal?: AbortSignal }).signal;
      return new Promise((resolve) => {
        release = () =>
          resolve({ stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } });
      });
    },
    loadHistory: () => [],
  };
  return { service, captured, release: () => release() };
}

function pendingGenService(): {
  service: GenIpcService;
  captured: { signal: AbortSignal | undefined };
  release: () => void;
} {
  const captured: { signal: AbortSignal | undefined } = { signal: undefined };
  let release = (): void => undefined;
  const streaming = (
    _request: unknown,
    handlers: { signal?: AbortSignal },
  ):
    | Promise<never>
    | Promise<{
        stopReason: string;
        usage: { inputTokens: number; outputTokens: number };
        kind: 'whitepaper';
      }> => {
    captured.signal = handlers.signal;
    return new Promise((resolve) => {
      release = () =>
        resolve({
          stopReason: 'end_turn',
          usage: { inputTokens: 0, outputTokens: 0 },
          kind: 'whitepaper',
        });
    });
  };
  const service = {
    generateFocus: streaming,
    generateWhitepaper: streaming,
    generateMinutes: streaming,
    buildRawDoc: () => '',
    exportImages: () => ({ images: [], omittedCount: 0 }),
    exportHtml: () => Promise.resolve({ saved: false }),
    exportMarkdown: () => Promise.resolve({ saved: false }),
    exportPdf: () => Promise.resolve({ saved: false }),
    listTemplates: () => [],
    saveTemplate: () => ({
      id: 'x',
      name: 'x',
      focusPrompt: '',
      whitepaperPrompt: '',
      isDefault: false,
    }),
    getTemplate: () => null,
    deleteTemplate: () => undefined,
    getArtifacts: () => [],
  } as unknown as GenIpcService;
  return { service, captured, release: () => release() };
}

describe('llm:cancel handler', () => {
  it('registers the cancel channel alongside chat', () => {
    const registrar = fakeRegistrar();
    registerLlmHandlers(registrar, pendingChatService().service, createCancelRegistry());
    expect([...registrar.handlers.keys()]).toContain(LLM_CHANNELS.cancel);
  });

  it('cancel aborts the in-flight stream by requestId, then reports a miss once settled', async () => {
    const registrar = fakeRegistrar();
    const { service, captured, release } = pendingChatService();
    registerLlmHandlers(registrar, service, createCancelRegistry());
    const { event } = fakeEvent();

    const inFlight = registrar.handlers.get(LLM_CHANNELS.chat)?.(event, CHAT_REQUEST);
    await Promise.resolve(); // let the handler register the abort

    expect(captured.signal).toBeDefined();
    expect(captured.signal?.aborted).toBe(false);

    const hit = await registrar.handlers.get(LLM_CHANNELS.cancel)?.(event, { requestId: 'r1' });
    expect(hit).toBe(true);
    expect(captured.signal?.aborted).toBe(true);

    release();
    await inFlight;

    // settled → unregistered → a second cancel is a no-op miss
    expect(await registrar.handlers.get(LLM_CHANNELS.cancel)?.(event, { requestId: 'r1' })).toBe(
      false,
    );
  });

  it('cancel of an unknown id is a safe no-op miss; a non-string id is rejected at the boundary', async () => {
    const registrar = fakeRegistrar();
    registerLlmHandlers(registrar, pendingChatService().service, createCancelRegistry());
    const { event } = fakeEvent();
    const cancel = registrar.handlers.get(LLM_CHANNELS.cancel);

    expect(await cancel?.(event, { requestId: 'does-not-exist' })).toBe(false);
    await expect(cancel?.(event, { requestId: 42 })).rejects.toBeInstanceOf(TypeError);
  });
});

describe('gen:cancel handler', () => {
  it('registers the cancel channel and aborts the in-flight generation by requestId', async () => {
    const registrar = fakeRegistrar();
    const { service, captured, release } = pendingGenService();
    registerGenHandlers(registrar, service, createCancelRegistry());
    expect([...registrar.handlers.keys()]).toContain(GEN_CHANNELS.cancel);
    const { event } = fakeEvent();

    const inFlight = registrar.handlers.get(GEN_CHANNELS.generateWhitepaper)?.(event, GEN_REQUEST);
    await Promise.resolve();

    expect(captured.signal?.aborted).toBe(false);
    expect(await registrar.handlers.get(GEN_CHANNELS.cancel)?.(event, { requestId: 'g1' })).toBe(
      true,
    );
    expect(captured.signal?.aborted).toBe(true);

    release();
    await inFlight;
  });
});
