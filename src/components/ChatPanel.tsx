import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react';

import type { NotesApi } from '@shared/api';
import { DEFAULT_CHAT_MODEL, modelLabel } from '@shared/models';

import {
  llmClient,
  noteClient as defaultNoteClient,
  usageClient as defaultUsageClient,
  genEventsClient as defaultGenEventsClient,
  type LlmClient,
  type CatalogClient,
  type GenEventsClient,
  type UsageClient,
} from '../ipc/client';
import { useChat, type ChatMessage, type UseChatOptions } from '../hooks/useChat';
import { useElapsed } from '../hooks/useElapsed';
import { useModelCatalog } from '../hooks/useModelCatalog';
import { useMutationToast } from '../hooks/useMutationToast';
import { useToasts } from '../hooks/useToasts';
import { useUsageCounter } from '../hooks/useUsageCounter';

// After this long mid-stream, show a calm expectation toast (D-01) — a reassurance, not an
// alarm; the main-process three-tier watchdog is what actually aborts a dead/wedged stream.
// M07.B: this rides the app-level toast system (F24) instead of an ad-hoc per-panel div.
const HINT_AFTER_MS = 12_000;

// Within this many px of the bottom counts as "following" — a streaming reply keeps the view
// pinned only while the user is this close to the end (sticky auto-follow, post-IRL #2).
const NEAR_BOTTOM_PX = 80;

export interface ChatPanelProps {
  sessionId: string;
  /** Injectable for tests; defaults to the real llm IPC client. */
  client?: LlmClient;
  /** The selected chat model (owned by LLMPanel via prefs); defaults to Haiku 4.5. */
  model?: string;
  /** Persist a model change (LLMPanel writes settings:setPrefs). */
  onModelChange?(model: string): void;
  /** Open the settings surface — the affordance for AUTH / NO_KEY errors. */
  onOpenSettings?(): void;
  /** Injectable for tests; defaults to the real note IPC client (save-reply-as-note). */
  noteClient?: Pick<NotesApi, 'addWithContent'>;
  /** Called after a reply is saved as a note, so the canvas can refresh (M03.D). */
  onNotesChanged?(): void;
  /** Injectable for tests; defaults to the real usage IPC client (passive counter, M06.D). */
  usageClient?: UsageClient;
  /** Injectable for tests; defaults to the real provider-scoped model catalog. */
  catalogClient?: CatalogClient;
  /** The chat scroll offset to restore for this session (F8; owned by LLMPanel above the remount). */
  initialScrollTop?: number;
  /** Report the chat scroll offset so the owner can persist + restore it per session (F8). */
  onScrollChange?(top: number): void;
  /** Injectable for tests; defaults to the real gen-events client. The usage counter subscribes to
   *  the app-wide gen:run-ended event through this (M08.C — sole generation-refresh trigger). */
  genEventsClient?: GenEventsClient;
}

// Compact token abbreviation for the passive counter — 1–3 significant figures with a k/M suffix
// (e.g. 340, 5.6k, 12.3k, 123k, 1.2M). Keeps the two-row layout from wrapping at the panel width.
// Readability only — the underlying token totals are unchanged.
function abbreviateTokens(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  const [value, suffix] = n < 1_000_000 ? [n / 1000, 'k'] : [n / 1_000_000, 'M'];
  // One decimal below 100 (1.2k, 12.3k), whole numbers at/above it (123k) — 1–3 sig figs.
  const text = value < 100 ? value.toFixed(1) : Math.round(value).toString();
  return `${text.replace(/\.0$/, '')}${suffix}`;
}

// Cost for one rollup window (conservative split — never a wrong number): the priced cost, plus an
// honest "+N unpriced" note when some calls are on models with unknown pricing, or "cost unknown"
// when EVERY contributing call is unpriced.
function costLabel(costUsd: number, unpricedCalls: number): string {
  if (unpricedCalls > 0 && costUsd === 0) {
    return 'cost unknown';
  }
  const cost = `$${costUsd.toFixed(costUsd < 0.01 ? 4 : 2)}`;
  return unpricedCalls > 0 ? `${cost} +${unpricedCalls} unpriced` : cost;
}

