import type { LlmApi, LlmStreamCallbacks } from '@shared/api';
import type { ChatMessage, LlmChatRequest, LlmDone, LlmErrorPayload } from '@shared/types';

import { LLM_CHANNELS } from './channels';

/*
 * The renderer-facing streaming bridge (M03.B; M07.A wires real cancel). Unlike the
 * request/response bridges, chat is event-driven: `chat` invokes llm:chat with the
 * request plus a generated requestId, then subscribes to chunk/heartbeat/done/error
 * events FILTERED by that requestId so concurrent chats don't cross streams.
 *
 * It returns a TEARDOWN that, when the stream is still in flight, both detaches the
 * renderer's listeners AND invokes llm:cancel — so the user's Cancel / modal-close /
 * session-switch genuinely stops the main-side stream (M07.A; F11). A normal done/error
 * detaches listeners only (the stream already settled — no spurious cancel). No key and
 * no SDK ever cross here; the request carries only { sessionId, question, model }.
 *
 * The transport (invoke + on) and the requestId factory are injected so the
 * mapping is Node-unit-testable, leaving electron/preload.ts a thin shell.
 */
export interface IpcStreamTransport {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (payload: unknown) => void): () => void;
}

export type RequestIdFactory = () => string;

interface KeyedPayload {
  readonly requestId?: string;
}

export function createLlmApi(
  transport: IpcStreamTransport,
  newRequestId: RequestIdFactory,
): LlmApi {
  return {
    chat(request: LlmChatRequest, callbacks: LlmStreamCallbacks): () => void {
      const requestId = newRequestId();
      const offs: Array<() => void> = [];
      let active = true;
      // Detach the renderer's own listeners. Used internally on a normal done/error
      // settle (no cancel — the stream already finished).
      const detach = (): void => {
        if (!active) {
          return;
        }
        active = false;
        for (const off of offs) {
          off();
        }
      };

      const onKeyed = (channel: string, handle: (payload: KeyedPayload) => void): void => {
        offs.push(
          transport.on(channel, (payload) => {
            const keyed = payload as KeyedPayload;
            if (keyed?.requestId === requestId) {
              handle(keyed);
            }
          }),
        );
      };

      onKeyed(LLM_CHANNELS.chunk, (payload) =>
        callbacks.onChunk((payload as { delta: string }).delta),
      );
      onKeyed(LLM_CHANNELS.heartbeat, (payload) =>
        callbacks.onHeartbeat?.(payload as { elapsedMs: number; bytes: number }),
      );
      onKeyed(LLM_CHANNELS.done, (payload) => {
        const result = (payload as { result: LlmDone }).result;
        detach();
        callbacks.onDone(result);
      });
      onKeyed(LLM_CHANNELS.error, (payload) => {
        const error = (payload as { error: LlmErrorPayload }).error;
        detach();
        callbacks.onError(error);
      });

      void transport.invoke(LLM_CHANNELS.chat, { ...request, requestId });

      // The returned teardown: if still in flight, detach AND tell main to abort the
      // stream (F11). Guarded by `active`, so a teardown after settle is a no-op.
      return (): void => {
        if (!active) {
          return;
        }
        detach();
        void transport.invoke(LLM_CHANNELS.cancel, { requestId });
      };
    },

    // M06.D (ADR-0020): hydrate the session's persisted thread on open.
    history(sessionId: string): Promise<ChatMessage[]> {
      return transport.invoke(LLM_CHANNELS.history, { sessionId }) as Promise<ChatMessage[]>;
    },
  };
}
