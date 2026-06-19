import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import { MAX_NOTE_BYTES } from '@shared/limits';
import type { Note } from '@shared/types';

import { useDeferredDelete } from '../hooks/useDeferredDelete';
import { useMutationToast } from '../hooks/useMutationToast';
import { useToasts } from '../hooks/useToasts';
import { noteClient, type NoteClient } from '../ipc/client';

import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { NoteBlock } from './NoteBlock';
import { moveItem } from './reorder';

const MAX_NOTE_MB = Math.round(MAX_NOTE_BYTES / (1024 * 1024));

type LoadStatus = 'loading' | 'ready' | 'error';

export interface NoteBlocksProps {
  sessionId: string;
  client?: NoteClient;
  /** Bump to force a re-fetch (e.g. after a chat reply is saved as a note, M03.D). */
  reloadToken?: number;
}

const TEXT_EXTENSIONS = /\.(md|txt|vtt|srt)$/i;

// Accept a `.md`/`.txt`/`.vtt`/`.srt` (or any text/*) file. A .vtt/.srt can arrive
// with an empty MIME type, so fall back to the extension.
function isTextFile(file: File): boolean {
  return file.type.startsWith('text/') || TEXT_EXTENSIONS.test(file.name);
}

/*
 * The session's note surface: an ordered list of note blocks (M02.A — replaces
 * M01's single textarea). Loads the session's blocks on open, supports adding,
 * deleting, and HTML5 drag-to-reorder. Each block autosaves its own content;
 * this container owns add/delete/reorder. Blocks are keyed by id so a reorder
 * (or add/delete) reconciles without remounting siblings — in-flight edits in
 * other blocks are never lost.
 *
 * Render this keyed by session id (see SessionCanvas) so switching sessions
 * remounts with a fresh load.
 */
