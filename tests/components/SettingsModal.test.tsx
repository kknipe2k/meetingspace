// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { KeyStatus, Prefs, ProviderConfig } from '@shared/types';

import { SettingsModal } from '../../src/components/SettingsModal';

// A controllable fake of the settings IPC client (never the real key/SDK). hasKey
// and encryptionAvailable drive the surface; setKey/clearKey mutate the reported
// status so the modal's re-fetch reflects the change. M07.D: getProvider/setProvider
// carry the (default anthropic) provider config.
function fakeClient(initial: KeyStatus) {
  let status: KeyStatus = { ...initial };
  let prefs: Prefs = {};
  let provider: ProviderConfig = { provider: 'anthropic' };
  return {
    setKey: vi.fn(async () => {
      if (!status.encryptionAvailable) {
        return { ok: false as const, reason: 'encryption-unavailable' as const };
      }
      status = { ...status, hasKey: true };
      return { ok: true as const };
    }),
    keyStatus: vi.fn(async () => status),
    clearKey: vi.fn(async () => {
      status = { ...status, hasKey: false };
    }),
    getPrefs: vi.fn(async () => prefs),
    setPrefs: vi.fn(async (next: Prefs) => {
      prefs = { ...prefs, ...next };
      return prefs;
    }),
    getProvider: vi.fn(async () => provider),
    setProvider: vi.fn(async (next: ProviderConfig) => {
      // Mirror the main-side guard: a remote http gateway URL is rejected (typed key-free).
      if (next.provider === 'gateway' && /^http:\/\/(?!localhost|127\.)/.test(next.baseURL)) {
        throw new Error('gateway baseURL must be https');
      }
      provider = next;
      return provider;
    }),
  };
}

const SAVED: KeyStatus = { hasKey: true, encryptionAvailable: true };
const EMPTY: KeyStatus = { hasKey: false, encryptionAvailable: true };
const NO_ENCRYPTION: KeyStatus = { hasKey: false, encryptionAvailable: false };

