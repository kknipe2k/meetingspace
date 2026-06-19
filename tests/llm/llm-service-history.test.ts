import { describe, expect, it, vi } from 'vitest';

import type {
  AnthropicClientLike,
  StreamRequest,
  StreamResult,
} from '../../electron/llm/anthropic-client';
import type { NoteReader } from '../../electron/llm/grounding';
import { createLlmService } from '../../electron/llm/llm-service';
import type { ChatMessage, LlmChatRequest, Note } from '@shared/types';

/*
 * M06.D (ADR-0020) — persisted conversation history threaded into the chat request.
 *
 * THE LOAD-BEARING INVARIANT (gate "Conversation cache discipline"): history rides in
 * `messages[]` AFTER the cached FOCUS/grounding prefix (the `system` block). The `system`
 * bytes MUST be byte-identical with and without history present, or the prompt cache misses
 * every turn. (Mutation: thread history into `system` → the byte-identical assertion fails.)
 */
const KEY = 'sk-ant-api03-THIS-IS-A-FAKE-TEST-KEY-000';
const REQUEST: LlmChatRequest = {
  sessionId: 's1',
  question: 'And the deadline?',
  model: 'claude-haiku-4-5',
};

function note(content: string): Note {
  return { id: 'n1', sessionId: 's1', content, createdAt: 1, updatedAt: 1 };
}
function notesWith(notes: Note[] = [note('We shipped on Friday.')]): NoteReader {
  return { listNotes: () => notes };
}
function chatMsg(id: string, role: 'user' | 'assistant', content: string): ChatMessage {
  return {
    id,
    sessionId: 's1',
    role,
    content,
    model: role === 'assistant' ? 'm' : null,
    createdAt: Number(id),
  };
}

const DONE: StreamResult = {
  stopReason: 'end_turn',
  usage: { inputTokens: 11, outputTokens: 22 },
  model: 'claude-haiku-4-5',
};

function fakeClient(
  onStream: (request: StreamRequest, onChunk: (d: string) => void) => StreamResult,
): AnthropicClientLike {
  return { streamMessage: (request, onChunk) => Promise.resolve(onStream(request, onChunk)) };
}

// A minimal in-memory chat store matching the service's ChatHistoryStore dep.
function fakeChat(seed: ChatMessage[] = []) {
  const rows = [...seed];
  return {
    rows,
    listMessages: () => rows,
    appendMessage: vi.fn(
      (input: {
        sessionId: string;
        role: 'user' | 'assistant';
        content: string;
        model?: string | null;
      }) => {
        rows.push({
          id: `x${rows.length}`,
          sessionId: input.sessionId,
          role: input.role,
          content: input.content,
          model: input.model ?? null,
          createdAt: rows.length,
        });
      },
    ),
  };
}

describe('createLlmService.streamChat — persisted history', () => {
  it('threads prior turns into messages AFTER the cached system prefix, byte-identical system', async () => {
    let withHistory: StreamRequest | undefined;
    let withoutHistory: StreamRequest | undefined;

    const serviceWith = createLlmService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory: () =>
        fakeClient((r) => {
          withHistory = r;
          return DONE;
        }),
      notes: notesWith(),
      chat: fakeChat([
        chatMsg('1', 'user', 'When did we ship?'),
        chatMsg('2', 'assistant', 'Friday.'),
      ]),
    });
    await serviceWith.streamChat(REQUEST, { onChunk: () => undefined });

    const serviceWithout = createLlmService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory: () =>
        fakeClient((r) => {
          withoutHistory = r;
          return DONE;
        }),
      notes: notesWith(),
      chat: fakeChat([]),
    });
    await serviceWithout.streamChat(REQUEST, { onChunk: () => undefined });

    // The cached prefix (system) is byte-identical whether or not history is present.
    expect(withHistory?.system).toBe(withoutHistory?.system);

    // History rides in messages, BEFORE the current question, as text content blocks.
    expect(withHistory?.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'When did we ship?' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Friday.' }] },
      { role: 'user', content: [{ type: 'text', text: REQUEST.question }] },
    ]);
    // No history → just the current question.
    expect(withoutHistory?.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: REQUEST.question }] },
    ]);
  });

  it('persists the user turn AND the assistant reply on success', async () => {
    const chat = fakeChat([]);
    const service = createLlmService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory: () =>
        fakeClient((_r, onChunk) => {
          onChunk('Mon');
          onChunk('day.');
          return DONE;
        }),
      notes: notesWith(),
      chat,
    });

    await service.streamChat(REQUEST, { onChunk: () => undefined });

    expect(chat.appendMessage).toHaveBeenCalledTimes(2);
    expect(chat.appendMessage).toHaveBeenNthCalledWith(1, {
      sessionId: 's1',
      role: 'user',
      content: REQUEST.question,
    });
    expect(chat.appendMessage).toHaveBeenNthCalledWith(2, {
      sessionId: 's1',
      role: 'assistant',
      content: 'Monday.',
      model: 'claude-haiku-4-5',
    });
  });

  it('records the turn usage on success', async () => {
    const usage = { record: vi.fn() };
    const service = createLlmService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory: () => fakeClient(() => DONE),
      notes: notesWith(),
      chat: fakeChat([]),
      usage,
    });

    await service.streamChat(REQUEST, { onChunk: () => undefined });

    expect(usage.record).toHaveBeenCalledWith({
      sessionId: 's1',
      kind: 'chat',
      model: 'claude-haiku-4-5',
      usage: DONE.usage,
    });
  });

  it('persists NOTHING and records no usage on the no-content path', async () => {
    const chat = fakeChat([]);
    const usage = { record: vi.fn() };
    const service = createLlmService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory: () => fakeClient(() => DONE),
      notes: notesWith([]), // empty session → no-content marker, no SDK
      chat,
      usage,
    });

    await service.streamChat(REQUEST, { onChunk: () => undefined });

    expect(chat.appendMessage).not.toHaveBeenCalled();
    expect(usage.record).not.toHaveBeenCalled();
  });

  it('persists NOTHING and records no usage when the stream fails', async () => {
    const chat = fakeChat([]);
    const usage = { record: vi.fn() };
    const service = createLlmService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory: (): AnthropicClientLike => ({
        streamMessage: () => Promise.reject(new Error('boom')),
      }),
      notes: notesWith(),
      chat,
      usage,
    });

    await expect(service.streamChat(REQUEST, { onChunk: () => undefined })).rejects.toBeTruthy();
    expect(chat.appendMessage).not.toHaveBeenCalled();
    expect(usage.record).not.toHaveBeenCalled();
  });
});
