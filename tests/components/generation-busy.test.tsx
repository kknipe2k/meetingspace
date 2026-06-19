// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { GenApi, GenStreamCallbacks } from '@shared/api';
import type { GenRunEnded, GenStatus } from '@shared/types';

import { GeneratedDocView } from '../../src/components/GeneratedDocView';
import { ToastHost } from '../../src/components/ToastHost';
import { ToastProvider } from '../../src/hooks/useToasts';

/*
 * M07.C (product-owner scope amendment) — the renderer side of the single build slot.
 * A Generate invoke refused by main (typed busy result → the bridge's onBusy callback)
 * must NEVER silently no-op: the modal raises a toast explaining what is running
 * ({session} · {kind} · elapsed) and offers ONE explicitly-labeled action — "Cancel
 * current & start this one". The handoff: cancel the live run, WAIT for its
 * gen:run-ended, only then invoke the new build.
 *
 * PINNED INVARIANT (mutation check at verify_gates): cancelling NEVER auto-starts the
 * new build without that labeled click — a run-ended arriving without the action
 * having been clicked must not trigger a generate invoke. (The plain-cancel path is
 * the always-present app-level run toast's Cancel — B's surface, untouched here.)
 */
const GENERATE = { name: /generate white paper/i } as const;
const HANDOFF = { name: /cancel current & start this one/i } as const;

const LIVE = {
  requestId: 'live-1',
  sessionId: 'other-session',
  kind: 'whitepaper',
  progress: null,
  startedAt: Date.now() - 65_000,
} as unknown as GenStatus;

interface Harness {
  client: GenApi;
  cancel: ReturnType<typeof vi.fn>;
  wpCalls(): number;
  emitBusy(live: GenStatus): void;
  emitRunEnded(e: GenRunEnded): void;
}

function harness(): Harness {
  let current: GenStreamCallbacks | null = null;
  let runEndedListener: ((e: GenRunEnded) => void) | null = null;
  let wpCalls = 0;
  const cancel = vi.fn(() => Promise.resolve());

  const handle = () => ({ detach: () => undefined, cancel: () => undefined });

  const client: GenApi = {
    generateFocus(_req, cbs) {
      current = cbs;
      return handle();
    },
    generateWhitepaper(_req, cbs) {
      current = cbs;
      wpCalls += 1;
      return handle();
    },
    generateMinutes(_req, cbs) {
      current = cbs;
      return handle();
    },
    attach(_id, cbs) {
      current = cbs;
      return handle();
    },
    status: () => Promise.resolve(null),
    cancel,
    onArtifactSaved: () => () => undefined,
    onRunStarted: () => () => undefined,
    onProgress: () => () => undefined,
    onRunEnded(listener) {
      runEndedListener = listener;
      return () => {
        runEndedListener = null;
      };
    },
    getLatestArtifacts: () => Promise.resolve([]),
    getArtifacts: () => Promise.resolve([]),
    buildRawDoc: () => Promise.resolve('<html><body>raw</body></html>'),
    exportImages: () => Promise.resolve({ images: [], omittedCount: 0 }),
    exportHtml: () => Promise.resolve({ saved: true, path: '/o.html' }),
    exportMarkdown: () => Promise.resolve({ saved: true, path: '/o.md' }),
    exportPdf: () => Promise.resolve({ saved: true, path: '/o.pdf' }),
    listTemplates: () => Promise.resolve([]),
    saveTemplate: () =>
      Promise.resolve({
        id: 't',
        name: 'n',
        focusPrompt: '',
        whitepaperPrompt: '',
        isDefault: false,
      }),
    getTemplate: () => Promise.resolve(null),
    deleteTemplate: () => Promise.resolve(),
  };

  return {
    client,
    cancel,
    wpCalls: () => wpCalls,
    emitBusy: (live) =>
      act(() => (current as { onBusy?: (l: GenStatus) => void } | null)?.onBusy?.(live)),
    emitRunEnded: (e) => act(() => runEndedListener?.(e)),
  };
}

function view(h: Harness) {
  return render(
    <ToastProvider>
      <GeneratedDocView
        sessionId="s1"
        client={h.client}
        sessionName={(id) => (id === 'other-session' ? 'Other session' : undefined)}
      />
      <ToastHost />
    </ToastProvider>,
  );
}

async function startAndGetBusy(h: Harness): Promise<void> {
  await screen.findByText(/no document yet/i);
  await userEvent.click(screen.getByRole('button', GENERATE));
  expect(h.wpCalls()).toBe(1);
  h.emitBusy(LIVE);
  // Load-bearing precondition for every test below: the busy state must actually
  // surface (no vacuous pass when onBusy is unhandled — the refusal is never silent).
  await screen.findByText(/other session · white paper/i);
}

describe('single build slot — the busy toast (never a silent no-op)', () => {
  it('a refused start raises a toast naming the live run ({session} · {kind}) with the labeled handoff action', async () => {
    const h = harness();
    view(h);
    await startAndGetBusy(h);

    // The toast explains WHAT is running — the live run's session and kind.
    expect(await screen.findByText(/other session · white paper/i)).toBeInTheDocument();
    expect(screen.getByRole('button', HANDOFF)).toBeInTheDocument();
    // The refused start left no streaming UI behind — Generate is still offered.
    expect(screen.getByRole('button', GENERATE)).toBeInTheDocument();
  });

  it('the labeled action cancels the live run, then starts the new build ONLY after ITS run-ended', async () => {
    const h = harness();
    view(h);
    await startAndGetBusy(h);

    await userEvent.click(await screen.findByRole('button', HANDOFF));

    // Cancel fired at the LIVE run…
    expect(h.cancel).toHaveBeenCalledWith('live-1');
    // …but the new build does NOT start until that run actually settles.
    expect(h.wpCalls()).toBe(1);

    // An unrelated run settling is not the signal.
    h.emitRunEnded({ requestId: 'unrelated-9' });
    expect(h.wpCalls()).toBe(1);

    // The live run's settle IS the signal — now (and only now) the new build starts.
    h.emitRunEnded({ requestId: 'live-1' });
    expect(h.wpCalls()).toBe(2);
  });

  it('NEVER auto-starts without the labeled click — a cancel from elsewhere must not chain into a new build', async () => {
    const h = harness();
    view(h);
    await startAndGetBusy(h);

    // The user cancels the live run from the app-level run toast (B's surface) —
    // WITHOUT clicking "Cancel current & start this one" here.
    h.emitRunEnded({ requestId: 'live-1' });
    await act(async () => {});

    // No auto-start: the refused build stays refused until the user acts again.
    expect(h.wpCalls()).toBe(1);
    expect(h.cancel).not.toHaveBeenCalled();
  });
});
