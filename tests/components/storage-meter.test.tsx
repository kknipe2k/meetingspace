// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { STORAGE_THRESHOLD_BYTES } from '@shared/limits';
import type { StorageApi } from '@shared/api';
import type { StorageSummary } from '@shared/types';

import { StorageMeter } from '../../src/components/StorageMeter';
import { StorageNudge } from '../../src/components/StorageNudge';
import { ToastHost } from '../../src/components/ToastHost';
import { ToastProvider } from '../../src/hooks/useToasts';

/*
 * Storage meter + threshold nudge (M06.B, REVIEW-V11 F28). The meter shows total + per-session
 * usage so disk growth is visible; the nudge raises one info toast when total crosses the
 * threshold. Both read aggregate counts only — no key, no DB handle.
 */
function storage(summary: StorageSummary): StorageApi {
  return {
    summary: () => Promise.resolve(summary),
    backup: () => Promise.resolve({ saved: false }),
    restore: () => Promise.resolve({ restored: false, reason: 'cancelled' }),
  };
}

describe('StorageMeter', () => {
  it('shows total + per-session usage', async () => {
    render(
      <StorageMeter
        client={storage({
          totalBytes: 1_572_864, // 1.5 MB
          perSession: [{ sessionId: 's1', name: 'Alpha', bytes: 1_048_576 }], // 1.0 MB
        })}
      />,
    );

    // The section mounts before the async summary loads, so await the loaded ROW (not just the
    // always-present section) before asserting — otherwise a slow env races the state update.
    await screen.findByText(/total used/i);
    const meter = screen.getByTestId('storage-meter');
    expect(within(meter).getByText(/total used/i)).toHaveTextContent('1.5 MB');
    expect(within(meter).getByText('Alpha')).toBeInTheDocument();
    expect(within(meter).getByText('1.0 MB')).toBeInTheDocument();
  });

  it('surfaces a read failure instead of rendering stale/empty silently', async () => {
    render(<StorageMeter client={{ summary: () => Promise.reject(new Error('db down')) }} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn’t read storage/i);
  });
});

describe('StorageNudge', () => {
  function mount(client: StorageApi) {
    render(
      <ToastProvider>
        <StorageNudge client={client} />
        <ToastHost />
      </ToastProvider>,
    );
  }

  it('nudges once when total usage has crossed the threshold', async () => {
    mount(storage({ totalBytes: STORAGE_THRESHOLD_BYTES, perSession: [] }));

    expect(
      await within(screen.getByTestId('toast-host')).findByText(/over 1 GB of storage/i),
    ).toBeInTheDocument();
  });

  it('does not nudge below the threshold', async () => {
    mount(storage({ totalBytes: STORAGE_THRESHOLD_BYTES - 1, perSession: [] }));

    await Promise.resolve();
    expect(
      within(screen.getByTestId('toast-host')).queryByText(/over 1 GB of storage/i),
    ).toBeNull();
  });
});
