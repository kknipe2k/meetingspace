import type {
  ChatMessage,
  LlmChatRequest,
  LlmDone,
  LlmHeartbeat,
  LlmMessage,
  LlmUsage,
} from '@shared/types';
import { HISTORY_TOKEN_BUDGET } from '@shared/limits';
import { DEFAULT_CHAT_MODEL, maxOutputTokensFor } from '@shared/models';

import type {
  AnthropicClientFactory,
  AnthropicClientOptions,
  ChunkHandler,
} from './anthropic-client';
import { selectHistoryWindow } from './chat-history';
import { LlmServiceError, mapAnthropicError } from './errors';
import { buildGroundingContext, type NoteReader } from './grounding';

/*
 * The LLM service (M03.B; M03.C adds grounding): the seam between the typed IPC
 * handler and the Anthropic client. It reads the key from KeyStore.getKeyForMain()
 * ON EVERY CALL (never cached anywhere a renderer/IPC path can reach — Hard Rule
 * §10), assembles the session's notes into a `system` prefix MAIN-SIDE (M03.C —
 * the renderer never supplies the grounded text), streams, and re-raises failures
 * as typed, KEY-FREE LlmServiceErrors.
 *
 * Empty session: if the session has no content-bearing notes, the service emits a
 * single no-content marker and resolves WITHOUT calling the SDK — the
 * "don't-spend-tokens-on-an-empty-session" decision lives main-side (M03.B
 * decision #3), so the renderer needs no special case and no key is exercised.
 */
export interface KeyReader {
  getKeyForMain(): string | null;
}

// M06.D (ADR-0020): the persisted chat thread. `listMessages` hydrates the recent window threaded
// into the request (AFTER the cached prefix); `appendMessage` saves the user turn + the assistant
// reply on success. Optional dep so existing callers/tests (and the empty-session path) are valid.
export interface ChatHistoryStore {
  listMessages(sessionId: string): ChatMessage[];
  appendMessage(input: {
    sessionId: string;
    role: 'user' | 'assistant';
    content: string;
    model?: string | null;
  }): void;
}

// M06.D (ADR-0021): the passive usage recorder. `record` is called on a successful turn with the
// REAL usage off the stream result (never the key). Optional dep so existing callers/tests are valid.
export interface UsageRecorder {
  record(input: { sessionId: string; kind: 'chat'; model?: string | null; usage: LlmUsage }): void;
}

export interface LlmStreamHandlers {
  onChunk: ChunkHandler;
  // M07.A: optional cancel signal + heartbeat sink threaded through to the client. Both
  // are optional so non-cancellable / non-heartbeating callers (and the existing tests)
  // build the client with exactly { apiKey, ceilingMs } as before.
  signal?: AbortSignal;
  onHeartbeat?: (heartbeat: LlmHeartbeat) => void;
}

export interface LlmService {
  streamChat(request: LlmChatRequest, handlers: LlmStreamHandlers): Promise<LlmDone>;
  // M06.D (ADR-0020): the session's persisted thread, for hydration on open (llm:history).
  loadHistory(sessionId: string): ChatMessage[];
}

export interface LlmServiceDeps {
  keyStore: KeyReader;
  clientFactory: AnthropicClientFactory;
  notes: NoteReader;
  // M06.D: optional persistence + usage. Absent → the service behaves exactly as before (no
  // history threaded, nothing persisted, no usage recorded).
  chat?: ChatHistoryStore;
  usage?: UsageRecorder;
  // Audit S3-001: validates the renderer-supplied model against the catalog main-side. Injected so
  // production uses the LIVE catalog (main.ts → modelCatalog.isKnownModel); defaults to the static
  // catalog floor so the check is ALWAYS on, never contingent on wiring.
  isKnownModel?: (model: string) => boolean;
}

// Bounded so a single chat can't run away on tokens; model selection + tuning
// land in Stage D. Streaming means timeouts aren't the constraint here.
const DEFAULT_MAX_TOKENS = 4096;

