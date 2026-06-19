// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NotesApi } from '@shared/api';
import type { Note } from '@shared/types';

import { NoteBlocks } from '../../src/components/NoteBlocks';
import { ToastHost } from '../../src/components/ToastHost';
import { ToastProvider } from '../../src/hooks/useToasts';

afterEach(() => {
  vi.useRealTimers();
});

// A fake notes client backed by an in-memory list, capturing reorder/update
// calls so the container's wiring (load → add/delete/reorder, per-block save) is
// exercised at the renderer level without a real window.api.
function note(id: string, content = '', sessionId = 's1'): Note {
  return { id, sessionId, content, createdAt: 1, updatedAt: 1 };
}

function fakeNotes(seed: Note[]): {
  client: NotesApi;
  reorders: string[][];
  updates: Array<{ id: string; content: string }>;
  deleted: string[];
  seeded: string[];
  added: number;
} {
  let rows = [...seed];
  let seq = seed.length;
  const reorders: string[][] = [];
  const updates: Array<{ id: string; content: string }> = [];
  const deleted: string[] = [];
  const seeded: string[] = [];
  const state = { added: 0 };
  return {
    reorders,
    updates,
    deleted,
    seeded,
    get added() {
      return state.added;
    },
    client: {
      list: () => Promise.resolve([...rows]),
      add: (sessionId) => {
        state.added += 1;
        seq += 1;
        const created = note(`n${seq}`, '', sessionId);
        rows.push(created);
        return Promise.resolve(created);
      },
      addWithContent: (sessionId, content) => {
        seeded.push(content);
        seq += 1;
        const created = note(`n${seq}`, content, sessionId);
        rows.push(created);
        return Promise.resolve(created);
      },
      update: (id, content) => {
        updates.push({ id, content });
        return Promise.resolve(note(id, content));
      },
      updateSync: (id, content) => {
        updates.push({ id, content });
        return note(id, content);
      },
      delete: (id) => {
        deleted.push(id);
        rows = rows.filter((r) => r.id !== id);
        return Promise.resolve();
      },
      reorder: (_sessionId, orderedIds) => {
        reorders.push(orderedIds);
        return Promise.resolve();
      },
    },
  };
}

let fake: ReturnType<typeof fakeNotes>;

beforeEach(() => {
  fake = fakeNotes([note('a', 'alpha'), note('b', 'beta'), note('c', 'gamma')]);
});

function blocks(): HTMLElement[] {
  return screen.getAllByTestId('note-block');
}

