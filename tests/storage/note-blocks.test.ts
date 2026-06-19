import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../electron/storage/db';
import { NoteStore } from '../../electron/storage/notes';
import { SessionStore } from '../../electron/storage/sessions';

// A strictly increasing clock keeps created_at ordering deterministic without
// the wall clock (docs/style.md — no reliance on real time without seeding).
function incrementingClock(start = 1_000): () => number {
  let value = start;
  return () => value++;
}

let dir: string;
let db: ReturnType<typeof openDatabase>;
let sessions: SessionStore;
let notes: NoteStore;
let sessionId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-noteblocks-'));
  db = openDatabase(join(dir, 'store.db'));
  sessions = new SessionStore(db, incrementingClock());
  notes = new NoteStore(db, incrementingClock(5_000));
  sessionId = sessions.createSession('Capture').id;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('NoteStore add / list', () => {
  it('adds an empty block and lists it for the session', () => {
    const block = notes.addNote(sessionId);

    expect(block.sessionId).toBe(sessionId);
    expect(block.content).toBe('');
    expect(notes.listNotes(sessionId).map((n) => n.id)).toEqual([block.id]);
  });

  it('lists blocks in insertion (position) order', () => {
    const a = notes.addNote(sessionId);
    const b = notes.addNote(sessionId);
    const c = notes.addNote(sessionId);

    expect(notes.listNotes(sessionId).map((n) => n.id)).toEqual([a.id, b.id, c.id]);
  });

  it('scopes listing to the session', () => {
    const other = sessions.createSession('Other').id;
    const mine = notes.addNote(sessionId);
    notes.addNote(other);

    expect(notes.listNotes(sessionId).map((n) => n.id)).toEqual([mine.id]);
  });
});

describe('NoteStore addNoteWithContent', () => {
  it('adds a block seeded with content, appended after existing blocks', () => {
    const a = notes.addNote(sessionId);
    const seeded = notes.addNoteWithContent(sessionId, 'meeting.txt\n\nhello world');

    expect(seeded.content).toBe('meeting.txt\n\nhello world');
    expect(notes.listNotes(sessionId).map((n) => n.id)).toEqual([a.id, seeded.id]);
  });

  it('round-trips seeded content exactly (newlines + unicode) across close → reopen', () => {
    const content = 'notes.md\n\nline — café 🎤\r\nnext line';
    const seeded = notes.addNoteWithContent(sessionId, content);
    const dbPath = join(dir, 'store.db');
    db.close();

    const reopened = openDatabase(dbPath);
    try {
      const store = new NoteStore(reopened);
      expect(store.listNotes(sessionId).find((n) => n.id === seeded.id)?.content).toBe(content);
    } finally {
      reopened.close();
      db = openDatabase(dbPath); // keep the afterEach close() handle live
    }
  });
});

describe('NoteStore update', () => {
  it('persists updated content for one block', () => {
    const a = notes.addNote(sessionId);
    const b = notes.addNote(sessionId);

    const updated = notes.updateNote(a.id, 'first block text');

    expect(updated.content).toBe('first block text');
    expect(updated.id).toBe(a.id);
    const listed = notes.listNotes(sessionId);
    expect(listed.find((n) => n.id === a.id)?.content).toBe('first block text');
    expect(listed.find((n) => n.id === b.id)?.content).toBe('');
  });

  it('throws when updating a block that does not exist', () => {
    expect(() => notes.updateNote('no-such-block', 'x')).toThrow();
  });
});

describe('NoteStore delete', () => {
  it('removes one block and leaves its siblings', () => {
    const a = notes.addNote(sessionId);
    const b = notes.addNote(sessionId);
    const c = notes.addNote(sessionId);

    notes.deleteNote(b.id);

    expect(notes.listNotes(sessionId).map((n) => n.id)).toEqual([a.id, c.id]);
  });

  it('cascades: deleting the session removes all of its blocks', () => {
    notes.addNote(sessionId);
    notes.addNote(sessionId);

    sessions.deleteSession(sessionId);

    expect(notes.listNotes(sessionId)).toEqual([]);
  });
});