// One window's value string: "12.3k in · 1.2M out · $0.04" (or "… · cost unknown").
function usageValueLine(totals: {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  unpricedCalls: number;
}): string {
  return `${abbreviateTokens(totals.inputTokens)} in · ${abbreviateTokens(totals.outputTokens)} out · ${costLabel(totals.costUsd, totals.unpricedCalls)}`;
}

// AUTH / NO_KEY are fixed by re-entering the key; the rest are transient and retryable.
function isKeyError(code: string): boolean {
  return code === 'AUTH' || code === 'NO_KEY';
}

// The whole exchange is saved, not just the bare reply (product-owner add) — so a
// saved note reads as a self-contained Q+A the white-paper/minutes generation (M04)
// can build on. The responding model is recorded too, so the note shows which model
// answered.
function formatExchange(message: ChatMessage): string {
  const exchange = `**Q:** ${message.question ?? ''}\n\n**A:** ${message.text}`;
  return message.model ? `${exchange}\n\n_Answered by ${modelLabel(message.model)}._` : exchange;
}

/*
 * The session-grounded chat (M03.C; M03.D adds the model picker, per-code error
 * affordances, and save-reply-as-note). Renders the conversation as streamed
 * bubbles, with a composer to ask about the current session. Grounding is assembled
 * main-side from the session's notes; this panel holds no key and no SDK — it only
 * talks to the typed `llm`/`note` clients. Mount it keyed by session id (see
 * LLMPanel) so switching sessions starts a fresh conversation.
 */
