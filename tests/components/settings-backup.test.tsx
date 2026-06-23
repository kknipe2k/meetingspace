// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { KeyStatus, ProviderConfig, Prefs } from '@shared/types';

import { SettingsModal } from '../../src/components/SettingsModal';
import type { StorageClient } from '../../src/ipc/client';
import { ToastHost } from '../../src/components/ToastHost';
import { ToastProvider } from '../../src/hooks/useToasts';

/*
 * M06.C backup/restore UI in Settings. The container build/version-check/round-trip is proven in
 * tests/storage/backup-roundtrip; this pins the renderer surface: the buttons call the storage IPC
 * and a refused restore (newer-schema / corrupt) is surfaced — never silent. Success relaunches the
 * app main-side, so there's nothing to assert past the call there.
 */
function fakeSettings() {
  const status: KeyStatus = { hasKey: false, encryptionAvailable: true };
  const provider: ProviderConfig = { provider: 'anthropic' };
  let prefs: Prefs = {};
  return {
    setKey: vi.fn(async () => ({ ok: true as const })),
    keyStatus: vi.fn(async () => status),
    clearKey: vi.fn(async () => undefined),
    getPrefs: vi.fn(async () => prefs),
    setPrefs: vi.fn(async (next: Prefs) => (prefs = { ...prefs, ...next })),
    getProvider: vi.fn(async () => provider),
    setProvider: vi.fn(async () => provider),
    pingGateway: vi.fn(async () => ({ ok: true as const })),
  };
}

function renderModal(storage: StorageClient) {
  return render(
    <ToastProvider>
      <SettingsModal client={fakeSettings()} storage={storage} onClose={vi.fn()} />
      <ToastHost />
    </ToastProvider>,
  );
}

describe('SettingsModal — backup/restore (M06.C)', () => {
  it('Back up all data… calls the storage backup IPC and confirms a save', async () => {
    const storage: StorageClient = {
      summary: vi.fn().mockResolvedValue({ totalBytes: 0, perSession: [] }),
      backup: vi.fn().mockResolvedValue({ saved: true, path: 'C:/out/x.msbackup' }),
      restore: vi.fn().mockResolvedValue({ restored: false, reason: 'cancelled' }),
    };
    renderModal(storage);

    await userEvent.click(await screen.findByRole('button', { name: /back up all data/i }));
    await waitFor(() => expect(storage.backup).toHaveBeenCalled());
    expect(await screen.findByText(/backup saved/i)).toBeInTheDocument();
  });

  it('Restore surfaces a clear message when the backup is from a NEWER version (never silent)', async () => {
    const storage: StorageClient = {
      summary: vi.fn().mockResolvedValue({ totalBytes: 0, perSession: [] }),
      backup: vi.fn(),
      restore: vi.fn().mockResolvedValue({ restored: false, reason: 'incompatible-version' }),
    };
    renderModal(storage);

    await userEvent.click(await screen.findByRole('button', { name: /restore from backup/i }));
    await waitFor(() => expect(storage.restore).toHaveBeenCalled());
    expect(await screen.findByText(/newer version/i)).toBeInTheDocument();
  });

  it('Restore surfaces a clear message for an invalid (non-backup) file', async () => {
    const storage: StorageClient = {
      summary: vi.fn().mockResolvedValue({ totalBytes: 0, perSession: [] }),
      backup: vi.fn(),
      restore: vi.fn().mockResolvedValue({ restored: false, reason: 'invalid' }),
    };
    renderModal(storage);

    await userEvent.click(await screen.findByRole('button', { name: /restore from backup/i }));
    expect(await screen.findByText(/isn.t a valid meetingspace backup/i)).toBeInTheDocument();
  });

  it('a cancelled restore is silent (no toast)', async () => {
    const storage: StorageClient = {
      summary: vi.fn().mockResolvedValue({ totalBytes: 0, perSession: [] }),
      backup: vi.fn(),
      restore: vi.fn().mockResolvedValue({ restored: false, reason: 'cancelled' }),
    };
    renderModal(storage);

    await userEvent.click(await screen.findByRole('button', { name: /restore from backup/i }));
    await waitFor(() => expect(storage.restore).toHaveBeenCalled());
    expect(screen.queryByText(/newer version|isn.t a valid/i)).toBeNull();
  });
});
