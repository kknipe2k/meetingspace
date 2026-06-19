// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AppApi, AssetsApi, NotesApi, SessionApi, SettingsApi } from '@shared/api';
import type { AppCommand, Prefs, Session } from '@shared/types';

import { App } from '../../src/App';

/*
 * Manual theme preference (M06.A IRL fix). A.3 shipped OS-driven dark mode only; the owner
 * asked for an explicit System / Light / Dark preference, persisted, defaulting to System
 * (so the OS-driven behavior is preserved). The renderer applies the preference as
 * `document.documentElement[data-theme]` (the CSS then overrides the OS for Light/Dark and
 * follows it for System), and persists it via settings.setPrefs.
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

function fakeSettings(prefs: Prefs = {}): {
  client: SettingsApi;
  setPrefs: ReturnType<typeof vi.fn>;
} {
  const setPrefs = vi.fn((next: Prefs) => Promise.resolve(next));
  return {
    setPrefs,
    client: {
      setKey: () => Promise.resolve({ ok: true }),
      keyStatus: () => Promise.resolve({ hasKey: false, encryptionAvailable: true }),
      clearKey: () => Promise.resolve(),
      getPrefs: () => Promise.resolve(prefs),
      setPrefs,
      getProvider: () => Promise.resolve({ provider: 'anthropic' }),
      setProvider: (provider) => Promise.resolve(provider),
    },
  };
}

function fakeClient(): SessionApi {
  return {
    create: (name) =>
      Promise.resolve({
        id: 's1',
        spaceId: 'space-default',
        name,
        createdAt: 1,
        updatedAt: 1,
      } as Session),
    list: () => Promise.resolve([]),
    get: () => Promise.resolve(null),
    rename: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    deleteMany: () => Promise.resolve(),
  };
}

const genStatus = {
  onRunStarted: () => () => undefined,
  onRunEnded: () => () => undefined,
  onProgress: () => () => undefined,
  cancel: () => Promise.resolve(),
};

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

function renderApp(settings: SettingsApi, app: AppApi) {
  return render(
    <App
      client={fakeClient()}
      noteClient={fakeNotes()}
      assetClient={fakeAssets()}
      settingsClient={settings}
      genStatusClient={genStatus}
      appClient={app}
    />,
  );
}

describe('App theme preference', () => {
  it('defaults to the System preference (OS-driven behavior preserved)', async () => {
    renderApp(fakeSettings().client, fakeApp().client);
    await screen.findByRole('button', { name: /new session/i });

    expect(document.documentElement.dataset.theme).toBe('system');
  });

  it('applies a persisted Dark preference on load', async () => {
    renderApp(fakeSettings({ themePreference: 'dark' }).client, fakeApp().client);
    await screen.findByRole('button', { name: /new session/i });

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
  });

  it('overrides the OS and persists when the View-menu Appearance command fires', async () => {
    const settings = fakeSettings();
    const app = fakeApp();
    renderApp(settings.client, app.client);
    await screen.findByRole('button', { name: /new session/i });

    act(() => app.emit('theme:light'));

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    expect(settings.setPrefs).toHaveBeenCalledWith({ themePreference: 'light' });
  });
});
