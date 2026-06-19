import { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from 'react';

import type { Session } from '@shared/types';

import { FullScreenToast } from './components/FullScreenToast';
import { GenerationStatusToast, type GenStatusClient } from './components/GenerationStatusToast';
import { LLMPanel } from './components/LLMPanel';
import { Onboarding } from './components/Onboarding';
import { SandboxProbe } from './components/SandboxProbe';
import { SessionCanvas } from './components/SessionCanvas';
import { Sidebar } from './components/Sidebar';
import { SidebarResizer } from './components/SidebarResizer';
import { SIDEBAR_DEFAULT_WIDTH, clampSidebarWidth } from './components/sidebar-width';
import { StorageNudge } from './components/StorageNudge';
import { ToastHost } from './components/ToastHost';
import { shouldShowOnboarding } from './onboarding-gate';
import { useDeferredDelete } from './hooks/useDeferredDelete';
import { useMutationToast } from './hooks/useMutationToast';
import { ToastProvider } from './hooks/useToasts';
import { useTheme } from './hooks/useTheme';
import {
  appClient as defaultAppClient,
  assetClient,
  captureClient,
  genClient,
  noteClient,
  sessionClient,
  settingsClient,
  type AppClient,
  type AssetClient,
  type CaptureClient,
  type NoteClient,
  type SearchClient,
  type SessionClient,
  type SettingsClient,
} from './ipc/client';

const DEFAULT_SESSION_NAME = 'Untitled session';

/*
 * Re-insert deferred-deleted session(s) back into the live list on Undo / a failed delete, keeping
 * the same order the store lists them in (updated_at DESC, id DESC — see SessionStore.listSessions).
 * Skips any already present, so concurrent deferred deletes restore independently (M06.B IRL fix).
 */
function reinsertSessions(current: Session[], removed: Session[]): Session[] {
  const present = new Set(current.map((session) => session.id));
  const merged = [...current, ...removed.filter((session) => !present.has(session.id))];
  return merged.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1));
}

// E2E-only: the sandbox probe mounts when the renderer is loaded with `?probe=1`,
// which main.ts adds only under MEETINGSPACE_SANDBOX_PROBE=1 + !app.isPackaged
// (structurally unreachable in a shipped build). See SandboxProbe.
function isSandboxProbeRequested(): boolean {
  return new URLSearchParams(window.location.search).get('probe') === '1';
}

export interface AppProps {
  client?: SessionClient;
  noteClient?: NoteClient;
  assetClient?: AssetClient;
  captureClient?: CaptureClient;
  settingsClient?: SettingsClient;
  searchClient?: SearchClient;
  /** The run-lifecycle slice for the app-level run toast; defaults to the real gen client. */
  genStatusClient?: GenStatusClient;
  /** Native-menu command source (Find / New Session); defaults to the real app client. */
  appClient?: AppClient;
}

/** Session-list load lifecycle (M05.A) — drives the sidebar loading / empty / error state. */
export type ListStatus = 'loading' | 'ready' | 'error';

/*
 * App is a thin shell that establishes the ToastProvider; AppContent holds the real surface so its
 * mutation/deferred-delete/toast hooks (M06.B) resolve the live toast context rather than the
 * no-op default (which they would if they ran in the same component that renders the provider).
 */
export function App(props: AppProps): ReactElement {
  return (
    <ToastProvider>
      <AppContent {...props} />
    </ToastProvider>
  );
}

