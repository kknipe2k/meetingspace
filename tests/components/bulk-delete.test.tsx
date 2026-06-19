// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AppApi,
  AssetsApi,
  CaptureApi,
  NotesApi,
  SearchApi,
  SessionApi,
  SettingsApi,
} from '@shared/api';
import type { Prefs, Session } from '@shared/types';

import { App } from '../../src/App';
import { Sidebar } from '../../src/components/Sidebar';

/*
 * Bulk session delete + deferred-delete undo (M06.B, REVIEW-V11 §4 + F10). The Sidebar grows a
 * checkbox multi-select; App deletes via deferred-delete (optimistic removal + an Undo toast; the
 * real client.deleteMany / client.delete fires only when the grace window elapses). RED pins:
 * Undo cancels the delete; a failed real delete RESTORES the removed sessions + raises a toast.
 */
function session(id: string, name: string): Session {
  return { id, spaceId: 'space-default', name, createdAt: 1, updatedAt: 1 };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Sidebar multi-select', () => {
  function setup(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) {
    const props = {
      sessions: [session('s1', 'Alpha'), session('s2', 'Beta')],
      selectedId: null as string | null,
      onSelect: vi.fn(),
      onCreate: vi.fn(),
      onRename: vi.fn(),
      onDelete: vi.fn(),
      selecting: true, // default these unit tests to selection mode
      onToggleSelecting: vi.fn(),
      selectedIds: new Set<string>(),
      onToggleSelect: vi.fn(),
      onDeleteSelected: vi.fn(),
      onClearSelection: vi.fn(),
      ...overrides,
    };
    render(<Sidebar {...props} />);
    return props;
  }

  it('shows no checkboxes by default (titles stay readable); "Select" enters selection mode', async () => {
    const props = setup({ selecting: false });
    expect(screen.queryByRole('checkbox', { name: /select alpha/i })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Select' }));
    expect(props.onToggleSelecting).toHaveBeenCalledTimes(1);
  });

  it('renders a selection checkbox per session in selection mode', () => {
    setup();
    expect(screen.getByRole('checkbox', { name: /select alpha/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /select beta/i })).toBeInTheDocument();
  });

  it('toggling a checkbox reports the session id', async () => {
    const props = setup();
    await userEvent.click(screen.getByRole('checkbox', { name: /select alpha/i }));
    expect(props.onToggleSelect).toHaveBeenCalledWith('s1');
  });

  it('shows a "Delete N selected" action only when something is selected', () => {
    const props = setup({ selectedIds: new Set(['s1', 's2']) });
    const del = screen.getByRole('button', { name: /delete 2 selected/i });
    fireEvent.click(del);
    expect(props.onDeleteSelected).toHaveBeenCalledTimes(1);
  });

  it('hides the bulk action when nothing is selected', () => {
    setup({ selectedIds: new Set<string>() });
    expect(screen.queryByRole('button', { name: /delete .* selected/i })).toBeNull();
  });
});

// ---- App integration -------------------------------------------------------

const GRACE_MS = 30000; // matches useDeferredDelete's default grace window

function fakeSessionClient(seed: Session[]): {
  client: SessionApi;
  deletedMany: string[][];
  deleted: string[];
  rows(): Session[];
  failNext: { value: boolean };
} {
  let rows = [...seed];
  const deletedMany: string[][] = [];
  const deleted: string[] = [];
  const failNext = { value: false };
  return {
    deletedMany,
    deleted,
    failNext,
    rows: () => rows,
    client: {
      create: (name: string) => {
        if (failNext.value) {
          failNext.value = false;
          return Promise.reject(new Error('create failed'));
        }
        const created = session(`new-${rows.length}`, name);
        rows = [created, ...rows];
        return Promise.resolve(created);
      },
      list: () => Promise.resolve([...rows]),
      get: (id: string) => Promise.resolve(rows.find((r) => r.id === id) ?? null),
      rename: (id: string, name: string) => {
        rows = rows.map((r) => (r.id === id ? { ...r, name } : r));
        return Promise.resolve();
      },
      delete: (id: string) => {
        if (failNext.value) {
          failNext.value = false;
          return Promise.reject(new Error('delete failed'));
        }
        deleted.push(id);
        rows = rows.filter((r) => r.id !== id);
        return Promise.resolve();
      },
      deleteMany: (ids: string[]) => {
        if (failNext.value) {
          failNext.value = false;
          return Promise.reject(new Error('bulk delete failed'));
        }
        deletedMany.push(ids);
        rows = rows.filter((r) => !ids.includes(r.id));
        return Promise.resolve();
      },
    } satisfies SessionApi,
  };
}

