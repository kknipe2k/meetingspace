// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SettingsApi } from '@shared/api';
import type { Session } from '@shared/types';

import { LLMPanel } from '../../src/components/LLMPanel';

/*
 * The LLM panel (M04.B adds the White-paper entry point). This test covers the new
 * branch: a session-scoped "White paper" button opens the generated-document modal
 * (GeneratedDocView). GeneratedDocView's default gen client reads window.api.gen, so
 * a minimal stub stands in for the preload bridge (no real IPC in a unit test).
 */
const SESSION: Session = {
  id: 's1',
  spaceId: 'sp1',
  name: 'Kickoff',
  createdAt: 1,
  updatedAt: 1,
};

const settings: SettingsApi = {
  setKey: () => Promise.resolve({ ok: true }),
  keyStatus: () => Promise.resolve({ hasKey: true, encryptionAvailable: true }),
  clearKey: () => Promise.resolve(),
  getPrefs: () => Promise.resolve({}),
  setPrefs: () => Promise.resolve({}),
  getProvider: () => Promise.resolve({ provider: 'anthropic' }),
  setProvider: (provider) => Promise.resolve(provider),
};

beforeEach(() => {
  // A minimal preload stub. M07.B: streaming methods return a {detach, cancel} handle; the
  // modal queries getLatestArtifacts + status + subscribes to onArtifactSaved on mount.
  // Generation is MANUAL (no auto-start), so opening just surfaces the empty state + gate.
  const handle = { detach: () => undefined, cancel: () => undefined };
  (window as unknown as { api: unknown }).api = {
    gen: {
      generateFocus: () => handle,
      generateWhitepaper: () => handle,
      generateMinutes: () => handle,
      attach: () => handle,
      status: () => Promise.resolve(null),
      cancel: () => Promise.resolve(),
      onArtifactSaved: () => () => undefined,
      onRunStarted: () => () => undefined,
      onRunEnded: () => () => undefined,
      getLatestArtifacts: () => Promise.resolve([]),
      getArtifacts: () => Promise.resolve([]),
      listTemplates: () => Promise.resolve([]),
      saveTemplate: () => Promise.resolve({}),
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

describe('LLMPanel — white paper entry point', () => {
  it('shows no White paper button when no session is selected', () => {
    render(<LLMPanel session={null} settingsClient={settings} />);
    expect(screen.queryByRole('button', { name: 'White paper' })).toBeNull();
  });

  it('opens the generated-document modal when White paper is clicked', async () => {
    render(<LLMPanel session={SESSION} settingsClient={settings} />);

    await userEvent.click(screen.getByRole('button', { name: 'White paper' }));

    const dialog = await screen.findByRole('dialog', { name: 'White paper' });
    expect(dialog).toBeInTheDocument();
    // The modal hosts GeneratedDocView with its manual Generate gate (M07.B: opening never
    // starts a run).
    expect(
      await screen.findByRole('button', { name: /generate white paper/i }),
    ).toBeInTheDocument();
  });
});
