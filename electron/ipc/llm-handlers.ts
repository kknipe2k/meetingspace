import type { LlmChatRequest } from '@shared/types';

import { createCancelRegistry, type CancelRegistry } from '../llm/cancel-registry';
import { LlmServiceError } from '../llm/errors';
import type { LlmService } from '../llm/llm-service';

import { LLM_CHANNELS } from './channels';
import type { IpcHandleRegistrar } from './note-handlers';

/*
 * The streaming chat IPC surface (M03.B). `llm:chat` is the invoke trigger; the
 * main process streams the answer back as requestId-keyed events on the caller's
 * own webContents (chunk → done, or a single key-free error). The trust boundary
 * is here (spec §5): every field is validated main-side, and no payload ever
 * carries the key — the decrypted key lives only inside the LLM service.
 */
interface WebContentsLike {
  send(channel: string, payload: unknown): void;
  isDestroyed?(): boolean;
}

function safeSend(sender: WebContentsLike, channel: string, payload: unknown): void {
  // The window may close mid-stream; never throw out of a fire-and-forget send.
  if (sender.isDestroyed?.()) {
    return;
  }
  sender.send(channel, payload);
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`llm ipc: ${field} must be a string`);
  }
  return value;
}

interface ChatInvocation extends LlmChatRequest {
  readonly requestId: string;
}

function parseChatInvocation(raw: unknown): ChatInvocation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError('llm ipc: request must be an object');
  }
  const record = raw as Record<string, unknown>;
  return {
    requestId: asString(record.requestId, 'requestId'),
    sessionId: asString(record.sessionId, 'sessionId'),
    question: asString(record.question, 'question'),
    model: asString(record.model, 'model'),
  };
}

export function registerLlmHandlers(
  registrar: IpcHandleRegistrar,
  service: LlmService,
  // Each registration owns one registry (chat + cancel handlers share it); main.ts passes
  // a dedicated instance per domain so a gen:cancel can never abort a chat. Defaulted for
  // callers that don't wire cancel explicitly — a fresh per-call instance is equivalent.
  cancels: CancelRegistry = createCancelRegistry(),
): void {
  registrar.handle(LLM_CHANNELS.chat, async (event, raw) => {
    const { requestId, sessionId, question, model } = parseChatInvocation(raw);
    const sender = (event as { sender: WebContentsLike }).sender;

    // Per-invocation cancel: register the stream's abort under its requestId so llm:cancel
    // can fire it main-side (F11); unregister on settle so a later cancel is a clean miss.
    const controller = new AbortController();
    cancels.register(requestId, () => controller.abort());

    try {
      const result = await service.streamChat(
        { sessionId, question, model },
        {
          onChunk: (delta) => safeSend(sender, LLM_CHANNELS.chunk, { requestId, delta }),
          signal: controller.signal,
          onHeartbeat: ({ elapsedMs, bytes }) =>
            safeSend(sender, LLM_CHANNELS.heartbeat, { requestId, elapsedMs, bytes }),
        },
      );
      safeSend(sender, LLM_CHANNELS.done, { requestId, result });
    } catch (error) {
      // streamChat only throws typed, key-free LlmServiceErrors; guard the rest.
      const payload = (
        error instanceof LlmServiceError ? error : new LlmServiceError('UNKNOWN')
      ).toPayload();
      safeSend(sender, LLM_CHANNELS.error, { requestId, error: payload });
    } finally {
      cancels.unregister(requestId);
    }
  });

  // llm:cancel — abort the in-flight chat for { requestId } (idempotent; unknown id → false).
  // async so a boundary-validation throw surfaces as a rejected invoke (matching ipcMain.handle).
  registrar.handle(LLM_CHANNELS.cancel, async (_event, raw) => {
    const requestId = asString((raw as { requestId?: unknown })?.requestId, 'requestId');
    return cancels.cancel(requestId);
  });

  // llm:history — hydrate the session's persisted thread on open (M06.D, ADR-0020). Plain
  // request/response; sessionId validated main-side; chat content (user data) crosses, never the key.
  registrar.handle(LLM_CHANNELS.history, (_event, raw) => {
    const sessionId = asString((raw as { sessionId?: unknown })?.sessionId, 'sessionId');
    return service.loadHistory(sessionId);
  });
}
