// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { AppApi } from '@shared/api';
import type { AppCommand } from '@shared/types';
import type { AssetsApi, NotesApi, SessionApi, SettingsApi } from '@shared/api';
import type { Session } from '@shared/types';

import { App } from '../../src/App';

/*
 * Desktop shortcuts (M06.A; REVIEW-V11 F6/F8). Ctrl/Cmd+F focuses the cross-session search
 * input; Ctrl/Cmd+N starts a new session. The native menu's Find / New Session items service
 * the SAME behavior through the app:command bridge (the menu does not register the
 * accelerators — the renderer owns the keypress, so there is no double-fire).
 */
function fakeNotes(): NotesApi {
  const note = { id: 'n1', sessionId: 's', content: '', createdAt: 1, updatedAt: 1 };
  return {
    add: () => Promise.resolve(note),
    addWithContent: () => Promise.resolve(note),
    list: () => Promise.resolve([]),
    update: () => Promise.resolve(note),
    updateSync: () => note,
    delete: () => Promise.resolve(),
    reorder: () => Promise.resolve(),
  };
}

function fakeAssets(): AssetsApi {
  return {
    save: () =>
      Promise.resolve({
        id: 'a1',
        sessionId: 's',
        kind: 'upload',
        relativePath: 's/a1.png',
        createdAt: 1,
      }),
    list: () => Promise.resolve([]),
    delete: () => Promise.resolve(),
  };
}

function fakeSettings(): SettingsApi {
  return {
    setKey: () => Promise.resolve({ ok: true }),
    keyStatus: () => Promise.resolve({ hasKey: false, encryptionAvailable: true }),
    clearKey: () => Promise.resolve(),
    getPrefs: () => Promise.resolve({}),
    setPrefs: (prefs) => Promise.resolve(prefs),
    getProvider: () => Promise.resolve({ provider: 'anthropic' }),
    setProvider: (provider) => Promise.resolve(provider),
  };
}

function fakeClient(initial: ReadonlyArray<[string, string]> = []): SessionApi {
  let seq = 0;
  const rows: Session[] = initial.map(([id, name]) => {
    seq += 1;
    return { id, spaceId: 'space-default', name, createdAt: seq, updatedAt: seq };
  });
  return {
    create: (name) => {
      seq += 1;
      const created: Session = {
        id: `s${seq}`,
        spaceId: 'space-default',
        name,
        createdAt: seq,
        updatedAt: seq,
      };
      rows.unshift(created);
      return Promise.resolve(created);
    },
    list: () => Promise.resolve([...rows].sort((a, b) => b.updatedAt - a.updatedAt)),
    get: (id) => Promise.resolve(rows.find((r) => r.id === id) ?? null),
    rename: () => Promise.resolve(),
    delete: (id) => {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
      return Promise.resolve();
    },
    deleteMany: (ids) => {
      for (const id of ids) {
        const i = rows.findIndex((r) => r.id === id);
        if (i >= 0) rows.splice(i, 1);
      }
      return Promise.resolve();
    },
  };
}

const genStatus = {
  onRunStarted: () => () => undefined,
  onRunEnded: () => () => undefined,
  onProgress: () => () => undefined,
  cancel: () => Promise.resolve(),
};

// An app-command stub the test can drive, standing in for the preload bridge.
function fakeApp(): { client: AppApi; emit(command: AppCommand): void } {
  let listener: ((command: AppCommand) => void) | null = null;
  return {
    client: {
      onCommand: (l) => {
        listener = l;
        return () => {
          listener = null;
        };
      },
      onFullScreenChange: () => () => undefined,
      exitFullScreen: () => undefined,
    },
    emit: (command) => listener?.(command),
  };
}

function renderApp(extra: Partial<Parameters<typeof App>[0]> = {}) {
  return render(
    <App
      client={fakeClient()}
      noteClient={fakeNotes()}
      assetClient={fakeAssets()}
      settingsClient={fakeSettings()}
      genStatusClient={genStatus}
      {...extra}
    />,
  );
}

describe('App desktop shortcuts', () => {
  it('focuses the search input on Ctrl+F', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('button', { name: /new session/i });

    await user.keyboard('{Control>}f{/Control}');

    expect(screen.getByRole('searchbox', { name: /search all sessions/i })).toHaveFocus();
  });

  it('creates a session on Ctrl+N', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole('button', { name: /new session/i });

    await user.keyboard('{Control>}n{/Control}');

    expect(await screen.findByRole('button', { name: 'Untitled session' })).toBeInTheDocument();
  });

  it('focuses search when the native menu fires app:command "find"', async () => {
    const app = fakeApp();
    renderApp({ appClient: app.client });
    await screen.findByRole('button', { name: /new session/i });

    act(() => app.emit('find'));

    await waitFor(() =>
      expect(screen.getByRole('searchbox', { name: /search all sessions/i })).toHaveFocus(),
    );
  });

  it('creates a session when the native menu fires app:command "new-session"', async () => {
    const app = fakeApp();
    renderApp({ appClient: app.client });
    await screen.findByRole('button', { name: /new session/i });

    act(() => app.emit('new-session'));

    expect(await screen.findByRole('button', { name: 'Untitled session' })).toBeInTheDocument();
  });
});
