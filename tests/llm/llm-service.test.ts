import { describe, expect, it, vi } from 'vitest';

import type {
  AnthropicClientLike,
  StreamRequest,
  StreamResult,
} from '../../electron/llm/anthropic-client';
import { LlmServiceError } from '../../electron/llm/errors';
import type { NoteReader } from '../../electron/llm/grounding';
import { createLlmService, NO_CONTENT_MESSAGE } from '../../electron/llm/llm-service';
import type { LlmChatRequest, Note } from '@shared/types';

/*
 * The LLM service (M03.B; M03.C adds main-side grounding): reads the key from
 * KeyStore.getKeyForMain() PER CALL, assembles the session's notes into a `system`
 * prefix (M03.C), builds the client, streams, and surfaces typed, KEY-FREE errors.
 * Driven with a fake client + fake NoteReader (no SDK, no network, no DB) — error-code
 * mapping against the real SDK lives in tests/integration/llm-mocked.test.ts.
 */
const KEY = 'sk-ant-api03-THIS-IS-A-FAKE-TEST-KEY-000';
const REQUEST: LlmChatRequest = {
  sessionId: 's1',
  question: 'What did we decide?',
  model: 'claude-haiku-4-5',
};

function note(content: string): Note {
  return { id: 'n1', sessionId: 's1', content, createdAt: 1, updatedAt: 1 };
}

// A session with content to ground on, unless a test overrides it.
function notesWith(notes: Note[] = [note('We shipped on Friday.')]): NoteReader {
  return { listNotes: () => notes };
}

function fakeClient(
  onStream: (request: StreamRequest, onChunk: (delta: string) => void) => StreamResult,
): AnthropicClientLike {
  return {
    streamMessage: (request, onChunk) => Promise.resolve(onStream(request, onChunk)),
  };
}

const DONE: StreamResult = {
  stopReason: 'end_turn',
  usage: { inputTokens: 1, outputTokens: 2 },
  model: 'claude-haiku-4-5',
};

describe('createLlmService.streamChat', () => {
  it('reads the key from KeyStore on every call and builds the client with it', async () => {
    const getKeyForMain = vi.fn(() => KEY);
    const clientFactory = vi.fn(() => fakeClient(() => DONE));
    const service = createLlmService({
      keyStore: { getKeyForMain },
      clientFactory,
      notes: notesWith(),
    });

    await service.streamChat(REQUEST, { onChunk: () => undefined });
    await service.streamChat(REQUEST, { onChunk: () => undefined });

    expect(getKeyForMain).toHaveBeenCalledTimes(2);
    // D-01: chat passes a tighter wall-clock ceiling (120s) than the generation default.
    expect(clientFactory).toHaveBeenNthCalledWith(1, { apiKey: KEY, ceilingMs: 120_000 });
    expect(clientFactory).toHaveBeenNthCalledWith(2, { apiKey: KEY, ceilingMs: 120_000 });
  });

  it('rejects with NO_KEY and never constructs a client when no key is configured', async () => {
    const clientFactory = vi.fn(() => fakeClient(() => DONE));
    const service = createLlmService({
      keyStore: { getKeyForMain: () => null },
      clientFactory,
      notes: notesWith(),
    });

    await expect(service.streamChat(REQUEST, { onChunk: () => undefined })).rejects.toMatchObject({
      code: 'NO_KEY',
    });
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('streams the question as a text content block and forwards deltas in order', async () => {
    let seen: StreamRequest | undefined;
    const clientFactory = () =>
      fakeClient((request, onChunk) => {
        seen = request;
        onChunk('a');
        onChunk('b');
        return DONE;
      });
    const service = createLlmService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory,
      notes: notesWith([note('We shipped on Friday.')]),
    });

    const chunks: string[] = [];
    const done = await service.streamChat(REQUEST, { onChunk: (d) => chunks.push(d) });

    expect(chunks).toEqual(['a', 'b']);
    expect(done).toEqual(DONE);
    expect(seen?.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: REQUEST.question }] },
    ]);
    // Grounding flows main-side into the system prefix (which the client wrapper
    // prompt-caches). The renderer never supplies this text.
    expect(seen?.system).toContain('We shipped on Friday.');
  });

  it('emits a no-content marker and skips the SDK when the session has no notes', async () => {
    const clientFactory = vi.fn(() => fakeClient(() => DONE));
    const service = createLlmService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory,
      notes: notesWith([]),
    });

    const chunks: string[] = [];
    const done = await service.streamChat(REQUEST, { onChunk: (d) => chunks.push(d) });

    // Don't spend tokens on an empty session — decided main-side (M03.B decision #3).
    expect(clientFactory).not.toHaveBeenCalled();
    expect(chunks).toEqual([NO_CONTENT_MESSAGE]);
    expect(done.stopReason).toBe('no_content');
  });

  it('maps an unrecognized client failure to a typed UNKNOWN error', async () => {
    const clientFactory = (): AnthropicClientLike => ({
      streamMessage: () => Promise.reject(new Error('boom')),
    });
    const service = createLlmService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory,
      notes: notesWith(),
    });

    await expect(service.streamChat(REQUEST, { onChunk: () => undefined })).rejects.toBeInstanceOf(
      LlmServiceError,
    );
    await expect(service.streamChat(REQUEST, { onChunk: () => undefined })).rejects.toMatchObject({
      code: 'UNKNOWN',
    });
  });

  it('passes a client timeout-tier code straight through (chat benefits from the watchdog — M04.C cycle 2)', async () => {
    // The client wrapper's stall/ceiling watchdog throws a typed TIMEOUT_* tier (M07.A);
    // the service must surface it unchanged so the chat panel can show a Retry (not collapse
    // it to UNKNOWN).
    const clientFactory = (): AnthropicClientLike => ({
      streamMessage: () => Promise.reject(new LlmServiceError('TIMEOUT_CEILING')),
    });
    const service = createLlmService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory,
      notes: notesWith(),
    });

    await expect(service.streamChat(REQUEST, { onChunk: () => undefined })).rejects.toMatchObject({
      code: 'TIMEOUT_CEILING',
    });
  });

  it('never includes the key in a surfaced error (even if the underlying error echoes it)', async () => {
    const clientFactory = (): AnthropicClientLike => ({
      streamMessage: () =>
        Promise.reject(new Error(`request failed with header x-api-key: ${KEY}`)),
    });
    const service = createLlmService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory,
      notes: notesWith(),
    });

    try {
      await service.streamChat(REQUEST, { onChunk: () => undefined });
      throw new Error('expected streamChat to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(LlmServiceError);
      const surfaced = error as LlmServiceError;
      expect(surfaced.message).not.toContain(KEY);
      expect(JSON.stringify(surfaced.toPayload())).not.toContain(KEY);
    }
  });
});
