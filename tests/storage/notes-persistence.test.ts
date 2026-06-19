import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../electron/storage/db';
import { NoteStore } from '../../electron/storage/notes';
import { SessionStore } from '../../electron/storage/sessions';

// The headline guarantee at the storage level (now multi-block, M02.A): note
// blocks written to the file survive the process losing its handle. We prove it
// by closing the database and reopening the same file (a relaunch in miniature),
// complementing the full-app close→reopen Playwright e2e (tests/e2e/*).
let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-notes-'));
  dbPath = join(dir, 'store.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('note-block persistence across reopen', () => {
  it('reads back saved block content, in order, after closing and reopening the file', () => {
    const first = openDatabase(dbPath);
    const sessionId = new SessionStore(first).createSession('Sprint planning').id;
    const notes = new NoteStore(first);
    const a = notes.addNote(sessionId);
    const b = notes.addNote(sessionId);
    notes.updateNote(a.id, 'first');
    notes.updateNote(b.id, 'second');
    first.close();

    const reopened = openDatabase(dbPath);
    try {
      const listed = new NoteStore(reopened).listNotes(sessionId);
      expect(listed.map((n) => [n.id, n.content])).toEqual([
        [a.id, 'first'],
        [b.id, 'second'],
      ]);
    } finally {
      reopened.close();
    }
  });

  it('persists the latest content when a block is overwritten before reopen', () => {
    const first = openDatabase(dbPath);
    const sessionId = new SessionStore(first).createSession('Notes').id;
    const notes = new NoteStore(first);
    const block = notes.addNote(sessionId);
    notes.updateNote(block.id, 'draft');
    notes.updateNote(block.id, 'final');
    first.close();

    const reopened = openDatabase(dbPath);
    try {
      expect(new NoteStore(reopened).listNotes(sessionId)[0]?.content).toBe('final');
    } finally {
      reopened.close();
    }
  });
});
