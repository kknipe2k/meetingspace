// @vitest-environment jsdom
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GenProgress, GenStatus, LlmErrorPayload } from '@shared/types';

import { GenerationStatusToast } from '../../src/components/GenerationStatusToast';
import { ToastHost } from '../../src/components/ToastHost';
import { ToastProvider } from '../../src/hooks/useToasts';

/*
 * M07.B (product-owner reversal at IRL) — the app-level run-status controller. The
 * rejected first build owned the run/cancel toast INSIDE the modal, so it blinked and
 * vanished with the modal's mount/unmount (and StrictMode's double-mount). The fix: an
 * always-mounted controller fed by main-side run lifecycle (gen:run-started / gen:run-
 * ended). While any run is live it shows ONE persistent toast — kind + elapsed m:ss +
 * Cancel — that is INDEPENDENT of any modal (visible inside and outside, surviving a
 * modal close). This is the new contract; F14's auto-start remedy was rescinded.
 */
interface RunEnded {
  requestId: string;
  error?: LlmErrorPayload;
}

interface Harness {
  client: {
    onRunStarted(l: (r: GenStatus) => void): () => void;
    onRunEnded(l: (e: RunEnded) => void): () => void;
    onProgress(l: (e: { requestId: string; progress: GenProgress }) => void): () => void;
    cancel(requestId: string): void;
  };
  emitStarted(run: GenStatus): void;
  emitEnded(requestId: string, error?: LlmErrorPayload): void;
  emitProgress(requestId: string, progress: GenProgress): void;
  cancel: ReturnType<typeof vi.fn>;
}

function harness(): Harness {
  let started: ((r: GenStatus) => void) | null = null;
  let ended: ((e: RunEnded) => void) | null = null;
  let progressed: ((e: { requestId: string; progress: GenProgress }) => void) | null = null;
  const cancel = vi.fn();
  return {
    client: {
      onRunStarted: (l) => {
        started = l;
        return () => undefined;
      },
      onRunEnded: (l) => {
        ended = l;
        return () => undefined;
      },
      onProgress: (l) => {
        progressed = l;
        return () => undefined;
      },
      cancel,
    },
    emitStarted: (run) => act(() => started?.(run)),
    emitEnded: (requestId, error) => act(() => ended?.({ requestId, ...(error ? { error } : {}) })),
    emitProgress: (requestId, progress) => act(() => progressed?.({ requestId, progress })),
    cancel,
  };
}

// Resolves the session name shown in the toast (carry-in 2 — attributable runs).
const sessionName = (id: string): string | undefined => (id === 's1' ? 'Q3 Planning' : undefined);

const RUN: GenStatus = {
  requestId: 'live-1',
  sessionId: 's1',
  kind: 'whitepaper',
  progress: null,
  startedAt: 1_000_000,
};

// The controller is the only thing under test; cast the partial client to the gen surface.
function mount(h: Harness, withModal = true) {
  return render(
    <ToastProvider>
      <GenerationStatusToast client={h.client as never} sessionName={sessionName} />
      {withModal && <div data-testid="modal">the open modal</div>}
      <ToastHost />
    </ToastProvider>,
  );
}

function host(): HTMLElement {
  return screen.getByTestId('toast-host');
}

afterEach(() => vi.useRealTimers());

