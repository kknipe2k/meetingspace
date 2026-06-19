// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ReactElement } from 'react';

import type { CatalogClient } from '../../src/ipc/client';
import type { CatalogModel } from '@shared/types';
import { useModelCatalog } from '../../src/hooks/useModelCatalog';

/*
 * useModelCatalog (M06.D, ADR-0021): seeds from the static catalog (never empty), refines with the
 * live list on mount, and re-fetches on manual refresh. Driven through a tiny harness so the hook's
 * list + refresh paths are exercised without an IPC round-trip.
 */
const LIVE: CatalogModel[] = [{ id: 'live-1', label: 'Live One', maxOutputTokens: 64000 }];
const REFRESHED: CatalogModel[] = [{ id: 'live-2', label: 'Live Two', maxOutputTokens: 32000 }];

function Harness({ client }: { client: CatalogClient }): ReactElement {
  const { models, refresh } = useModelCatalog(client);
  return (
    <div>
      <ul aria-label="models">
        {models.map((m) => (
          <li key={m.id}>{m.label}</li>
        ))}
      </ul>
      <button type="button" onClick={refresh}>
        refresh
      </button>
    </div>
  );
}

describe('useModelCatalog', () => {
  it('seeds the static catalog, then refines with the live list, and re-fetches on refresh', async () => {
    const client: CatalogClient = {
      list: vi.fn(async () => LIVE),
      refresh: vi.fn(async () => REFRESHED),
    };
    render(<Harness client={client} />);

    // Static seed is present immediately (never empty), then the live list lands.
    await waitFor(() => expect(screen.getByText('Live One')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'refresh' }));
    await waitFor(() => expect(screen.getByText('Live Two')).toBeInTheDocument());
    expect(client.refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps the static seed visible when the live list comes back empty', async () => {
    const client: CatalogClient = {
      list: vi.fn(async () => []),
      refresh: vi.fn(async () => []),
    };
    render(<Harness client={client} />);
    // A successful-but-empty response must not blank the picker — the seed stays.
    const list = screen.getByLabelText('models');
    await waitFor(() => expect(list.querySelectorAll('li').length).toBeGreaterThan(0));
  });
});
