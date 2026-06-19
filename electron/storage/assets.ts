import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type Database from 'better-sqlite3';

import type { Asset, AssetKind } from '@shared/types';

import { confinedAssetPath, removeBlobFile, removeSessionDir, writeBlobFile } from './blob-io';

interface AssetRow {
  id: string;
  session_id: string;
  kind: string;
  relative_path: string;
  created_at: number;
}

type Clock = () => number;
type IdGenerator = () => string;

/*
 * Data access for a session's screenshot blobs (M02.B). Image bytes are written
 * as per-session files under the assets root; an `assets` row records the kind +
 * portable relative path. The database handle, assets root, clock, and id
 * generator are all injected (no module-global state — docs/style.md), so writes
 * are deterministic under test.
 *
 * The on-disk filename is ALWAYS derived from a generated id + a sanitized
 * extension — never from user input — so a malicious name can't traverse the
 * tree (path-traversal class, gotcha + M02.B scope lock). saveBlob rejects an
 * unknown session before touching disk, then writes the file and inserts the
 * row; a failed insert unlinks the file (FK backstop), so there is never a blob
 * without a row.
 */
export class AssetStore {
  private readonly db: Database.Database;
  private readonly assetsRoot: string;
  private readonly now: Clock;
  private readonly newId: IdGenerator;

  constructor(
    db: Database.Database,
    assetsRoot: string,
    now: Clock = Date.now,
    newId: IdGenerator = randomUUID,
  ) {
    this.db = db;
    this.assetsRoot = assetsRoot;
    this.now = now;
    this.newId = newId;
  }

  saveBlob(sessionId: string, kind: AssetKind, bytes: Uint8Array, ext: string): Asset {
    // Reject an unknown session BEFORE touching disk, so a bad call never leaves
    // an orphan blob file or an empty session directory behind. The FK on the
    // insert is the backstop; this is the clean front door.
    const exists = this.db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId);
    if (!exists) {
      throw new Error(`assets: unknown session ${sessionId}`);
    }

    const id = this.newId();
    const filename = `${id}.${sanitizeExtension(ext)}`;
    const absolutePath = confinedAssetPath(this.assetsRoot, sessionId, filename);
    if (!absolutePath) {
      throw new Error(`assets: refusing to write outside the assets root for session ${sessionId}`);
    }
    const relativePath = `${sessionId}/${filename}`;
    const createdAt = this.now();

    writeBlobFile(absolutePath, bytes);
    try {
      // Record the real byte size at write time (migration v6, F28) so the storage meter is a
      // single cheap query and never needs an fs walk. Pre-v6 rows are NULL until backfilled.
      this.db
        .prepare(
          'INSERT INTO assets (id, session_id, kind, relative_path, created_at, byte_size) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(id, sessionId, kind, relativePath, createdAt, bytes.byteLength);
    } catch (error) {
      removeBlobFile(absolutePath);
      throw error;
    }
    return { id, sessionId, kind, relativePath, createdAt };
  }

  listAssets(sessionId: string): Asset[] {
    const rows = this.db
      .prepare('SELECT * FROM assets WHERE session_id = ? ORDER BY created_at, id')
      .all(sessionId) as AssetRow[];
    return rows.map(toAsset);
  }

  deleteAsset(id: string): void {
    const row = this.db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as
      | AssetRow
      | undefined;
    if (!row) {
      return;
    }
    removeBlobFile(join(this.assetsRoot, row.relative_path));
    this.db.prepare('DELETE FROM assets WHERE id = ?').run(id);
  }

  /*
   * Removes a session's blob directory. The FK cascade drops the asset ROWS when
   * a session is deleted, but not the FILES — main.ts wires this into the session
   * delete path so deleting a session leaves no orphan blobs. Idempotent.
   */
  removeSessionAssets(sessionId: string): void {
    removeSessionDir(this.assetsRoot, sessionId);
  }
}

function sanitizeExtension(ext: string): string {
  const cleaned = ext.toLowerCase().replace(/[^a-z0-9]/g, '');
  return cleaned.slice(0, 5) || 'bin';
}

function toAsset(row: AssetRow): Asset {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind as AssetKind,
    relativePath: row.relative_path,
    createdAt: row.created_at,
  };
}
