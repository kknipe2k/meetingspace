import { describe, expect, it } from 'vitest';

import type {
  AnthropicClientLike,
  StreamRequest,
  StreamResult,
} from '../../electron/llm/anthropic-client';
import type { NoteReader } from '../../electron/llm/grounding';
import { createLlmService } from '../../electron/llm/llm-service';
import { DEFAULT_CHAT_MODEL } from '@shared/models';
import type { Note } from '@shared/types';

/*
 * S3-001 (independent audit 2026-06-17) — chat must validate the renderer-supplied model main-side.
 * llm-handlers `asString`-checks the model but never validates it against the catalog, so a forged
 * id reached the SDK `model` field. The service defaults an unknown model to DEFAULT_CHAT_MODEL; a
 * known model flows through. Mutation-verified: drop the validation and the forged id reaches the SDK.
 */
const KEY = 'sk-ant-api03-THIS-IS-A-FAKE-TEST-KEY-000';

function note(content: string): Note {
  return { id: 'n1', sessionId: 's1', content, createdAt: 1, updatedAt: 1 };
}
function notesWith(): NoteReader {
  return { listNotes: () => [note('We shipped on Friday.')] };
}

const DONE: StreamResult = {
  stopReason: 'end_turn',
  usage: { inputTokens: 1, outputTokens: 2 },
  model: 'claude-haiku-4-5',
};

function recordingService(): {
  service: ReturnType<typeof createLlmService>;
  seen: StreamRequest[];
} {
  const seen: StreamRequest[] = [];
  const client: AnthropicClientLike = {
    streamMessage: (request, onChunk) => {
      seen.push(request);
      onChunk('answer');
      return Promise.resolve(DONE);
    },
  };
  const service = createLlmService({
    keyStore: { getKeyForMain: () => KEY },
    clientFactory: () => client,
    notes: notesWith(),
  });
  return { service, seen };
}

describe('S3-001 — chat validates the renderer-supplied model main-side', () => {
  it('DEFAULTS an unknown/forged model id to the chat default before the SDK call', async () => {
    const { service, seen } = recordingService();
    await service.streamChat(
      { sessionId: 's1', question: 'hi', model: 'forged-evil-model-xyz' },
      { onChunk: () => undefined },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.model).toBe(DEFAULT_CHAT_MODEL);
    expect(seen[0]?.model).not.toBe('forged-evil-model-xyz');
  });

  it('passes a KNOWN catalog model through unchanged', async () => {
    const { service, seen } = recordingService();
    await service.streamChat(
      { sessionId: 's1', question: 'hi', model: 'claude-opus-4-8' },
      { onChunk: () => undefined },
    );
    expect(seen[0]?.model).toBe('claude-opus-4-8');
  });
});