function AppContent({
  client = sessionClient,
  noteClient: notes = noteClient,
  assetClient: assets = assetClient,
  captureClient: capture = captureClient,
  settingsClient: settings = settingsClient,
  searchClient: search,
  genStatusClient = genClient,
  appClient = defaultAppClient,
}: AppProps): ReactElement {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Bumped to focus the cross-session search input — by Ctrl/Cmd+F or the menu's Find (F6).
  const [searchFocusSignal, setSearchFocusSignal] = useState(0);
  // Bumped when the chat panel saves a reply as a note, so the canvas re-fetches
  // and the new Q+A note appears without a session switch (M03.D).
  const [notesReloadToken, setNotesReloadToken] = useState(0);
  // Session-list load status (M05.A): the initial load + the error-state Retry track it;
  // post-mutation re-lists (create/rename/delete) reuse `refresh` and stay in 'ready'.
  const [listStatus, setListStatus] = useState<ListStatus>('loading');
  // Responsive panel-collapse (TD-003): below ~960px the assistant panel is an overlay
  // drawer toggled here; above the threshold this state is inert (CSS keeps the panel open).
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Bulk-delete multi-select (M06.B): selection mode is OFF by default so titles stay readable
  // (IRL fix); `selectedIds` is the checked set while selecting.
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  // Resizable left column (M06.B IRL request): width loads from prefs on mount and persists on
  // resize, so the column geometry survives relaunch like the window state.
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  // First-run onboarding (M06.E): shown once when there's no credential and the seen flag isn't
  // set. `null` until the mount check resolves so the overlay never flashes for a returning user.
  const [showOnboarding, setShowOnboarding] = useState<boolean | null>(null);
  const { surface } = useMutationToast();
  const { remove: deferRemove } = useDeferredDelete();

  // The initial load (and the error-state Retry): surfaces loading → ready / error.
  const load = useCallback(async (): Promise<void> => {
    setListStatus('loading');
    try {
      setSessions(await client.list());
      setListStatus('ready');
    } catch {
      setListStatus('error');
    }
  }, [client]);

  // A silent re-list after a mutation (the list is already on screen — no loading flash).
  const refresh = useCallback(async (): Promise<void> => {
    setSessions(await client.list());
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  // Load the persisted sidebar width once on mount.
  useEffect(() => {
    let active = true;
    void settings.getPrefs().then((prefs) => {
      if (active && typeof prefs.sidebarWidth === 'number') {
        setSidebarWidth(clampSidebarWidth(prefs.sidebarWidth));
      }
    });
    return () => {
      active = false;
    };
  }, [settings]);

  // Decide the first-run overlay once on mount: no saved credential AND onboarding never seen.
  useEffect(() => {
    let active = true;
    void (async () => {
      const [status, prefs] = await Promise.all([settings.keyStatus(), settings.getPrefs()]);
      if (active) {
        setShowOnboarding(shouldShowOnboarding(prefs, status.hasKey));
      }
    })();
    return () => {
      active = false;
    };
  }, [settings]);

  // Live drag (state only) vs. commit (persist) so a drag doesn't spam setPrefs.
  const handleSidebarResize = useCallback((width: number): void => {
    setSidebarWidth(clampSidebarWidth(width));
  }, []);
  const handleSidebarResizeCommit = useCallback(
    (width: number): void => {
      const clamped = clampSidebarWidth(width);
      setSidebarWidth(clamped);
      void surface(
        () => settings.setPrefs({ sidebarWidth: clamped }),
        "Couldn't save the sidebar width.",
      );
    },
    [settings, surface],
  );

  const handleCreate = useCallback(async (): Promise<void> => {
    const created = await surface(
      () => client.create(DEFAULT_SESSION_NAME),
      "Couldn't create the session.",
    );
    if (!created) {
      return;
    }
    setSelectedId(created.id);
    await refresh();
  }, [client, refresh, surface]);

  const handleRename = useCallback(
    async (id: string, name: string): Promise<void> => {
      const ok = await surface(
        () => client.rename(id, name).then(() => true),
        "Couldn't rename the session.",
      );
      if (!ok) {
        return;
      }
      await refresh();
    },
    [client, refresh, surface],
  );

  // Single-session delete is deferred (F10): remove optimistically + offer Undo; the real delete
  // fires when the grace window elapses. Restore re-inserts ONLY the affected session(s) (not a
  // whole-list snapshot) so several concurrent deferred deletes each undo independently — undoing
  // one never resurrects another that is still pending. The named label disambiguates stacked
  // undo toasts.
  const handleDelete = useCallback(
    (id: string): void => {
      const removed = sessions.find((session) => session.id === id);
      if (!removed) {
        return;
      }
      setSessions((prev) => prev.filter((session) => session.id !== id));
      setSelectedId((current) => (current === id ? null : current));
      deferRemove({
        key: `session-del-${id}`,
        label: `Deleted “${removed.name}”`,
        errorMessage: "Couldn't delete the session.",
        commit: () => client.delete(id),
        restore: () => setSessions((prev) => reinsertSessions(prev, [removed])),
      });
    },
    [client, deferRemove, sessions],
  );

  const handleToggleSelect = useCallback((id: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleClearSelection = useCallback((): void => setSelectedIds(new Set()), []);

  // Toggle selection mode; leaving it clears any checked sessions.
  const handleToggleSelecting = useCallback((): void => {
    setSelecting((on) => {
      if (on) {
        setSelectedIds(new Set());
      }
      return !on;
    });
  }, []);

  // Bulk delete is deferred too: optimistic removal of the selected set, one deleteMany on commit.
  const handleDeleteSelected = useCallback((): void => {
    const ids = [...selectedIds];
    if (ids.length === 0) {
      return;
    }
    const removing = selectedIds;
    const removed = sessions.filter((session) => removing.has(session.id));
    setSessions((prev) => prev.filter((session) => !removing.has(session.id)));
    setSelectedId((current) => (current && removing.has(current) ? null : current));
    setSelectedIds(new Set());
    deferRemove({
      key: 'session-del-bulk',
      label: `${ids.length} session${ids.length === 1 ? '' : 's'} deleted`,
      errorMessage: "Couldn't delete the selected sessions.",
      commit: () => client.deleteMany(ids),
      restore: () => setSessions((prev) => reinsertSessions(prev, removed)),
    });
  }, [client, deferRemove, selectedIds, sessions]);

  // Appearance preference (M06.A IRL fix): System (default, OS-driven) / Light / Dark.
  const { setPreference } = useTheme(settings);

  const focusSearch = useCallback((): void => setSearchFocusSignal((token) => token + 1), []);

  // Desktop keyboard shortcuts (M06.A; F6/F8): Ctrl/Cmd+F focuses search, Ctrl/Cmd+N starts a
  // session. The native menu's Find / New Session items carry these accelerators as LABELS but
  // do not register them (electron/menu.ts), so the renderer owns the keypress — no double-fire.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 'f') {
        event.preventDefault();
        focusSearch();
      } else if (key === 'n') {
        event.preventDefault();
        void handleCreate();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [focusSearch, handleCreate]);

  // The native menu's Find / New Session mouse clicks arrive over app:command — service them
  // through the same handlers as the keyboard shortcuts.
  useEffect(() => {
    return appClient.onCommand((command) => {
      if (command === 'find') {
        focusSearch();
      } else if (command === 'new-session') {
        void handleCreate();
      } else if (
        command === 'theme:system' ||
        command === 'theme:light' ||
        command === 'theme:dark'
      ) {
        setPreference(command.slice('theme:'.length) as 'system' | 'light' | 'dark');
      }
    });
  }, [appClient, focusSearch, handleCreate, setPreference]);

  const selected = sessions.find((session) => session.id === selectedId) ?? null;

  return (
    <>
      <div
        className={drawerOpen ? 'app-shell app-shell--drawer-open' : 'app-shell'}
        style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
      >
        <SidebarResizer
          width={sidebarWidth}
          onResize={handleSidebarResize}
          onCommit={handleSidebarResizeCommit}
        />
        <Sidebar
          sessions={sessions}
          selectedId={selectedId}
          status={listStatus}
          onRetry={() => void load()}
          onSelect={setSelectedId}
          onCreate={() => void handleCreate()}
          onRename={(id, name) => void handleRename(id, name)}
          onDelete={(id) => handleDelete(id)}
          searchFocusSignal={searchFocusSignal}
          selecting={selecting}
          onToggleSelecting={handleToggleSelecting}
          selectedIds={selectedIds}
          onToggleSelect={handleToggleSelect}
          onDeleteSelected={handleDeleteSelected}
          onClearSelection={handleClearSelection}
          {...(search ? { searchClient: search } : {})}
        />
        <SessionCanvas
          session={selected}
          noteClient={notes}
          assetClient={assets}
          captureClient={capture}
          notesReloadToken={notesReloadToken}
          onCreateSession={() => void handleCreate()}
        />
        <LLMPanel
          session={selected}
          settingsClient={settings}
          drawerOpen={drawerOpen}
          onNotesChanged={() => setNotesReloadToken((token) => token + 1)}
          sessionName={(id) => sessions.find((session) => session.id === id)?.name}
        />
        {/* Responsive collapse (TD-003): the drawer toggle, shown by CSS only below ~960px. */}
        <button
          type="button"
          className="assistant-toggle"
          aria-label="Toggle assistant panel"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen((open) => !open)}
        >
          Assistant
        </button>
        {isSandboxProbeRequested() && <SandboxProbe />}
      </div>
      {/* App-level run-status toast (M07.B): persists across modal open/close, fed by
          main-side run lifecycle; names the session so background runs are attributable. */}
      <GenerationStatusToast
        client={genStatusClient}
        sessionName={(id) => sessions.find((session) => session.id === id)?.name}
      />
      {/* Full-screen exit affordance (M06.A IRL fix): the menu bar hides in full screen, so a
          persistent toast with an Exit control is the visible way out. */}
      <FullScreenToast client={appClient} />
      {/* Storage threshold nudge (M06.B / F28): one info toast if usage has crossed the threshold. */}
      <StorageNudge />
      {/* First-run onboarding (M06.E): API key setup + a seeded sample space; appears once. */}
      {showOnboarding === true && (
        <Onboarding
          settingsClient={settings}
          sessionClient={client}
          noteClient={notes}
          onComplete={() => {
            setShowOnboarding(false);
            void load();
          }}
        />
      )}
      <ToastHost />
    </>
  );
}