const noteClient: NotesApi = {
  add: () => Promise.resolve({ id: 'n', sessionId: 's', content: '', createdAt: 1, updatedAt: 1 }),
  addWithContent: () =>
    Promise.resolve({ id: 'n', sessionId: 's', content: '', createdAt: 1, updatedAt: 1 }),
  list: () => Promise.resolve([]),
  update: () =>
    Promise.resolve({ id: 'n', sessionId: 's', content: '', createdAt: 1, updatedAt: 1 }),
  updateSync: () => ({ id: 'n', sessionId: 's', content: '', createdAt: 1, updatedAt: 1 }),
  delete: () => Promise.resolve(),
  reorder: () => Promise.resolve(),
};
const assetClient: AssetsApi = {
  list: () => Promise.resolve([]),
  save: () =>
    Promise.resolve({
      id: 'a',
      sessionId: 's',
      kind: 'screenshot',
      relativePath: 'p',
      createdAt: 1,
    }),
  delete: () => Promise.resolve(),
};
const captureClient: CaptureApi = {
  listSources: () => Promise.resolve({ permission: 'granted', sources: [] }),
  grab: () => Promise.resolve(new Uint8Array().buffer),
};
const settingsClient: SettingsApi = {
  getPrefs: () => Promise.resolve({}),
  setPrefs: () => Promise.resolve({}),
  setKey: () => Promise.resolve({ ok: true }),
  keyStatus: () => Promise.resolve({ hasKey: false, encryptionAvailable: true }),
  clearKey: () => Promise.resolve(),
  getProvider: () => Promise.resolve({ provider: 'anthropic' }),
  setProvider: () => Promise.resolve({ provider: 'anthropic' }),
};
const searchClient: SearchApi = { notes: () => Promise.resolve([]) };
const genStatusClient = {
  onRunStarted: () => () => undefined,
  onRunEnded: () => () => undefined,
  onProgress: () => () => undefined,
  cancel: () => Promise.resolve(),
};
const appClient: AppApi = {
  onCommand: () => () => undefined,
  onFullScreenChange: () => () => undefined,
  exitFullScreen: () => undefined,
};

function renderApp(sessionFake: ReturnType<typeof fakeSessionClient>) {
  render(
    <App
      client={sessionFake.client}
      noteClient={noteClient}
      assetClient={assetClient}
      captureClient={captureClient}
      settingsClient={settingsClient}
      searchClient={searchClient}
      genStatusClient={genStatusClient}
      appClient={appClient}
    />,
  );
}

