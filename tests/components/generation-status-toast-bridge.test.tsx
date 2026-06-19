// @vitest-environment jsdom
import { StrictMode } from 'react';

import { act, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGenApi } from '../../electron/ipc/gen-bridge';
import type { IpcStreamTransport } from '../../electron/ipc/llm-bridge';
import type { GenStatus } from '@shared/types';

import { GenerationStatusToast } from '../../src/components/GenerationStatusToast';
import { ToastHost } from '../../src/components/ToastHost';
import { ToastProvider } from '../../src/hooks/useToasts';

/*
 * M07.B IRL regression — the seam the controller's own spec STUBBED. The unit spec injects a
 * fake client, so it never exercises the REAL renderer bridge (createGenApi) → ipcRenderer
 * subscription → render chain. The app mounts under <StrictMode>, which (dev only) runs every
 * effect setup→cleanup→setup; if the run-lifecycle subscription doesn't survive that cycle,
 * the broadcast lands on a removed listener and NO run toast renders — exactly the IRL
 * failure, invisible to a production-build e2e. This test wires the real bridge to a fake
 * ipcRenderer and drives it under StrictMode, asserting a `gen:run-started` event reaches the
 * toast.
 */
interface FakeIpc {
  transport: IpcStreamTransport;
  emit(channel: string, payload: unknown): void;
  listenerCount(channel: string): number;
}

function fakeIpc(): FakeIpc {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    transport: {
      invoke: () => Promise.resolve(undefined),
      on: (channel, listener) => {
        const set = listeners.get(channel) ?? new Set();
        set.add(listener);
        listeners.set(channel, set);
        return () => set.delete(listener);
      },
    },
    emit: (channel, payload) => {
      for (const listener of listeners.get(channel) ?? []) {
        listener(payload);
      }
    },
    listenerCount: (channel) => listeners.get(channel)?.size ?? 0,
  };
}

const RUN: GenStatus = {
  requestId: 'live-1',
  sessionId: 's1',
  kind: 'whitepaper',
  progress: null,
  startedAt: 1_000_000,
};

const sessionName = (id: string): string | undefined => (id === 's1' ? 'Q3 Planning' : undefined);

function host(): HTMLElement {
  return screen.getByTestId('toast-host');
}

afterEach(() => vi.useRealTimers());

describe('GenerationStatusToast — real gen bridge under StrictMode (IRL seam)', () => {
  it('renders the run toast from a gen:run-started event delivered over the real bridge', () => {
    vi.useFakeTimers();
    vi.setSystemTime(RUN.startedAt + 3_000);
    const ipc = fakeIpc();
    const gen = createGenApi(ipc.transport, () => 'unused');

    render(
      <StrictMode>
        <ToastProvider>
          <GenerationStatusToast client={gen} sessionName={sessionName} />
          <ToastHost />
        </ToastProvider>
      </StrictMode>,
    );

    // StrictMode's setup→cleanup→setup must leave EXACTLY one live subscription.
    expect(ipc.listenerCount('gen:run-started')).toBe(1);

    act(() => ipc.emit('gen:run-started', RUN));

    const toast = host();
    expect(toast).toHaveTextContent(/Q3 Planning/);
    expect(toast).toHaveTextContent(/white paper/i);
    expect(within(toast).getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });

  it('clears the toast on a gen:run-ended event over the real bridge', () => {
    vi.useFakeTimers();
    vi.setSystemTime(RUN.startedAt);
    const ipc = fakeIpc();
    const gen = createGenApi(ipc.transport, () => 'unused');

    render(
      <StrictMode>
        <ToastProvider>
          <GenerationStatusToast client={gen} sessionName={sessionName} />
          <ToastHost />
        </ToastProvider>
      </StrictMode>,
    );

    act(() => ipc.emit('gen:run-started', RUN));
    expect(host()).toHaveTextContent(/white paper/i);

    act(() => ipc.emit('gen:run-ended', { requestId: RUN.requestId }));
    expect(host()).not.toHaveTextContent(/white paper/i);
  });
});