export function ChatPanel({
  sessionId,
  client = llmClient,
  model,
  onModelChange,
  onOpenSettings,
  noteClient = defaultNoteClient,
  onNotesChanged,
  usageClient = defaultUsageClient,
  catalogClient,
  initialScrollTop,
  onScrollChange,
  genEventsClient = defaultGenEventsClient,
}: ChatPanelProps): ReactElement {
  const options: UseChatOptions = model ? { client, model } : { client };
  const { messages, isStreaming, error, send, retry } = useChat(sessionId, options);
  const elapsedMs = useElapsed(isStreaming);
  const toasts = useToasts();
  const { surface } = useMutationToast();
  const { models, status: catalogStatus, refresh: refreshModels } = useModelCatalog(catalogClient);
  const { summary, refresh: refreshUsage } = useUsageCounter(
    sessionId,
    usageClient,
    genEventsClient,
  );
  const [draft, setDraft] = useState('');
  const [savedIds, setSavedIds] = useState<readonly string[]>([]);
  const scrollAnchorRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const wasStreaming = useRef(false);
  // Sticky auto-follow state: whether the view is at/near the bottom (so a streaming reply keeps
  // it pinned) and a one-shot flag set on send (bring the just-asked question to the top once).
  const nearBottomRef = useRef(true);
  const pendingUserScrollRef = useRef(false);

  // M06.D post-IRL #2 — sticky streaming auto-follow (M06.A; F8). Keep the view pinned to the
  // newest content as a reply streams ONLY while the user is at/near the bottom — read from the
  // `nearBottomRef` SENSOR, which is recomputed on scroll events (user scrolls AND the programmatic
  // follow/park scrolls below). Do NOT recompute here from post-chunk geometry: a just-appended
  // chunk grows scrollHeight before scrollTop catches up, so a live read reports "not near bottom"
  // and follow would stop forever (validated in the Playwright e2e; jsdom's zero geometry hid it).
  useEffect(() => {
    if (isStreaming && nearBottomRef.current && !pendingUserScrollRef.current) {
      scrollAnchorRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [messages, isStreaming]);

  // M06.D post-IRL #2 — on send, scroll the just-asked question to the TOP of the view (so the user
  // reads their question with the reply growing beneath it), once per send. Gated on the pending
  // flag so hydration / streaming re-renders never trigger it. Then SYNCHRONOUSLY refresh the
  // sensor from the parked position (scrollIntoView updates scrollTop synchronously): a short reply
  // that fits leaves us near the bottom → it keeps following; a long reply leaves us far from the
  // bottom → parked at the question until the user scrolls down.
  useEffect(() => {
    if (!pendingUserScrollRef.current) {
      return;
    }
    pendingUserScrollRef.current = false;
    const userId = [...messages].reverse().find((m) => m.role === 'user')?.id;
    const el = messagesRef.current;
    if (userId && el) {
      el.querySelector(`[data-message-id="${userId}"]`)?.scrollIntoView({ block: 'start' });
      nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    }
  }, [messages]);

  // F8 scroll retention (M06.A carry → M06.D, now that the thread persists): restore the saved
  // offset for this session ONCE, after hydration populates the thread. The owner (LLMPanel) holds
  // the per-session offsets above the session-keyed remount and persists them, so switching away
  // and back lands where you left off. It must fire ONCE — re-applying on every new message would
  // clobber the on-send scroll + the streaming auto-follow on every turn (post-IRL #2 regression).
  const restoredScrollRef = useRef(false);
  useEffect(() => {
    if (restoredScrollRef.current || messagesRef.current === null) {
      return;
    }
    if (typeof initialScrollTop === 'number') {
      messagesRef.current.scrollTop = initialScrollTop;
      restoredScrollRef.current = true;
    }
  }, [initialScrollTop, messages.length]);

  // Refresh the passive usage counter when a turn finishes (streaming false after being true) so
  // the just-recorded spend appears without a reload.
  useEffect(() => {
    if (wasStreaming.current && !isStreaming) {
      refreshUsage();
    }
    wasStreaming.current = isStreaming;
  }, [isStreaming, refreshUsage]);

  // Generation-run refresh is handled inside useUsageCounter via the app-wide gen:run-ended event
  // (M08.C) — no modal-mounted prop relay, so a background finish refreshes even with the doc modal
  // closed. This panel only drives the chat-turn refresh (above).

  // The slow-reply reassurance (M07.B; F24): a transient app-level toast that appears once
  // the stream runs past the hint threshold and clears the moment it settles.
  const { show, dismiss } = toasts;
  useEffect(() => {
    if (isStreaming && elapsedMs >= HINT_AFTER_MS) {
      show({
        key: 'chat-slow',
        variant: 'progress',
        message: 'Still working — the assistant is thinking…',
        durationMs: null,
      });
    } else {
      dismiss('chat-slow');
    }
  }, [isStreaming, elapsedMs, show, dismiss]);

  // Stale / out-of-catalog selection guard: if the persisted chat model isn't in the active catalog
  // (a raw gateway id saved by an older build, or after the gateway curation changed), snap to a
  // valid option and persist it — so the dropdown never displays one model while SENDING another, and
  // main never silently defaults the pick (audit bugs 1+2). Fires once: the snapped id is in the
  // catalog, so it won't re-fire.
  useEffect(() => {
    if (
      catalogStatus === 'ready' &&
      model &&
      models.length > 0 &&
      !models.some((option) => option.id === model)
    ) {
      const preferred = models.find((option) => option.id === DEFAULT_CHAT_MODEL) ?? models[0];
      if (preferred) {
        onModelChange?.(preferred.id);
      }
    }
  }, [catalogStatus, model, models, onModelChange]);

  const handleRefreshModels = async (): Promise<void> => {
    const ok = await refreshModels();
    show({
      variant: ok ? 'info' : 'error',
      message: ok ? 'Model list refreshed.' : "Couldn't refresh the model list.",
    });
  };

  const selectedModel = model ?? DEFAULT_CHAT_MODEL;
  const canSend = draft.trim().length > 0 && !isStreaming;

  const submit = (): void => {
    if (!canSend) {
      return;
    }
    // Bring the just-asked question to the top of the view once it's appended (post-IRL #2).
    pendingUserScrollRef.current = true;
    send(draft);
    setDraft('');
  };

  // Track how close the view is to the bottom so streaming can follow stickily; also report the
  // offset up for F8 per-session scroll retention (unchanged).
  const handleMessagesScroll = (event: { currentTarget: HTMLDivElement }): void => {
    const el = event.currentTarget;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    onScrollChange?.(el.scrollTop);
  };

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault();
    submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends; Shift+Enter inserts a newline (composing a multi-line question).
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const saveToNotes = async (message: ChatMessage): Promise<void> => {
    const saved = await surface(
      () => noteClient.addWithContent(sessionId, formatExchange(message)),
      "Couldn't save the reply as a note.",
    );
    if (saved === undefined) {
      return; // the failure was surfaced; don't mark it saved
    }
    setSavedIds((prev) => (prev.includes(message.id) ? prev : [...prev, message.id]));
    // Tell the canvas to refresh so the saved Q+A note appears without a session switch.
    onNotesChanged?.();
  };

  return (
    <div className="chat-panel" data-testid="chat-panel">
      <div className="chat-toolbar">
        <label className="chat-model-label" htmlFor="chat-model">
          Model
        </label>
        <select
          id="chat-model"
          className="chat-model-select"
          aria-label="Chat model"
          value={selectedModel}
          onChange={(event) => onModelChange?.(event.target.value)}
        >
          {models.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        {/* Manual catalog refresh (ADR-0021) — the list is cached + auto-refreshed on a TTL; this
            re-fetches the current models on demand. */}
        <button
          type="button"
          className="btn-icon chat-model-refresh"
          aria-label="Refresh model list"
          title="Refresh model list"
          aria-busy={catalogStatus === 'refreshing'}
          disabled={catalogStatus === 'refreshing'}
          data-refreshing={catalogStatus === 'refreshing' ? 'true' : 'false'}
          onClick={() => void handleRefreshModels()}
        >
          <span className="chat-model-refresh-icon" aria-hidden="true">
            ↻
          </span>
        </button>
      </div>

      <div
        ref={messagesRef}
        className="chat-messages"
        role="log"
        aria-label="Conversation"
        aria-live="polite"
        onScroll={handleMessagesScroll}
      >
        {messages.length === 0 && error === null && (
          <p className="chat-empty">Ask a question about this session’s notes.</p>
        )}
        {messages.map((message, index) => {
          const streamingThis = isStreaming && index === messages.length - 1;
          const saveable =
            message.role === 'assistant' && message.text.length > 0 && !streamingThis;
          const saved = savedIds.includes(message.id);
          return (
            <div
              key={message.id}
              data-message-id={message.id}
              className={`chat-message chat-message-${message.role}`}
            >
              <div className="chat-message-text">{message.text}</div>
              {message.role === 'assistant' && message.model !== undefined && (
                <div className="chat-message-meta">
                  <span className="chat-model-badge">{modelLabel(message.model)}</span>
                  {saveable && (
                    <button
                      type="button"
                      className="chat-save"
                      onClick={() => void saveToNotes(message)}
                      disabled={saved}
                    >
                      {saved ? 'Saved ✓' : 'Save to notes'}
                    </button>
                  )}
                </div>
              )}
              {message.role === 'assistant' && message.model === undefined && saveable && (
                <button
                  type="button"
                  className="chat-save"
                  onClick={() => void saveToNotes(message)}
                  disabled={saved}
                >
                  {saved ? 'Saved ✓' : 'Save to notes'}
                </button>
              )}
            </div>
          );
        })}
        {error !== null && (
          <div className="chat-error" role="alert">
            <p className="chat-error-message">{error.message}</p>
            {isKeyError(error.code) ? (
              <button
                type="button"
                className="btn btn-secondary chat-error-action"
                onClick={() => onOpenSettings?.()}
              >
                Open Settings
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-secondary chat-error-action"
                onClick={() => retry()}
              >
                Retry
              </button>
            )}
          </div>
        )}
        <div ref={scrollAnchorRef} className="chat-scroll-anchor" aria-hidden="true" />
      </div>

      <form className="chat-composer" onSubmit={handleSubmit}>
        <textarea
          className="chat-input"
          aria-label="Ask Claude about this session"
          placeholder="Ask about this session…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isStreaming}
          rows={2}
        />
        <button
          type="submit"
          className="btn btn-primary chat-send"
          aria-label="Send message"
          disabled={!canSend}
        >
          Send
        </button>
      </form>

      {/* Passive usage counter (M06.D, ADR-0021/0022/0024): two TODAY-windowed rows of REAL token
          usage — this session today + all sessions today, across every kind (chat + generation) —
          with config-driven cost. No cap, no alert — visibility only. A compact two-row,
          label-aligned layout that scans at a glance and doesn't wrap at the panel width. */}
      <dl className="chat-usage" aria-label="Token usage">
        <div className="chat-usage-row" data-testid="chat-usage-session-today">
          <dt className="chat-usage-label">This session · today</dt>
          <dd className="chat-usage-value">{usageValueLine(summary.sessionToday)}</dd>
        </div>
        <div className="chat-usage-row" data-testid="chat-usage-all-today">
          <dt className="chat-usage-label">All sessions · today</dt>
          <dd className="chat-usage-value">{usageValueLine(summary.allToday)}</dd>
        </div>
      </dl>
    </div>
  );
}
