import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Prefs } from '@shared/types';

/*
 * Non-secret, app-global preferences stored as a JSON file in userData (decision
 * M03.A: a flat key-value config is not relational, so it stays out of SQLite —
 * which also keeps the storage-schema §10 zone untouched). The API key NEVER lives
 * here; that is the encrypted secure-store blob. The path is injected so the store
 * is fully Node-testable; main.ts resolves the real userData path.
 *
 * `get()` never throws — a missing or corrupt file degrades to empty prefs rather
 * than crashing the settings surface. `set()` merges (atomic temp-then-rename).
 */
export class PrefsStore {
  constructor(private readonly filePath: string) {}

  get(): Prefs {
    if (!existsSync(this.filePath)) {
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      return isPrefsObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  set(prefs: Prefs): Prefs {
    const merged: Prefs = { ...this.get(), ...prefs };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(merged), 'utf8');
    renameSync(tmp, this.filePath);
    return merged;
  }
}

function isPrefsObject(value: unknown): value is Prefs {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