describe('NoteBlocks', () => {
  it('renders the session blocks in order', async () => {
    render(<NoteBlocks sessionId="s1" client={fake.client} />);

    await waitFor(() => expect(blocks()).toHaveLength(3));
    expect(screen.getByRole('textbox', { name: 'Note 1' })).toHaveValue('alpha');
    expect(screen.getByRole('textbox', { name: 'Note 3' })).toHaveValue('gamma');
  });

  it('appends a new block when "Add note or transcript" is clicked', async () => {
    const user = userEvent.setup();
    render(<NoteBlocks sessionId="s1" client={fake.client} />);
    await waitFor(() => expect(blocks()).toHaveLength(3));

    await user.click(screen.getByRole('button', { name: 'Add note or transcript' }));

    await waitFor(() => expect(blocks()).toHaveLength(4));
    expect(fake.added).toBe(1);
  });

  it('uploads a text file as a seeded block, named from the filename (filename-header)', async () => {
    render(<NoteBlocks sessionId="s1" client={fake.client} />);
    await waitFor(() => expect(blocks()).toHaveLength(3));

    fireEvent.change(screen.getByLabelText('Add note or transcript file'), {
      target: { files: [new File(['hello body'], 'meeting.md', { type: 'text/markdown' })] },
    });

    await waitFor(() => expect(fake.seeded).toEqual(['meeting.md\n\nhello body']));
    await waitFor(() => expect(blocks()).toHaveLength(4));
  });

  it('ignores a non-text file upload', async () => {
    render(<NoteBlocks sessionId="s1" client={fake.client} />);
    await waitFor(() => expect(blocks()).toHaveLength(3));

    fireEvent.change(screen.getByLabelText('Add note or transcript file'), {
      target: { files: [new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' })] },
    });

    await Promise.resolve();
    expect(fake.seeded).toEqual([]);
  });

  it('autosaves an edited block once after the debounce', async () => {
    const user = userEvent.setup();
    render(<NoteBlocks sessionId="s1" client={fake.client} />);
    await waitFor(() => expect(blocks()).toHaveLength(3));

    await user.type(screen.getByRole('textbox', { name: 'Note 1' }), '!');
    expect(fake.updates).toEqual([]); // debounce window not yet elapsed

    await waitFor(() => expect(fake.updates.at(-1)).toEqual({ id: 'a', content: 'alpha!' }));
  });

  // M06.B (F10): delete is deferred-with-Undo — the block is removed optimistically and an Undo
  // toast appears; the real delete fires only when the grace window elapses.
  it('deletes a block deferred-with-Undo (optimistic removal, Undo toast, commit after grace)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <ToastProvider>
        <NoteBlocks sessionId="s1" client={fake.client} />
        <ToastHost />
      </ToastProvider>,
    );
    await waitFor(() => expect(blocks()).toHaveLength(3));

    fireEvent.click(screen.getByRole('button', { name: 'Delete note 2' }));

    // Optimistically gone + Undo offered, but NOT yet committed.
    await waitFor(() => expect(blocks()).toHaveLength(2));
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(fake.deleted).toEqual([]);

    // The real delete fires when the grace window elapses (default 30s).
    await act(async () => {
      vi.advanceTimersByTime(30000);
    });
    expect(fake.deleted).toEqual(['b']);
  });

  it('re-lists when reloadToken changes (an externally-added note appears without leaving the session)', async () => {
    const { rerender } = render(<NoteBlocks sessionId="s1" client={fake.client} reloadToken={0} />);
    await waitFor(() => expect(blocks()).toHaveLength(3));

    // A note is added out-of-band — e.g. "Save to notes" from the chat panel
    // (M03.D fix): the canvas must reflect it without a session switch.
    await fake.client.addWithContent('s1', '**Q:** hi\n\n**A:** yo');
    rerender(<NoteBlocks sessionId="s1" client={fake.client} reloadToken={1} />);

    await waitFor(() => expect(blocks()).toHaveLength(4));
  });

  it('persists a reorder with the new id order when a block is dropped onto another', async () => {
    render(<NoteBlocks sessionId="s1" client={fake.client} />);
    await waitFor(() => expect(blocks()).toHaveLength(3));

    // Drag the last block's handle and drop it onto the first block (last→first).
    const all = blocks();
    const lastHandle = within(all[2]!).getByRole('button', { name: 'Reorder note 3' });
    fireEvent.dragStart(lastHandle);
    fireEvent.drop(all[0]!);

    await waitFor(() => expect(fake.reorders).toEqual([['c', 'a', 'b']]));
    // The UI reflects the new order too.
    expect(screen.getByRole('textbox', { name: 'Note 1' })).toHaveValue('gamma');
  });

  // F10: a reorder offers an Undo that reverts to the prior order.
  it('offers Undo after a reorder and reverts to the prior order on Undo', async () => {
    render(
      <ToastProvider>
        <NoteBlocks sessionId="s1" client={fake.client} />
        <ToastHost />
      </ToastProvider>,
    );
    await waitFor(() => expect(blocks()).toHaveLength(3));

    const all = blocks();
    fireEvent.dragStart(within(all[2]!).getByRole('button', { name: 'Reorder note 3' }));
    fireEvent.drop(all[0]!);
    await waitFor(() => expect(fake.reorders).toEqual([['c', 'a', 'b']]));

    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));

    // The revert persists the original order and restores the UI.
    await waitFor(() =>
      expect(fake.reorders).toEqual([
        ['c', 'a', 'b'],
        ['a', 'b', 'c'],
      ]),
    );
    expect(screen.getByRole('textbox', { name: 'Note 1' })).toHaveValue('alpha');
  });
});