export function NoteBlocks({
  sessionId,
  client = noteClient,
  reloadToken = 0,
}: NoteBlocksProps): ReactElement {
  const [notes, setNotes] = useState<Note[]>([]);
  const [status, setStatus] = useState<LoadStatus>('loading');
  // Bumped by the error-state Retry to re-run the load (M05.A).
  const [retryToken, setRetryToken] = useState(0);
  const draggingId = useRef<string | null>(null);
  const { surface } = useMutationToast();
  const { remove: deferRemove } = useDeferredDelete();
  const { show } = useToasts();

  // Re-fetch on session change AND when reloadToken bumps (an out-of-band add, e.g.
  // a chat reply saved as a note — M03.D) or the Retry token bumps. Storage is the
  // source of truth; per-block edits autosave, so a re-list reflects them.
  useEffect(() => {
    let active = true;
    setStatus('loading');
    client
      .list(sessionId)
      .then((blocks) => {
        if (active) {
          setNotes(blocks);
          setStatus('ready');
        }
      })
      .catch(() => {
        if (active) {
          setStatus('error');
        }
      });
    return () => {
      active = false;
    };
  }, [client, sessionId, reloadToken, retryToken]);

  const handleAdd = useCallback(async (): Promise<void> => {
    const added = await surface(client.add(sessionId), "Couldn't add a note.");
    if (added) {
      setNotes((prev) => [...prev, added]);
    }
  }, [client, sessionId, surface]);

  // Upload a text file as a note block, seeded with the file's contents under a
  // filename header (notes have no name column, so the filename is the first line).
  // The block then persists/edits/reorders exactly like a typed note (M02.D).
  const handleUpload = useCallback(
    async (file: File): Promise<void> => {
      if (!isTextFile(file)) {
        return;
      }
      const content = `${file.name}\n\n${await file.text()}`;
      // Precheck the byte cap so an over-cap upload gets a precise, size-helpful message instead of
      // a generic failure (F13). The main boundary still enforces it authoritatively.
      if (new TextEncoder().encode(content).length > MAX_NOTE_BYTES) {
        show({
          variant: 'error',
          message: `This note or transcript is too large to save (limit ${MAX_NOTE_MB} MB).`,
        });
        return;
      }
      const added = await surface(
        () => client.addWithContent(sessionId, content),
        "Couldn't save the note or transcript.",
      );
      if (added) {
        setNotes((prev) => [...prev, added]);
      }
    },
    [client, sessionId, surface, show],
  );

  // Delete is deferred (F10): remove optimistically, offer Undo; the real delete fires only when
  // the grace window elapses. A failed delete restores the block (useDeferredDelete) — no desync.
  const handleDelete = useCallback(
    (id: string): void => {
      const index = notes.findIndex((note) => note.id === id);
      const removed = notes[index];
      if (!removed) {
        return;
      }
      setNotes((prev) => prev.filter((note) => note.id !== id));
      deferRemove({
        key: `note-del-${id}`,
        label: 'Note deleted',
        errorMessage: "Couldn't delete the note.",
        commit: () => client.delete(id),
        restore: () =>
          setNotes((prev) => {
            const next = [...prev];
            next.splice(Math.min(index, next.length), 0, removed);
            return next;
          }),
      });
    },
    [client, notes, deferRemove],
  );

  const handleDragStart = useCallback((id: string): void => {
    draggingId.current = id;
  }, []);

  const handleDropOn = useCallback(
    (targetId: string): void => {
      const sourceId = draggingId.current;
      draggingId.current = null;
      if (!sourceId || sourceId === targetId) {
        return;
      }
      const prev = notes;
      const prevOrder = prev.map((note) => note.id);
      const order = moveItem(prevOrder, sourceId, targetId);
      const byId = new Map(prev.map((note) => [note.id, note]));
      const next = order.map((id) => byId.get(id)).filter((note): note is Note => note != null);
      if (next.length !== prev.length) {
        return;
      }
      setNotes(next);
      client
        .reorder(sessionId, order)
        .then(() => {
          // F10 reorder undo: offer to revert to the prior order.
          show({
            key: `note-reorder-${sessionId}`,
            variant: 'info',
            message: 'Notes reordered',
            action: {
              label: 'Undo',
              onClick: () => {
                setNotes(prev);
                void surface(() => client.reorder(sessionId, prevOrder), "Couldn't reorder notes.");
              },
            },
          });
        })
        .catch(() => {
          setNotes(prev); // restore — the reorder didn't persist, so the UI must not claim it did
          show({ variant: 'error', message: "Couldn't reorder notes." });
        });
    },
    [client, sessionId, notes, show, surface],
  );

  return (
    <section className="note-blocks" aria-label="Notes" aria-busy={status === 'loading'}>
      {status === 'loading' && <p className="zone-loading">Loading notes…</p>}

      {status === 'error' && (
        <ErrorState
          className="note-blocks-error"
          message="Couldn't load notes for this session."
          onRetry={() => setRetryToken((token) => token + 1)}
        />
      )}

      {status === 'ready' && notes.length === 0 && (
        <EmptyState
          className="note-blocks-empty"
          headline="No notes yet"
          hint="Add a note or upload a transcript to start."
        />
      )}

      {status === 'ready' &&
        notes.map((note, i) => (
          <NoteBlock
            key={note.id}
            note={note}
            index={i + 1}
            client={client}
            onDelete={handleDelete}
            onDragStart={handleDragStart}
            onDropOn={handleDropOn}
          />
        ))}

      <div className="note-blocks-actions" hidden={status !== 'ready'}>
        <button
          type="button"
          className="btn btn-secondary note-blocks-add"
          onClick={() => void handleAdd()}
        >
          Add note or transcript
        </button>
        <label className="btn btn-secondary note-blocks-upload">
          Upload note or transcript
          <input
            type="file"
            accept=".md,.txt,.vtt,.srt,text/*"
            aria-label="Add note or transcript file"
            className="note-blocks-upload-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                void handleUpload(file);
              }
              event.target.value = '';
            }}
          />
        </label>
      </div>
    </section>
  );
}
