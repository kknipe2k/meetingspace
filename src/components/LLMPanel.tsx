import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import { DEFAULT_CHAT_MODEL } from '@shared/models';
import type { Session } from '@shared/types';

import { useMutationToast } from '../hooks/useMutationToast';
import { settingsClient, type SettingsClient } from '../ipc/client';

import { ChatPanel } from './ChatPanel';
import { EmptyState } from './EmptyState';
import { GeneratedDocView } from './GeneratedDocView';
import { Modal } from './Modal';
import { SettingsModal } from './SettingsModal';

export interface LLMPanelProps {
  /** The selected session to chat about; null shows the no-session prompt. */
  session?: Session | null;
  /** Injectable for tests; defaults to the real settings IPC client. */
  settingsClient?: SettingsClient;
  /** Responsive drawer open state (TD-003); CSS only acts on it below ~960px. */
  drawerOpen?: boolean;
  /** Bubbled up when a chat reply is saved as a note, so the canvas refreshes (M03.D). */
  onNotesChanged?(): void;
  /** Resolves a session id to its name — the busy toast names the LIVE run's session,
   *  which may not be the open one (M07.C single build slot; App passes the list). */
  sessionName?(sessionId: string): string | undefined;
}

export function LLMPanel({
  session = null,
  settingsClient: settings = settingsClient,
  drawerOpen = false,
  onNotesChanged,
  sessionName,
}: LLMPanelProps): ReactElement {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [docOpen, setDocOpen] = useState(false);
  // Bumped when a generation run completes, signalling the (app-wide) chat usage counter to refresh
  // so generation spend appears without a reload (ADR-0022).
  const [usageToken, setUsageToken] = useState(0);
  // One app-wide model selection drives both chat and document generation. Legacy per-surface
  // preferences are read as a migration fallback, but every new change writes selectedModel.
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_CHAT_MODEL);
  const { surface } = useMutationToast();

  // F8 chat scroll retention (M06.A carry → M06.D). The per-session offsets live HERE, above the
  // session-keyed ChatPanel remount, so switching away and back restores the scroll position; they
  // are persisted to prefs so they also survive a reload. Live updates write the ref (no re-render
  // per scroll); the debounced setPrefs persists the map.
  const chatScrollRef = useRef<Record<string, number>>({});
  const scrollSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped after prefs load so the (session-keyed) ChatPanel re-receives its restored scroll offset
  // even when no model pref was stored. Live scroll updates write the ref only (no re-render).
  const [, setPrefsLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    void settings.getPrefs().then((prefs) => {
      if (!active) {
        return;
      }
      const storedModel = prefs.selectedModel ?? prefs.chatModel ?? prefs.generationModel;
      if (storedModel) {
        setSelectedModel(storedModel);
      }
      if (prefs.chatScroll) {
        chatScrollRef.current = { ...prefs.chatScroll };
      }
      setPrefsLoaded(true);
    });
    return () => {
      active = false;
    };
  }, [settings]);

  const handleChatScroll = useCallback(
    (id: string, top: number): void => {
      chatScrollRef.current = { ...chatScrollRef.current, [id]: top };
      if (scrollSaveTimer.current) {
        clearTimeout(scrollSaveTimer.current);
      }
      // Debounced persist — a scroll save failing is a nicety, not data, but it routes through
      // surface() like the other prefs writes (mutation-surfacing guard).
      scrollSaveTimer.current = setTimeout(() => {
        void surface(
          () => settings.setPrefs({ chatScroll: chatScrollRef.current }),
          "Couldn't save your place in the chat.",
        );
      }, 500);
    },
    [settings, surface],
  );

  const handleModelChange = useCallback(
    (model: string): void => {
      setSelectedModel(model);
      void surface(
        () => settings.setPrefs({ selectedModel: model }),
        "Couldn't save your model preference.",
      );
    },
    [settings, surface],
  );

  return (
    <section
      className="zone zone-llm-panel"
      data-testid="zone-llm-panel"
      data-drawer={drawerOpen ? 'open' : 'closed'}
      aria-label="Assistant"
    >
      <div className="zone-llm-header">
        <h2 className="zone-heading">Assistant</h2>
        <div className="zone-llm-actions">
          {session && (
            <button
              type="button"
              className="btn btn-secondary llm-whitepaper-btn"
              onClick={() => setDocOpen(true)}
            >
              White paper
            </button>
          )}
          <button
            type="button"
            className="btn-icon"
            aria-label="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="3.25" stroke="currentColor" strokeWidth="1.6" />
              <path
                d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9 5.3 5.3"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </div>
      {session ? (
        <ChatPanel
          key={session.id}
          sessionId={session.id}
          model={selectedModel}
          onModelChange={handleModelChange}
          onOpenSettings={() => setSettingsOpen(true)}
          onScrollChange={(top) => handleChatScroll(session.id, top)}
          usageRefreshKey={usageToken}
          {...(typeof chatScrollRef.current[session.id] === 'number'
            ? { initialScrollTop: chatScrollRef.current[session.id] }
            : {})}
          {...(onNotesChanged ? { onNotesChanged } : {})}
        />
      ) : (
        <EmptyState
          className="llm-empty"
          headline="No session selected"
          hint="Pick a session to chat about it or generate a document."
        />
      )}

      {settingsOpen && <SettingsModal client={settings} onClose={() => setSettingsOpen(false)} />}

      {docOpen && session && (
        <Modal
          label="White paper"
          className="generated-doc-modal"
          onClose={() => setDocOpen(false)}
        >
          <div className="generated-doc-header">
            <h2 className="generated-doc-title">White paper — {session.name}</h2>
            <button
              type="button"
              className="btn-icon"
              aria-label="Close white paper"
              onClick={() => setDocOpen(false)}
            >
              ✕
            </button>
          </div>
          <GeneratedDocView
            key={session.id}
            sessionId={session.id}
            generationModel={selectedModel}
            onGenerationModelChange={handleModelChange}
            onGenerationComplete={() => setUsageToken((t) => t + 1)}
            {...(sessionName ? { sessionName } : {})}
          />
        </Modal>
      )}
    </section>
  );
}
