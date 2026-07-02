// @vitest-environment jsdom
import { useState, type ReactElement } from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastHost } from '../../src/components/ToastHost';
import { useDeferredDelete } from '../../src/hooks/useDeferredDelete';
import { ToastProvider } from '../../src/hooks/useToasts';

/*
 * Deferred-delete (M06.B, REVIEW-V11 F10 — Gmail-style undo). A delete is optimistic: the item
 * leaves the UI immediately and the real delete fires only when the undo grace window elapses;
 * Undo cancels it (nothing was ever deleted). RED pins (owner):
 *   #2 — a real-delete FAILURE on commit RESTORES the optimistically-removed item to the UI AND
 *        raises an error toast, so the UI never desyncs from storage.
 */
const GRACE_MS = 6000;

// A tiny list + the hook. "Delete" optimistically removes the item and registers the deferred
// commit; `restore` re-adds it. `commit` is the spy under test.
function Harness({ commit }: { commit: () => Promise<void> }): ReactElement {
  const [items, setItems] = useState<string[]>(['Note A']);
  const { remove } = useDeferredDelete();

  const onDelete = (): void => {
    setItems([]); // optimistic removal
    remove({
      key: 'del-note',
      label: 'Note deleted',
      graceMs: GRACE_MS,
      errorMessage: "Couldn't delete note",
      commit,
      restore: () => setItems(['Note A']),
    });
  };

  return (
    <div>
      <ul>
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
      <button type="button" onClick={onDelete}>
        delete
      </button>
    </div>
  );
}

function mount(commit: () => Promise<void>): void {
  render(
    <ToastProvider>
      <Harness commit={commit} />
      <ToastHost />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDeferredDelete', () => {
  it('removes the item optimistically and shows an Undo toast without committing yet', () => {
    const commit = vi.fn(() => Promise.resolve());
    mount(commit);

    fireEvent.click(screen.getByRole('button', { name: 'delete' }));

    expect(screen.queryByText('Note A')).toBeNull();
    expect(screen.getByText('Note deleted')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(commit).not.toHaveBeenCalled();
  });

  it('Undo restores the item and never commits', () => {
    const commit = vi.fn(() => Promise.resolve());
    mount(commit);

    fireEvent.click(screen.getByRole('button', { name: 'delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    expect(screen.getByText('Note A')).toBeInTheDocument();
    // Even after the grace window passes, a cancelled delete never fires.
    act(() => vi.advanceTimersByTime(GRACE_MS * 2));
    expect(commit).not.toHaveBeenCalled();
  });

  it('commits exactly once when the grace window elapses untouched', async () => {
    const commit = vi.fn(() => Promise.resolve());
    mount(commit);

    fireEvent.click(screen.getByRole('button', { name: 'delete' }));
    await act(async () => {
      vi.advanceTimersByTime(GRACE_MS);
    });

    expect(commit).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Note deleted')).toBeNull(); // undo toast cleared
  });

  it('restores the item and raises an error toast when the real delete fails (#2 no desync)', async () => {
    const commit = vi.fn(() => Promise.reject(new Error('disk full')));
    mount(commit);

    fireEvent.click(screen.getByRole('button', { name: 'delete' }));
    expect(screen.queryByText('Note A')).toBeNull(); // optimistically gone

    await act(async () => {
      vi.advanceTimersByTime(GRACE_MS);
    });

    // The failed commit puts it back AND tells the user.
    expect(screen.getByText('Note A')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't delete note");
  });
});

/*
 * Unmount behavior (M10.B ext#3). A pending removal caught mid-grace by an unmount takes one of two
 * routes: 'cancel' (the byte-unchanged default — note/session/bulk delete: the delete simply doesn't
 * happen, data-preserving) or 'commit' (opt-in — fire commit() immediately, dismiss the toast, no
 * restore; the price-delete's Gmail-style "closing the view commits the pending undo" semantics).
 * The ToastProvider stays mounted (like the app-level host surviving a Settings-modal close); only
 * the Panel using the hook unmounts.
 */
function Panel({
  commit,
  restore,
  onUnmount,
}: {
  commit: () => Promise<void>;
  restore: () => void;
  onUnmount?: 'commit' | 'cancel';
}): ReactElement {
  const { remove } = useDeferredDelete();
  return (
    <button
      type="button"
      onClick={() =>
        remove({
          key: 'del-x',
          label: 'Removed',
          graceMs: GRACE_MS,
          errorMessage: "Couldn't remove",
          commit,
          restore,
          // Only set onUnmount when provided (exactOptionalPropertyTypes rejects explicit undefined).
          ...(onUnmount ? { onUnmount } : {}),
        })
      }
    >
      delete
    </button>
  );
}

function UnmountHarness({
  commit,
  restore,
  onUnmount,
}: {
  commit: () => Promise<void>;
  restore: () => void;
  onUnmount?: 'commit' | 'cancel';
}): ReactElement {
  const [open, setOpen] = useState(true);
  return (
    <ToastProvider>
      {open && <Panel commit={commit} restore={restore} {...(onUnmount ? { onUnmount } : {})} />}
      <ToastHost />
      <button type="button" onClick={() => setOpen(false)}>
        close
      </button>
    </ToastProvider>
  );
}

describe('useDeferredDelete — unmount behavior (M10.B ext#3)', () => {
  it("onUnmount:'commit' fires commit() once, dismisses the toast, and does NOT restore", async () => {
    const commit = vi.fn(() => Promise.resolve());
    const restore = vi.fn();
    render(<UnmountHarness commit={commit} restore={restore} onUnmount="commit" />);

    fireEvent.click(screen.getByRole('button', { name: 'delete' }));
    expect(screen.getByText('Removed')).toBeInTheDocument();
    expect(commit).not.toHaveBeenCalled();

    // Close the view while the Undo toast is still pending → flush the commit now (no grace wait).
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'close' }));
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(restore).not.toHaveBeenCalled(); // the UI is gone — nothing to restore
    expect(screen.queryByText('Removed')).toBeNull(); // toast dismissed on flush

    // The grace timer was cleared on flush — advancing does not fire a second commit.
    await act(async () => {
      vi.advanceTimersByTime(GRACE_MS * 2);
    });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('default (no onUnmount) still clears WITHOUT committing on unmount — regression pin', () => {
    const commit = vi.fn(() => Promise.resolve());
    const restore = vi.fn();
    render(<UnmountHarness commit={commit} restore={restore} />);

    fireEvent.click(screen.getByRole('button', { name: 'delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'close' })); // unmount before grace
    act(() => vi.advanceTimersByTime(GRACE_MS * 2));

    // Data-preserving default is byte-unchanged: the delete never happened.
    expect(commit).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it("onUnmount:'commit' with a rejecting commit raises the error toast on unmount", async () => {
    const commit = vi.fn(() => Promise.reject(new Error('disk full')));
    const restore = vi.fn();
    render(<UnmountHarness commit={commit} restore={restore} onUnmount="commit" />);

    fireEvent.click(screen.getByRole('button', { name: 'delete' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'close' }));
    });

    expect(commit).toHaveBeenCalledTimes(1);
    expect(restore).not.toHaveBeenCalled(); // no restore even on failure — the UI is gone
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't remove");
  });
});
