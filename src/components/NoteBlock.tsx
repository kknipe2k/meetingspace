import { useRef, useState, type ReactElement } from 'react';

import type { Note } from '@shared/types';

import { useAutosave } from '../hooks/useAutosave';
import { useToasts } from '../hooks/useToasts';
import type { NoteClient } from '../ipc/client';

export interface NoteBlockProps {
  note: Note;
  /** 1-based position, used for stable, unique accessible labels. */
  index: number;
  client: NoteClient;
  onDelete(id: string): void;
  onDragStart(id: string): void;
  onDropOn(id: string): void;
}

/*
 * One note block in the capture canvas (design.md §4 card: surface-raised, 1px
 * border, radius-lg, shadow-sm; shadow-md while draggable). Holds its own edit
 * state and autosaves through the typed notes client (debounced — the renderer
 * never touches storage directly). Reordering is HTML5-native: the drag handle
 * is draggable; the whole card is a drop target. Delete uses the same confirm
 * pattern as the M01 sidebar.
 *
 * Labels embed the 1-based index so each control is uniquely addressable; query
 * them with `{ exact: true }` to avoid the §7 sibling-over-match trap.
 */
export function NoteBlock({
  note,
  index,
  client,
  onDelete,
  onDragStart,
  onDropOn,
}: NoteBlockProps): ReactElement {
  const [content, setContent] = useState(note.content);
  const { show, dismiss } = useToasts();
  // Surface an autosave failure ONCE (F13 #4), not per debounce/blur: toast on the first failure,
  // suppress repeats until a save succeeds, then re-arm. A keyed, finite toast.
  const autosaveFailed = useRef(false);
  const toastKey = `note-autosave-${note.id}`;

  const flushSave = useAutosave(
    content,
    (value) => {
      client
        .update(note.id, value)
        .then(() => {
          if (autosaveFailed.current) {
            autosaveFailed.current = false;
            dismiss(toastKey);
          }
        })
        .catch(() => {
          if (!autosaveFailed.current) {
            autosaveFailed.current = true;
            show({ key: toastKey, variant: 'error', message: "Couldn't save your note changes." });
          }
        });
    },
    {
      // Teardown (app quit) flushes synchronously so an edit-then-quit isn't lost (D-03).
      saveSync: (value) => void client.updateSync(note.id, value),
    },
  );

  return (
    <article
      className="note-block"
      data-testid="note-block"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        onDropOn(note.id);
      }}
    >
      <div className="note-block-bar">
        <button
          type="button"
          className="btn-icon note-block-handle"
          aria-label={`Reorder note ${index}`}
          draggable
          onDragStart={() => onDragStart(note.id)}
        >
          ⠿
        </button>
        {/* Delete is immediate-with-Undo (F10): the parent removes the block optimistically and
            offers an Undo toast, so a destructive confirm is no longer needed. */}
        <button
          type="button"
          className="btn-icon btn-danger"
          aria-label={`Delete note ${index}`}
          onClick={() => onDelete(note.id)}
        >
          Delete
        </button>
      </div>
      <textarea
        className="note-block-text"
        aria-label={`Note ${index}`}
        placeholder="Type a note or transcript…"
        value={content}
        onChange={(event) => setContent(event.target.value)}
        onBlur={flushSave}
      />
    </article>
  );
}
