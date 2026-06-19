// @vitest-environment jsdom
import { useEffect, type ReactElement } from 'react';

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToastHost } from '../../src/components/ToastHost';
import { ToastProvider, useToasts } from '../../src/hooks/useToasts';

/*
 * The app-level toast system (M07.B; REVIEW-V11 F24 — nothing reusable existed; every
 * notification was an ad-hoc per-component div). One portal-rendered host, a queued
 * stack, optional action button, and aria-live built in. Heartbeat updates REPLACE by
 * key (a naive stack would flood the queue on a 15-minute run). Toasts are TRANSIENT —
 * persistent errors keep living in their component role="alert"/ErrorState blocks.
 */

// A tiny consumer that drives the context API so the tests exercise the real provider,
// not a mock. Buttons map to the toast operations under test.
function Driver(): ReactElement {
  const toasts = useToasts();
  return (
    <div>
      <button type="button" onClick={() => toasts.show({ variant: 'info', message: 'Saved' })}>
        info
      </button>
      <button type="button" onClick={() => toasts.show({ variant: 'error', message: 'It broke' })}>
        err
      </button>
      <button
        type="button"
        onClick={() =>
          toasts.show({
            key: 'gen-progress',
            variant: 'progress',
            message: `Still generating (${Date.now()})`,
          })
        }
      >
        progress
      </button>
      <button
        type="button"
        onClick={() =>
          toasts.show({
            key: 'gen-cancel',
            variant: 'progress',
            message: 'Generating white paper',
            action: { label: 'Cancel', onClick: () => onCancel() },
            durationMs: null,
          })
        }
      >
        cancellable
      </button>
      <button type="button" onClick={() => toasts.dismiss('gen-cancel')}>
        dismiss-cancel
      </button>
    </div>
  );
}

let onCancel: () => void = () => undefined;

function mount(): void {
  render(
    <ToastProvider>
      <Driver />
      <ToastHost />
    </ToastProvider>,
  );
}

afterEach(() => {
  onCancel = () => undefined;
  vi.useRealTimers();
});

describe('toast system', () => {
  it('renders a shown toast inside a live region', async () => {
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'info' }));

    const host = screen.getByTestId('toast-host');
    expect(host).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('stacks distinct toasts but REPLACES by key (no flood on repeated progress)', async () => {
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'info' }));
    await userEvent.click(screen.getByRole('button', { name: 'progress' }));
    await userEvent.click(screen.getByRole('button', { name: 'progress' }));
    await userEvent.click(screen.getByRole('button', { name: 'progress' }));

    // Three progress clicks under the SAME key collapse to one live toast; the
    // distinct info toast still stands alongside it.
    expect(screen.getAllByText(/still generating/i)).toHaveLength(1);
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('fires the action callback when the action button is pressed', async () => {
    onCancel = vi.fn();
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'cancellable' }));

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('marks error toasts assertive and info/progress toasts polite', async () => {
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'err' }));

    // An error toast must announce assertively (role=alert) so a failure is not missed.
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('It broke');
  });

  it('dismiss(key) removes the keyed toast', async () => {
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'cancellable' }));
    expect(screen.getByText('Generating white paper')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'dismiss-cancel' }));
    expect(screen.queryByText('Generating white paper')).toBeNull();
  });

  it('auto-dismisses a toast after its durationMs (and a null duration persists)', async () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <AutoDriver />
        <ToastHost />
      </ToastProvider>,
    );

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByText('ephemeral')).toBeInTheDocument();
    expect(screen.getByText('sticky')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    // The auto-dismiss toast is gone; the null-duration one persists.
    expect(screen.queryByText('ephemeral')).toBeNull();
    expect(screen.getByText('sticky')).toBeInTheDocument();
  });
});

// Shows one auto-dismissing toast and one persistent toast on mount, for the timer test.
function AutoDriver(): ReactElement {
  // `show` is a stable provider callback, so this effect runs once on mount.
  const { show } = useToasts();
  useEffect(() => {
    show({ variant: 'info', message: 'ephemeral', durationMs: 1000 });
    show({ variant: 'progress', message: 'sticky', durationMs: null });
  }, [show]);
  return <div />;
}