// Chat answers are short and interactive, so the wall-clock backstop is tighter than
// the generation default (600s, for a multi-minute white paper). The byte/text-idle
// tiers (anthropic-client defaults) are shared (D-01).
const CHAT_CEILING_MS = 120_000;

// Streamed back as the assistant reply when the session has nothing to ground on,
// in place of an SDK call. A graceful affordance, not an error.
export const NO_CONTENT_MESSAGE =
  "This session doesn't have any notes yet. Add some notes or a transcript, then ask me about them.";

export function createLlmService({
  keyStore,
  clientFactory,
  notes,
  chat,
  usage,
  isKnownModel = (model) => maxOutputTokensFor(model) !== null,
}: LlmServiceDeps): LlmService {
  return {
    loadHistory(sessionId) {
      return chat ? chat.listMessages(sessionId) : [];
    },

    async streamChat(request, handlers) {
      const apiKey = keyStore.getKeyForMain();
      if (apiKey === null) {
        throw new LlmServiceError('NO_KEY');
      }

      const grounding = buildGroundingContext(request.sessionId, notes);
      if (grounding.noteCount === 0) {
        // Nothing to ground on — stream the marker, skip the SDK (no token spend). Persist
        // nothing and record no usage: the no-content marker is not a real exchange.
        handlers.onChunk(NO_CONTENT_MESSAGE);
        return { stopReason: 'no_content', usage: { inputTokens: 0, outputTokens: 0 } };
      }

      const clientOptions: AnthropicClientOptions = {
        apiKey,
        ceilingMs: CHAT_CEILING_MS,
        ...(handlers.signal ? { signal: handlers.signal } : {}),
        ...(handlers.onHeartbeat ? { onHeartbeat: handlers.onHeartbeat } : {}),
      };
      const client = clientFactory(clientOptions);

      // ADR-0020 cache discipline: the token-budgeted history window rides in `messages` AFTER the
      // cached grounding `system` prefix (which is byte-identical with or without history), so the
      // prompt cache holds across turns. Oldest turns drop first (selectHistoryWindow).
      const history = chat
        ? selectHistoryWindow(chat.listMessages(request.sessionId), HISTORY_TOKEN_BUDGET)
        : [];
      const messages: LlmMessage[] = [
        ...history.map(
          (message): LlmMessage => ({
            role: message.role,
            content: [{ type: 'text', text: message.content }],
          }),
        ),
        { role: 'user', content: [{ type: 'text', text: request.question }] },
      ];

      // Accumulate the assistant reply so the turn can be persisted on success (the client streams
      // deltas; it does not hand back the full text).
      let answer = '';
      const onChunk: ChunkHandler = (delta) => {
        answer += delta;
        handlers.onChunk(delta);
      };

      // Validate the renderer-supplied model main-side (audit S3-001): an unknown/forged id falls
      // back to the chat default, so a compromised renderer can't pin chat to an arbitrary model.
      const model = isKnownModel(request.model) ? request.model : DEFAULT_CHAT_MODEL;

      let result: LlmDone;
      try {
        result = await client.streamMessage(
          {
            model,
            messages,
            system: grounding.system,
            maxTokens: DEFAULT_MAX_TOKENS,
          },
          onChunk,
        );
      } catch (error) {
        // A failed (or cancelled) turn persists nothing and records no usage.
        throw mapAnthropicError(error);
      }

      // Success — persist the exchange (multi-turn memory + survives reload) and record real usage.
      chat?.appendMessage({
        sessionId: request.sessionId,
        role: 'user',
        content: request.question,
      });
      chat?.appendMessage({
        sessionId: request.sessionId,
        role: 'assistant',
        content: answer,
        ...(result.model !== undefined ? { model: result.model } : {}),
      });
      usage?.record({
        sessionId: request.sessionId,
        kind: 'chat',
        ...(result.model !== undefined ? { model: result.model } : {}),
        usage: result.usage,
      });

      return result;
    },
  };
}