describe('GenerationStatusToast — app-level persistent run toast', () => {
  it('shows a persistent toast on gen:run-started — session name + kind + elapsed m:ss + Cancel', () => {
    vi.useFakeTimers();
    vi.setSystemTime(RUN.startedAt + 5_000); // 5s into the run
    const h = harness();
    mount(h);

    h.emitStarted(RUN);

    const toast = host();
    expect(toast).toHaveTextContent(/Q3 Planning/); // carry-in 2: attributable by session
    expect(toast).toHaveTextContent(/white paper/i);
    expect(toast).toHaveTextContent(/0:05/); // elapsed m:ss
    expect(within(toast).getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });

  it('the toast is INDEPENDENT of the modal — it persists when the modal unmounts', () => {
    vi.useFakeTimers();
    vi.setSystemTime(RUN.startedAt);
    const h = harness();
    const { rerender } = mount(h, true);
    h.emitStarted(RUN);
    expect(host()).toHaveTextContent(/white paper/i);

    // Close the modal (unmount it). The controller is a sibling — the toast must remain.
    rerender(
      <ToastProvider>
        <GenerationStatusToast client={h.client as never} />
        <ToastHost />
      </ToastProvider>,
    );
    expect(screen.queryByTestId('modal')).toBeNull();
    expect(host()).toHaveTextContent(/white paper/i);
  });

  it('elapsed ticks up while the run is live', () => {
    vi.useFakeTimers();
    vi.setSystemTime(RUN.startedAt);
    const h = harness();
    mount(h);
    h.emitStarted(RUN);
    expect(host()).toHaveTextContent(/0:00/);

    act(() => {
      // advanceTimersByTime also advances the fake clock by 1000ms → lands at +65_000 (1:05).
      vi.setSystemTime(RUN.startedAt + 64_000);
      vi.advanceTimersByTime(1000);
    });
    expect(host()).toHaveTextContent(/1:05/);
  });

  it('gen:run-ended removes the toast', () => {
    vi.useFakeTimers();
    vi.setSystemTime(RUN.startedAt);
    const h = harness();
    mount(h);
    h.emitStarted(RUN);
    expect(host()).toHaveTextContent(/white paper/i);

    h.emitEnded(RUN.requestId);
    expect(host()).not.toHaveTextContent(/white paper/i);
  });

  it('Cancel invokes gen:cancel for the run requestId', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(RUN.startedAt);
    const h = harness();
    mount(h);
    h.emitStarted(RUN);

    await userEvent.click(within(host()).getByRole('button', { name: /cancel/i }));
    expect(h.cancel).toHaveBeenCalledWith('live-1');
  });

  it('on a TIMEOUT_CEILING end, lands an explanatory error toast (carry-in 1 — m:ss alone never tells the user a 20-minute limit exists)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(RUN.startedAt);
    const h = harness();
    mount(h);
    h.emitStarted(RUN);

    // The run hit the hard ceiling — main ends it with the tier error; even with the modal
    // closed, the user must learn WHY it stopped.
    h.emitEnded(RUN.requestId, {
      code: 'TIMEOUT_CEILING',
      message: 'Stopped after 20 minutes so it can’t run forever.',
    });

    // The live toast is gone; an explanatory error toast remains.
    expect(host()).not.toHaveTextContent(/0:00/);
    const alert = within(host()).getByRole('alert');
    expect(alert).toHaveTextContent(/20 minutes|stopped|limit/i);
  });

  it('a clean end leaves no error toast', () => {
    vi.useFakeTimers();
    vi.setSystemTime(RUN.startedAt);
    const h = harness();
    mount(h);
    h.emitStarted(RUN);
    h.emitEnded(RUN.requestId); // success — no error

    expect(within(host()).queryByRole('alert')).toBeNull();
  });

  it('a STEP-TAGGED failure lands its explanatory toast even with the modal closed (IRL fix #4 — no blind death)', () => {
    // The user's regen died typed-UNKNOWN with no visible reason. Now every
    // non-CANCELLED failure toasts its static step+validation copy.
    vi.useFakeTimers();
    vi.setSystemTime(RUN.startedAt);
    const h = harness();
    mount(h, false); // no modal mounted — the toast is the only surface
    h.emitStarted(RUN);

    h.emitEnded(RUN.requestId, {
      code: 'UNKNOWN',
      message: 'Styling the document failed — stylesheet validation.',
    });

    const alert = within(host()).getByRole('alert');
    expect(alert).toHaveTextContent(/Styling the document failed — stylesheet validation/);
  });

  it('a CANCELLED end never toasts (a cancel is the user’s own act, not news)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(RUN.startedAt);
    const h = harness();
    mount(h);
    h.emitStarted(RUN);

    h.emitEnded(RUN.requestId, { code: 'CANCELLED', message: 'Request cancelled.' });

    expect(within(host()).queryByRole('alert')).toBeNull();
  });

  it('chunked steps update the run toast IN PLACE (replace-by-key — M07.C, never a second toast)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(RUN.startedAt);
    const h = harness();
    mount(h);
    h.emitStarted(RUN);

    h.emitProgress(RUN.requestId, {
      step: 'section',
      index: 4,
      total: 10,
      label: 'Section 2 of 7 — Architecture',
    });
    expect(host()).toHaveTextContent(/Section 2 of 7 — Architecture/);

    h.emitProgress(RUN.requestId, {
      step: 'section',
      index: 5,
      total: 10,
      label: 'Section 3 of 7 — Rollout',
    });
    const toast = host();
    expect(toast).toHaveTextContent(/Section 3 of 7 — Rollout/);
    expect(toast).not.toHaveTextContent(/Section 2 of 7/);
    // Still ONE toast — the N section steps never stack notifications.
    expect(within(toast).getAllByRole('status')).toHaveLength(1);
  });
});
