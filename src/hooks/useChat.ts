import { useCallback, useEffect, useRef, useState } from 'react';

import { DEFAULT_CHAT_MODEL } from '@shared/models';
import type { LlmErrorPayload } from '@shared/types';

import { llmClient, type LlmClient } from '../ipc/client';

/*
 * Drives a streamed, session-grounded chat (M03.C; M03.D adds retry + Q+A capture).
 * The renderer holds NO key and NO SDK — `send` calls the typed `llm` IPC, which
 * streams the answer back as requestId-keyed chunk/done/error events. Chunks
 * accumulate into the in-flight assistant bubble; `onDone` finalizes; `onError`
 * surfaces a non-crashing error state. Grounding (the session's notes) is assembled
 * MAIN-SIDE — this hook only sends { sessionId, question, model }.
 *
 * M03.D: `retry()` re-sends the last question into a FRESH assistant bubble (no
 * duplicate user bubble) — the affordance for transient RATE_LIMIT/OFFLINE/
 * OVERLOADED errors. Each assistant message records the `question` that produced
 * it, so the chat panel can save the whole Q+A exchange as a note.
 */
export { DEFAULT_CHAT_MODEL };

export interface ChatMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  /** On assistant messages: the question that produced this reply (for Q+A save). */
  readonly question?: string;
  /** On assistant messages: the model the API answered with (shown + saved, M03.D). */
  readonly model?: string;
}

export interface UseChatOptions {
  client?: LlmClient;
  model?: string;
}

export interface UseChat {
  messages: ChatMessage[];
  isStreaming: boolean;
  error: LlmErrorPayload | null;
  send(question: string): void;
  retry(): void;
}

export function useChat(sessionId: string, options: UseChatOptions = {}): UseChat {
  const { client = llmClient, model = DEFAULT_CHAT_MODEL } = options;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<LlmErrorPayload | null>(null);

  const cancelRef = useRef<(() => void) | null>(null);
  const seq = useRef(0);
  const lastQuestion = useRef<string | null>(null);

  // Tear down any in-flight stream on unmount (or if the session id changes — the
  // panel is also remounted by key, this is the belt-and-suspenders cleanup).
  useEffect(() => {
    return () => {
      cancelRef.current?.();
      cancelRef.current = null;
    };
  }, [sessionId]);

  // M06.D (ADR-0020): hydrate the persisted thread on open so the conversation survives reload and
  // a session switch — the model's multi-turn memory is threaded main-side from the same store.
  // Assistant rows carry the answering model (→ badge); user rows do not.
  useEffect(() => {
    let active = true;
    void client.history(sessionId).then((rows) => {
      if (!active) {
        return;
      }
      seq.current = rows.length;
      setMessages(
        rows.map((row, index) => ({
          id: `h${index}`,
          role: row.role,
          text: row.content,
          ...(row.role === 'assistant' && row.model ? { model: row.model } : {}),
        })),
      );
    });
    return () => {
      active = false;
    };
  }, [client, sessionId]);

  // Open a stream for `question`, appending a fresh assistant bubble that records
  // the question (for Q+A save). Shared by send (new turn) and retry (same turn).
  const startStream = useCallback(
    (question: string): void => {
      cancelRef.current?.();

      seq.current += 1;
      const assistantId = `m${seq.current}`;

      setMessages((prev) => [...prev, { id: assistantId, role: 'assistant', text: '', question }]);
      setError(null);
      setIsStreaming(true);

      cancelRef.current = client.chat(
        { sessionId, question, model },
        {
          onChunk: (delta) =>
            setMessages((prev) =>
              prev.map((message) =>
                message.id === assistantId ? { ...message, text: message.text + delta } : message,
              ),
            ),
          onDone: (result) => {
            cancelRef.current = null;
            setIsStreaming(false);
            // Record which model answered (absent on the no-content marker).
            if (result.model !== undefined) {
              const answeredWith = result.model;
              setMessages((prev) =>
                prev.map((message) =>
                  message.id === assistantId ? { ...message, model: answeredWith } : message,
                ),
              );
            }
          },
          onError: (payload) => {
            cancelRef.current = null;
            setIsStreaming(false);
            setError(payload);
            // Drop the empty in-flight assistant bubble; the alert carries the state.
            setMessages((prev) => prev.filter((message) => message.id !== assistantId));
          },
        },
      );
    },
    [client, model, sessionId],
  );

  const send = useCallback(
    (question: string): void => {
      const trimmed = question.trim();
      if (trimmed.length === 0 || isStreaming) {
        return;
      }
      lastQuestion.current = trimmed;

      seq.current += 1;
      const userId = `m${seq.current}`;
      setMessages((prev) => [...prev, { id: userId, role: 'user', text: trimmed }]);

      startStream(trimmed);
    },
    [isStreaming, startStream],
  );

  // Re-run the last question after a transient error — reuses the existing user
  // bubble (no duplicate), opens a fresh assistant bubble.
  const retry = useCallback((): void => {
    const question = lastQuestion.current;
    if (question === null || isStreaming) {
      return;
    }
    startStream(question);
  }, [isStreaming, startStream]);

  return { messages, isStreaming, error, send, retry };
}
