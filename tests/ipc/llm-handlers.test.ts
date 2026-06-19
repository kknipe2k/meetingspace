import { describe, expect, it } from 'vitest';

import { LLM_CHANNELS } from '../../electron/ipc/channels';
import { registerLlmHandlers } from '../../electron/ipc/llm-handlers';
import { createCancelRegistry } from '../../electron/llm/cancel-registry';
import { LlmServiceError } from '../../electron/llm/errors';
import type { LlmService } from '../../electron/llm/llm-service';
import type { LlmChatRequest } from '@shared/types';

/*
 * The streaming chat IPC surface (M03.B). `llm:chat` is the invoke trigger; main
 * pushes llm:chunk/llm:done/llm:error events keyed by a renderer-generated
 * requestId via event.sender.send (a fake sender captures them under Node). The
 * trust boundary validates args main-side; the key never appears in any payload.
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

const REQUEST = { requestId: 'r1', sessionId: 's1', question: 'hi', model: 'claude-haiku-4-5' };

function streamingService(
  impl: (request: LlmChatRequest, onChunk: (delta: string) => void) => Promise<unknown>,
): LlmService {
  return {
    streamChat: (request, handlers) =>
      impl(request, handlers.onChunk) as ReturnType<LlmService['streamChat']>,
    loadHistory: () => [],
  };
}

describe('llm IPC handlers', () => {
  it('registers exactly the llm:chat, llm:cancel and llm:history channels', () => {
    const registrar = fakeRegistrar();
    registerLlmHandlers(
      registrar,
      streamingService(() => Promise.resolve({})),
      createCancelRegistry(),
    );
    expect([...registrar.handlers.keys()]).toEqual([
      LLM_CHANNELS.chat,
      LLM_CHANNELS.cancel,
      LLM_CHANNELS.history,
    ]);
  });

  it('streams chunk events then a done event, all keyed by requestId', async () => {
    const registrar = fakeRegistrar();
    const done = { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 2 } };
    let seen: LlmChatRequest | undefined;
    registerLlmHandlers(
      registrar,
      streamingService((request, onChunk) => {
        seen = request;
        onChunk('a');
        onChunk('b');
        return Promise.resolve(done);
      }),
      createCancelRegistry(),
    );
    const { event, sent } = fakeEvent();

    await registrar.handlers.get(LLM_CHANNELS.chat)?.(event, REQUEST);

    expect(seen).toEqual({ sessionId: 's1', question: 'hi', model: 'claude-haiku-4-5' });
    expect(sent).toEqual([
      { channel: LLM_CHANNELS.chunk, payload: { requestId: 'r1', delta: 'a' } },
      { channel: LLM_CHANNELS.chunk, payload: { requestId: 'r1', delta: 'b' } },
      { channel: LLM_CHANNELS.done, payload: { requestId: 'r1', result: done } },
    ]);
  });

  it('emits a single key-free error event when the service throws', async () => {
    const registrar = fakeRegistrar();
    registerLlmHandlers(
      registrar,
      streamingService(() => Promise.reject(new LlmServiceError('AUTH'))),
      createCancelRegistry(),
    );
    const { event, sent } = fakeEvent();

    await registrar.handlers.get(LLM_CHANNELS.chat)?.(event, REQUEST);

    expect(sent).toHaveLength(1);
    const [entry] = sent;
    expect(entry?.channel).toBe(LLM_CHANNELS.error);
    expect(entry?.payload).toMatchObject({ requestId: 'r1', error: { code: 'AUTH' } });
    const message = (entry?.payload as { error: { message: string } }).error.message;
    expect(typeof message).toBe('string');
    expect(message.length).toBeGreaterThan(0);
  });

  it('validates the request shape at the main-process boundary', async () => {
    const registrar = fakeRegistrar();
    registerLlmHandlers(
      registrar,
      streamingService(() => Promise.resolve({})),
      createCancelRegistry(),
    );
    const handler = registrar.handlers.get(LLM_CHANNELS.chat);
    const { event } = fakeEvent();

    await expect(handler?.(event, { ...REQUEST, question: 42 })).rejects.toBeInstanceOf(TypeError);
    await expect(handler?.(event, 'not-an-object')).rejects.toBeInstanceOf(TypeError);
    await expect(handler?.(event, { ...REQUEST, requestId: undefined })).rejects.toBeInstanceOf(
      TypeError,
    );
  });
});
