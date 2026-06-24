// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { KeyStatus, Prefs, Session } from '@shared/types';

import { LLMPanel } from '../../src/components/LLMPanel';

/*
 * Model selection (M03.D, ADR-0008): the chat model is selectable and persisted in
 * non-secret prefs. The default is Haiku 4.5 (cost/latency for chat); the picker
 * writes the chosen id through settings:setPrefs and the panel reflects the loaded
 * pref. Driven here through LLMPanel (which owns the pref load/persist) with a fake
 * settings client — no key, no SDK.
 */
const SESSION: Session = {
  id: 's1',
  spaceId: 'sp1',
  name: 'Design review',
  createdAt: 1,
  updatedAt: 1,
};

const KEY_STATUS: KeyStatus = { hasKey: true, encryptionAvailable: true };

function fakeSettings(initialPrefs: Prefs) {
  let prefs: Prefs = { ...initialPrefs };
  return {
    setKey: vi.fn(async () => ({ ok: true as const })),
    keyStatus: vi.fn(async () => KEY_STATUS),
    clearKey: vi.fn(async () => undefined),
    getPrefs: vi.fn(async () => prefs),
    setPrefs: vi.fn(async (next: Prefs) => {
      prefs = { ...prefs, ...next };
      return prefs;
    }),
    getProvider: vi.fn(async () => ({ provider: 'anthropic' as const })),
    setProvider: vi.fn(async (provider) => provider),
    pingGateway: vi.fn(async () => ({ ok: true as const })),
  };
}

const MODEL_PICKER = { name: /model/i } as const;

describe('Chat model selection', () => {
  it('defaults the chat model to Haiku 4.5 when no pref is stored', async () => {
    render(<LLMPanel session={SESSION} settingsClient={fakeSettings({})} />);

    const picker = await screen.findByRole('combobox', MODEL_PICKER);
    expect(picker).toHaveValue('claude-haiku-4-5');
  });

  it('reflects the persisted chat-model pref on load', async () => {
    render(
      <LLMPanel
        session={SESSION}
        settingsClient={fakeSettings({ chatModel: 'claude-sonnet-4-6' })}
      />,
    );

    const picker = await screen.findByRole('combobox', MODEL_PICKER);
    await waitFor(() => expect(picker).toHaveValue('claude-sonnet-4-6'));
  });

  it('persists a newly chosen model through settings:setPrefs', async () => {
    const user = userEvent.setup();
    const settings = fakeSettings({});
    render(<LLMPanel session={SESSION} settingsClient={settings} />);

    const picker = await screen.findByRole('combobox', MODEL_PICKER);
    await user.selectOptions(picker, 'claude-opus-4-8');

    expect(settings.setPrefs).toHaveBeenCalledWith({ chatModel: 'claude-opus-4-8' });
    await waitFor(() => expect(picker).toHaveValue('claude-opus-4-8'));
  });

  it('snaps a stale (out-of-catalog) chat-model pref to a valid model and persists it', async () => {
    // A raw gateway id saved by an older build (the flooded picker) is no longer a catalog tier, so
    // the panel snaps it to the chat default and persists — the dropdown never shows one model while
    // chat sends another (audit bugs 1+2).
    const settings = fakeSettings({ chatModel: 'us.anthropic.claude-3-5-sonnet-stale-v2:0' });
    render(<LLMPanel session={SESSION} settingsClient={settings} />);

    await waitFor(() =>
      expect(settings.setPrefs).toHaveBeenCalledWith({ chatModel: 'claude-haiku-4-5' }),
    );
    const picker = await screen.findByRole('combobox', MODEL_PICKER);
    await waitFor(() => expect(picker).toHaveValue('claude-haiku-4-5'));
  });
});
