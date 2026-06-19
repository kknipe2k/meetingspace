import { describe, expect, it } from 'vitest';

import { LLM_CHANNELS } from '../../electron/ipc/channels';
import { registerLlmHandlers } from '../../electron/ipc/llm-handlers';
import type { LlmService } from '../../electron/llm/llm-service';
import type { ChatMessage, LlmDone } from '@shared/types';

/*
 * M06.D (ADR-0020) — `llm:history` hydrates a session's persisted thread on open, so the chat
 * survives reload. Plain request/response: validated sessionId in, the stored ChatMessage[] out.
 * No key, no SDK crosses (chat content is user data).
 */
type Handler = (event: unknown, ...args: unknown[]) => unknown;
function fakeRegistrar(): {
  handle: (c: string, h: Handler) => void;
  handlers: Map<string, Handler>;
} {
  const handlers = new Map<string, Handler>();
  return { handle: (c, h) => handlers.set(c, h), handlers };
}

const THREAD: ChatMessage[] = [
  { id: 'c1', sessionId: 's1', role: 'user', content: 'hi', model: null, createdAt: 1 },
  { id: 'c2', sessionId: 's1', role: 'assistant', content: 'hello', model: 'm', createdAt: 2 },
];

function fakeService(captured: { sessionId?: string }): LlmService {
  return {
    streamChat: () =>
      Promise.resolve({
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0 },
      } as LlmDone),
    loadHistory: (sessionId: string) => {
      captured.sessionId = sessionId;
      return THREAD;
    },
  };
}

describe('llm:history handler', () => {
  it('returns the persisted thread for a validated sessionId', () => {
    const captured: { sessionId?: string } = {};
    const reg = fakeRegistrar();
    registerLlmHandlers(reg, fakeService(captured));

    const out = reg.handlers.get(LLM_CHANNELS.history)?.({}, { sessionId: 's1' });
    expect(captured.sessionId).toBe('s1');
    expect(out).toEqual(THREAD);
  });

  it('rejects a non-string sessionId at the trust boundary', () => {
    const reg = fakeRegistrar();
    registerLlmHandlers(reg, fakeService({}));
    const handler = reg.handlers.get(LLM_CHANNELS.history);
    expect(() => handler?.({}, { sessionId: 42 })).toThrow();
  });
});