describe('App — session create failure surfaces (F15)', () => {
  it('raises an error toast when create rejects', async () => {
    const fake = fakeSessionClient([session('s1', 'Alpha')]);
    fake.failNext.value = true;
    renderApp(fake);
    await screen.findByRole('button', { name: 'Alpha' });

    await userEvent.click(screen.getByRole('button', { name: 'New session' }));

    await waitFor(() =>
      expect(
        within(screen.getByTestId('toast-host')).getByText(/couldn't create/i),
      ).toBeInTheDocument(),
    );
  });
});

describe('App — bulk delete is deferred with undo', () => {
  beforeEach(() => {
    // shouldAdvanceTime lets RTL's findBy polling proceed while still allowing explicit
    // advanceTimersByTime to jump the deferred-delete grace window.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  async function selectAndDelete(): Promise<ReturnType<typeof fakeSessionClient>> {
    const fake = fakeSessionClient([session('s1', 'Alpha'), session('s2', 'Beta')]);
    renderApp(fake);
    // Enter selection mode first (checkboxes are hidden by default so titles stay readable).
    fireEvent.click(await screen.findByRole('button', { name: 'Select' }));

    fireEvent.click(screen.getByRole('checkbox', { name: /select alpha/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /select beta/i }));
    fireEvent.click(screen.getByRole('button', { name: /delete 2 selected/i }));
    return fake;
  }

  it('removes the sessions optimistically and offers Undo without deleting yet', async () => {
    const fake = await selectAndDelete();

    expect(screen.queryByRole('button', { name: 'Alpha' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(fake.deletedMany).toHaveLength(0);
  });

  it('Undo restores the sessions and never deletes', async () => {
    const fake = await selectAndDelete();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByRole('button', { name: 'Alpha' })).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(GRACE_MS * 2));
    expect(fake.deletedMany).toHaveLength(0);
  });

  it('commits one deleteMany when the grace window elapses', async () => {
    const fake = await selectAndDelete();

    await act(async () => {
      vi.advanceTimersByTime(GRACE_MS);
    });

    expect(fake.deletedMany).toEqual([['s1', 's2']]);
  });

  it('restores the sessions and raises a toast if the real bulk delete fails (no desync)', async () => {
    const fake = await selectAndDelete();
    fake.failNext.value = true;

    await act(async () => {
      vi.advanceTimersByTime(GRACE_MS);
    });

    expect(screen.getByRole('button', { name: 'Alpha' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Beta' })).toBeInTheDocument();
    expect(
      within(screen.getByTestId('toast-host')).getByText(/couldn't delete/i),
    ).toBeInTheDocument();
  });
});

describe('App — several single deletes undo independently (IRL fix)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it('restores each session on its own Undo without resurrecting the other pending delete', async () => {
    const fake = fakeSessionClient([session('s1', 'Alpha'), session('s2', 'Beta')]);
    renderApp(fake);
    await screen.findByRole('button', { name: 'Delete Alpha' });

    // Delete both, one at a time (the per-item Delete button, not the bulk checkbox).
    fireEvent.click(screen.getByRole('button', { name: 'Delete Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Beta' }));
    expect(screen.queryByRole('button', { name: 'Alpha' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Beta' })).toBeNull();

    // Two independent Undo toasts.
    const undos = screen.getAllByRole('button', { name: 'Undo' });
    expect(undos).toHaveLength(2);

    // Undo both — each restores exactly its own session (no duplicates, no missing).
    fireEvent.click(undos[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    expect(screen.getAllByRole('button', { name: 'Alpha' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Beta' })).toHaveLength(1);

    // Neither delete committed.
    act(() => vi.advanceTimersByTime(GRACE_MS * 2));
    expect(fake.deleted).toEqual([]);
  });
});

describe('App — resizable sidebar width is loaded and persisted (IRL request)', () => {
  it('applies the stored width on mount and persists a keyboard resize', async () => {
    const setPrefsCalls: Prefs[] = [];
    const settings: SettingsApi = {
      ...settingsClient,
      getPrefs: () => Promise.resolve({ sidebarWidth: 320 }),
      setPrefs: (prefs) => {
        setPrefsCalls.push(prefs);
        return Promise.resolve(prefs);
      },
    };
    const fake = fakeSessionClient([session('s1', 'Alpha')]);
    render(
      <App
        client={fake.client}
        noteClient={noteClient}
        assetClient={assetClient}
        captureClient={captureClient}
        settingsClient={settings}
        searchClient={searchClient}
        genStatusClient={genStatusClient}
        appClient={appClient}
      />,
    );

    // The stored width is applied to the shell's CSS variable.
    await waitFor(() => {
      const shell = document.querySelector('.app-shell') as HTMLElement;
      expect(shell.style.getPropertyValue('--sidebar-width')).toBe('320px');
    });

    // A keyboard nudge on the divider persists the new width.
    fireEvent.keyDown(screen.getByRole('separator', { name: /resize sidebar/i }), {
      key: 'ArrowRight',
    });
    await waitFor(() => expect(setPrefsCalls).toContainEqual({ sidebarWidth: 336 }));
  });
});