describe('SettingsModal', () => {
  it('shows the no-key status and an empty masked field when no key is stored', async () => {
    render(<SettingsModal client={fakeClient(EMPTY)} onClose={vi.fn()} />);

    expect(await screen.findByText(/no api key saved/i)).toBeInTheDocument();
    const field = screen.getByLabelText(/anthropic api key/i);
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveValue('');
  });

  it('never displays the stored key back — the field stays empty even when a key is set', async () => {
    render(<SettingsModal client={fakeClient(SAVED)} onClose={vi.fn()} />);

    expect(await screen.findByText(/api key saved/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/anthropic api key/i)).toHaveValue('');
  });

  it('saves a typed key through the client and reflects the saved status', async () => {
    const user = userEvent.setup();
    const client = fakeClient(EMPTY);
    render(<SettingsModal client={client} onClose={vi.fn()} />);

    await user.type(screen.getByLabelText(/anthropic api key/i), 'sk-ant-FAKE');
    await user.click(screen.getByRole('button', { name: /save key/i }));

    // M07.D: the active provider id rides along (default anthropic).
    expect(client.setKey).toHaveBeenCalledWith('sk-ant-FAKE', 'anthropic');
    expect(await screen.findByText(/api key saved/i)).toBeInTheDocument();
    // The field is cleared after a successful save (the plaintext does not linger).
    expect(screen.getByLabelText(/anthropic api key/i)).toHaveValue('');
  });

  it('clears a stored key through the client', async () => {
    const user = userEvent.setup();
    const client = fakeClient(SAVED);
    render(<SettingsModal client={client} onClose={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: /clear key/i }));

    expect(client.clearKey).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/no api key saved/i)).toBeInTheDocument();
  });

  it('surfaces an encryption-unavailable error and disables saving (no plaintext fallback)', async () => {
    const user = userEvent.setup();
    const client = fakeClient(NO_ENCRYPTION);
    render(<SettingsModal client={client} onClose={vi.fn()} />);

    expect(await screen.findByTestId('settings-encryption-error')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/anthropic api key/i), 'sk-ant-FAKE');
    expect(screen.getByRole('button', { name: /save key/i })).toBeDisabled();
    expect(client.setKey).not.toHaveBeenCalled();
  });

  it('shows config-driven per-MTok pricing (M06.D — no hardcoded table)', async () => {
    // Pricing now flows from the updatable config over the usage IPC, not the hardcoded table.
    const usage = {
      summary: vi.fn(async () => ({
        sessionToday: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0,
          unpricedCalls: 0,
        },
        allToday: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0,
          unpricedCalls: 0,
        },
      })),
      pricing: vi.fn(async () => [
        { model: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', inputPerMTok: 1, outputPerMTok: 5 },
        {
          model: 'claude-sonnet-4-6',
          label: 'Claude Sonnet 4.6',
          inputPerMTok: 3,
          outputPerMTok: 15,
        },
        { model: 'claude-opus-4-8', label: 'Claude Opus 4.8', inputPerMTok: 5, outputPerMTok: 25 },
      ]),
    };
    render(<SettingsModal client={fakeClient(EMPTY)} usageClient={usage} onClose={vi.fn()} />);

    const guidance = await screen.findByTestId('settings-spend-guidance');
    await waitFor(() => expect(guidance).toHaveTextContent(/haiku/i));
    expect(guidance).toHaveTextContent(/sonnet/i);
    expect(guidance).toHaveTextContent(/opus/i);
    expect(guidance).toHaveTextContent(/\$1 \/ \$5/); // Haiku input/output from the config
    // The list comes from the editable config (read over the usage IPC), not a hardcoded snapshot.
    expect(usage.pricing).toHaveBeenCalled();
    expect(guidance).not.toHaveTextContent(/as of/i);
  });

  it('switching to the gateway provider reveals the base URL field and gateway-labelled token', async () => {
    const user = userEvent.setup();
    render(<SettingsModal client={fakeClient(EMPTY)} onClose={vi.fn()} />);
    await screen.findByText(/no api key saved/i);

    await user.selectOptions(screen.getByRole('combobox', { name: /claude provider/i }), 'gateway');

    expect(await screen.findByLabelText(/gateway base url/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/gateway token/i)).toBeInTheDocument();
    expect(screen.getByText(/no gateway token saved/i)).toBeInTheDocument();
  });

  it('saving a gateway persists the provider config then stores the token under the gateway provider', async () => {
    const user = userEvent.setup();
    const client = fakeClient(EMPTY);
    render(<SettingsModal client={client} onClose={vi.fn()} />);
    await screen.findByText(/no api key saved/i);

    await user.selectOptions(screen.getByRole('combobox', { name: /claude provider/i }), 'gateway');
    await user.type(await screen.findByLabelText(/gateway base url/i), 'https://corp.example/v1');
    await user.type(screen.getByLabelText(/gateway token/i), 'sk-corp-bearer');
    await user.click(screen.getByRole('button', { name: /save gateway/i }));

    expect(client.setProvider).toHaveBeenCalledWith({
      provider: 'gateway',
      baseURL: 'https://corp.example/v1',
    });
    expect(client.setKey).toHaveBeenCalledWith('sk-corp-bearer', 'gateway');
  });

  it('rejects a remote http gateway URL — surfaces the error and never sends the token', async () => {
    const user = userEvent.setup();
    const client = fakeClient(EMPTY);
    render(<SettingsModal client={client} onClose={vi.fn()} />);
    await screen.findByText(/no api key saved/i);

    await user.selectOptions(screen.getByRole('combobox', { name: /claude provider/i }), 'gateway');
    await user.type(
      await screen.findByLabelText(/gateway base url/i),
      'http://gateway.corp.example',
    );
    await user.type(screen.getByLabelText(/gateway token/i), 'sk-corp-bearer');
    await user.click(screen.getByRole('button', { name: /save gateway/i }));

    expect(await screen.findByTestId('settings-provider-error')).toBeInTheDocument();
    // The token is NOT transmitted when the gateway URL is rejected.
    expect(client.setKey).not.toHaveBeenCalled();
  });

  it('closes on Escape (consumes the shared Modal focus-trap)', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SettingsModal client={fakeClient(EMPTY)} onClose={onClose} />);
    await screen.findByText(/no api key saved/i);

    await user.keyboard('{Escape}');

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