describe('NoteStore reorder', () => {
  it('rewrites positions so list reflects the new order', () => {
    const a = notes.addNote(sessionId);
    const b = notes.addNote(sessionId);
    const c = notes.addNote(sessionId);

    notes.reorderNotes(sessionId, [c.id, a.id, b.id]);

    expect(notes.listNotes(sessionId).map((n) => n.id)).toEqual([c.id, a.id, b.id]);
  });

  it('keeps positions contiguous and unique after a reorder', () => {
    const a = notes.addNote(sessionId);
    const b = notes.addNote(sessionId);
    const c = notes.addNote(sessionId);

    notes.reorderNotes(sessionId, [b.id, c.id, a.id]);

    const positions = db
      .prepare('SELECT position FROM notes WHERE session_id = ? ORDER BY position')
      .all(sessionId) as Array<{ position: number }>;
    expect(positions.map((p) => p.position)).toEqual([0, 1, 2]);
  });

  it('rejects an order that is not a permutation of the session blocks, with no partial write', () => {
    const a = notes.addNote(sessionId);
    const b = notes.addNote(sessionId);
    const before = notes.listNotes(sessionId).map((n) => n.id);

    // Missing an id → must throw and leave positions untouched (single txn).
    expect(() => notes.reorderNotes(sessionId, [b.id])).toThrow();
    expect(notes.listNotes(sessionId).map((n) => n.id)).toEqual(before);

    // Foreign id → likewise rejected.
    expect(() => notes.reorderNotes(sessionId, [a.id, b.id, 'not-a-block'])).toThrow();
    expect(notes.listNotes(sessionId).map((n) => n.id)).toEqual(before);
  });

  it('rolls back every position write when one update fails mid-batch (transaction atomicity)', () => {
    const a = notes.addNote(sessionId);
    const b = notes.addNote(sessionId);
    const c = notes.addNote(sessionId);
    const before = notes.listNotes(sessionId).map((n) => n.id); // [a, b, c]

    // Fault injection: abort the moment any row is set to position 1 — i.e. mid
    // way through the batch rewrite of [c, a, b] → positions 0,1,2. With a single
    // transaction the first write (c → 0) must roll back; a per-row loop would
    // leave c at 0 and corrupt the order.
    db.exec(
      "CREATE TRIGGER fail_mid_reorder BEFORE UPDATE ON notes WHEN NEW.position = 1 BEGIN SELECT RAISE(ABORT, 'boom'); END;",
    );
    try {
      expect(() => notes.reorderNotes(sessionId, [c.id, a.id, b.id])).toThrow();
    } finally {
      db.exec('DROP TRIGGER fail_mid_reorder;');
    }

    // No partial write: the original order/positions survive the aborted batch.
    expect(notes.listNotes(sessionId).map((n) => n.id)).toEqual(before);
    const positions = db
      .prepare('SELECT position FROM notes WHERE session_id = ? ORDER BY position')
      .all(sessionId) as Array<{ position: number }>;
    expect(positions.map((p) => p.position)).toEqual([0, 1, 2]);
  });

  it('survives close → reopen with the reordered sequence intact', () => {
    const a = notes.addNote(sessionId);
    const b = notes.addNote(sessionId);
    const c = notes.addNote(sessionId);
    notes.reorderNotes(sessionId, [c.id, b.id, a.id]);
    const dbPath = join(dir, 'store.db');
    db.close();

    const reopened = openDatabase(dbPath);
    try {
      const reopenedNotes = new NoteStore(reopened);
      expect(reopenedNotes.listNotes(sessionId).map((n) => n.id)).toEqual([c.id, b.id, a.id]);
    } finally {
      reopened.close();
      // Re-open so the afterEach close() has a live handle.
      db = openDatabase(dbPath);
    }
  });
});
