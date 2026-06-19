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
