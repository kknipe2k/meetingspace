// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { AssetsApi, NotesApi, SessionApi, SettingsApi } from '@shared/api';
import type { Session } from '@shared/types';

import { App } from '../../src/App';

// No-op notes/assets APIs for App-level tests — note-block and screenshot
// behavior is covered by their own component tests; here we only need the canvas
// to render without a real window.api.
function fakeNotes(): NotesApi {
  return {
    add: () =>
      Promise.resolve({ id: 'n1', sessionId: 's', content: '', createdAt: 1, updatedAt: 1 }),
    addWithContent: () =>
      Promise.resolve({ id: 'n1', sessionId: 's', content: '', createdAt: 1, updatedAt: 1 }),
    list: () => Promise.resolve([]),
    update: () =>
      Promise.resolve({ id: 'n1', sessionId: 's', content: '', createdAt: 1, updatedAt: 1 }),
    updateSync: () => ({ id: 'n1', sessionId: 's', content: '', createdAt: 1, updatedAt: 1 }),
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

// No-op settings API for App-level tests — the LLM panel loads model prefs on
// mount (M03.D). Settings behavior has its own tests; here we only need getPrefs to
// resolve so the panel mounts without a real window.api.
function fakeSettings(): SettingsApi {
  return {
    setKey: () => Promise.resolve({ ok: true }),
    keyStatus: () => Promise.resolve({ hasKey: false, encryptionAvailable: true }),
    clearKey: () => Promise.resolve(),
    // M06.E: mark onboarding already-seen so the App-level suite exercises the main surface
    // (the first-run overlay has its own dedicated test below + Onboarding.test.tsx).
    getPrefs: () => Promise.resolve({ onboardingSeen: true }),
    setPrefs: (prefs) => Promise.resolve(prefs),
    getProvider: () => Promise.resolve({ provider: 'anthropic' }),
    setProvider: (provider) => Promise.resolve(provider),
  };
}

// An in-memory SessionApi standing in for the IPC client, so the App's wiring
// (list on mount, select → canvas, create/rename/delete loop) is exercised
// end-to-end at the renderer level without a real window.api.
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
    rename: (id, name) => {
      const index = rows.findIndex((r) => r.id === id);
      const current = rows[index];
      if (current) {
        seq += 1;
        rows[index] = { ...current, name, updatedAt: seq };
      }
      return Promise.resolve();
    },
    delete: (id) => {
      const index = rows.findIndex((r) => r.id === id);
      if (index >= 0) {
        rows.splice(index, 1);
      }
      return Promise.resolve();
    },
    deleteMany: (ids) => {
      for (const id of ids) {
        const index = rows.findIndex((r) => r.id === id);
        if (index >= 0) {
          rows.splice(index, 1);
        }
      }
      return Promise.resolve();
    },
  };
}

// The app-level run toast subscribes to the gen run lifecycle on mount (M07.B); a no-op
// stub stands in for the preload bridge so App renders without a real window.api.
const genStatus = {
  onRunStarted: () => () => undefined,
  onRunEnded: () => () => undefined,
  // M07.C: the controller also tails the unkeyed progress feed ("Section 3 of 7").
  onProgress: () => () => undefined,
  cancel: () => Promise.resolve(),
};

function canvas(): HTMLElement {
  return screen.getByTestId('zone-canvas');
}

describe('App', () => {
  it('lists existing sessions on mount', async () => {
    render(
      <App
        client={fakeClient([['s1', 'Design review']])}
        noteClient={fakeNotes()}
        assetClient={fakeAssets()}
        settingsClient={fakeSettings()}
        genStatusClient={genStatus}
      />,
    );

    expect(await screen.findByRole('button', { name: 'Design review' })).toBeInTheDocument();
  });

  it('shows the selected session in the canvas', async () => {
    const user = userEvent.setup();
    render(
      <App
        client={fakeClient([
          ['s1', 'Design review'],
          ['s2', 'Roadmap'],
        ])}
        noteClient={fakeNotes()}
        assetClient={fakeAssets()}
        settingsClient={fakeSettings()}
        genStatusClient={genStatus}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'Roadmap' }));

    expect(within(canvas()).getByRole('heading', { name: 'Roadmap' })).toBeInTheDocument();
  });

  it('creates a session, selects it, and shows it in the canvas', async () => {
    const user = userEvent.setup();
    render(
      <App
        client={fakeClient()}
        noteClient={fakeNotes()}
        assetClient={fakeAssets()}
        settingsClient={fakeSettings()}
        genStatusClient={genStatus}
      />,
    );

    await user.click(await screen.findByRole('button', { name: /new session/i }));

    expect(
      await within(canvas()).findByRole('heading', { name: 'Untitled session' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Untitled session' })).toBeInTheDocument();
  });

  it('renames the selected session and reflects it in the list and canvas', async () => {
    const user = userEvent.setup();
    render(
      <App
        client={fakeClient([['s1', 'Design review']])}
        noteClient={fakeNotes()}
        assetClient={fakeAssets()}
        settingsClient={fakeSettings()}
        genStatusClient={genStatus}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'Design review' }));
    await user.click(screen.getByRole('button', { name: 'Rename Design review' }));
    const input = screen.getByRole('textbox', { name: /session name/i });
    await user.clear(input);
    await user.type(input, 'Architecture review{Enter}');

    expect(await screen.findByRole('button', { name: 'Architecture review' })).toBeInTheDocument();
    expect(
      within(canvas()).getByRole('heading', { name: 'Architecture review' }),
    ).toBeInTheDocument();
  });

  it('deletes the selected session and returns the canvas to the empty state', async () => {
    const user = userEvent.setup();
    render(
      <App
        client={fakeClient([['s1', 'Design review']])}
        noteClient={fakeNotes()}
        assetClient={fakeAssets()}
        settingsClient={fakeSettings()}
        genStatusClient={genStatus}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'Design review' }));
    // M06.B (F10): delete is immediate-with-Undo — no confirm step. The session leaves the list
    // optimistically and the canvas returns to empty; an Undo toast offers recovery.
    await user.click(screen.getByRole('button', { name: 'Delete Design review' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Design review' })).not.toBeInTheDocument();
    });
    expect(within(canvas()).getByText(/no session selected/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  // M06.E: the App mounts the first-run overlay when there is no credential and onboarding has
  // not been seen; it stays hidden for a returning user (a saved key OR the seen flag).
  it('shows the first-run onboarding overlay on a true first run (no key, never seen)', async () => {
    const settings = fakeSettings();
    settings.getPrefs = () => Promise.resolve({}); // never seen
    render(
      <App
        client={fakeClient()}
        noteClient={fakeNotes()}
        assetClient={fakeAssets()}
        settingsClient={settings}
        genStatusClient={genStatus}
      />,
    );

    expect(await screen.findByRole('button', { name: /get started/i })).toBeInTheDocument();
  });

  it('does NOT show onboarding for a returning user with a saved key', async () => {
    const settings = fakeSettings();
    settings.getPrefs = () => Promise.resolve({}); // not seen…
    settings.keyStatus = () => Promise.resolve({ hasKey: true, encryptionAvailable: true }); // …but has a key
    render(
      <App
        client={fakeClient()}
        noteClient={fakeNotes()}
        assetClient={fakeAssets()}
        settingsClient={settings}
        genStatusClient={genStatus}
      />,
    );

    // The session list loads (mount settled) and no onboarding overlay is present.
    await screen.findByRole('button', { name: /new session/i });
    expect(screen.queryByRole('button', { name: /get started/i })).not.toBeInTheDocument();
  });
});
