import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PrefsStore } from '../../electron/prefs-store';

// Non-secret app-global preferences (model selection lands in Stage D). Stored as
// a JSON file in userData — NOT SQLite (decision M03.A: keeps the storage-schema
// §10 zone untouched; the key never goes here regardless). The seam takes an
// explicit path so it is fully Node-testable.
let dir: string;
let prefsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-prefs-'));
  prefsPath = join(dir, 'settings.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('PrefsStore', () => {
  it('returns empty prefs when no file exists yet', () => {
    expect(new PrefsStore(prefsPath).get()).toEqual({});
  });

  it('persists a pref and reads it back through a fresh instance', () => {
    new PrefsStore(prefsPath).set({ chatModel: 'claude-haiku-4-5' });

    expect(new PrefsStore(prefsPath).get()).toEqual({ chatModel: 'claude-haiku-4-5' });
  });

  it('merges on set rather than overwriting unrelated keys', () => {
    const store = new PrefsStore(prefsPath);
    store.set({ chatModel: 'claude-haiku-4-5' });

    const merged = store.set({ generationModel: 'claude-opus-4-8' });

    expect(merged).toEqual({ chatModel: 'claude-haiku-4-5', generationModel: 'claude-opus-4-8' });
    expect(store.get()).toEqual(merged);
  });

  it('writes valid JSON to disk', () => {
    new PrefsStore(prefsPath).set({ chatModel: 'claude-haiku-4-5' });

    expect(JSON.parse(readFileSync(prefsPath, 'utf8'))).toEqual({ chatModel: 'claude-haiku-4-5' });
  });

  it('tolerates a corrupt prefs file by falling back to empty (never throws on get)', () => {
    writeFileSync(prefsPath, '{ this is not valid json');

    expect(new PrefsStore(prefsPath).get()).toEqual({});
  });
});
