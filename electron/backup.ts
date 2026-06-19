import { gzipSync, gunzipSync } from 'node:zlib';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  renameSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, win32 } from 'node:path';

import type Database from 'better-sqlite3';

import type { BackupResult, RestoreResult } from '@shared/types';

/*
 * One-file backup/restore (M06.C). The whole store — the SQLite DB file + every asset blob — is
 * packed into ONE portable, version-stamped container; restore unpacks it. NO new dependency: a
 * magic-prefixed, gzip (node:zlib) JSON envelope.
 *
 * Layering, so the bulk is Node-testable (better-sqlite3 + node:fs run under Vitest):
 *  - container: buildBackupBlob / parseBackupBlob / checkBackupCompatibility — pure.
 *  - data: collectBackup (read DB file + walk asset blobs) / applyBackup (write them back) — fs.
 *  - service: createBackupService — orchestration over injected dialog/relaunch/close deps, so the
 *    only Electron OS pieces (save/open dialog, app.relaunch, db close) stay in main.ts.
 *
 * SAFETY: restore is DESTRUCTIVE (it REPLACES the current store), gated behind a confirm; a backup
 * whose schemaVersion is NEWER than this app's is REFUSED loudly (never imported) so an older app
 * can't be fed a future-shaped DB and corrupt it. Regenerable `.thumb.jpg` derivatives are excluded
 * from the container (they rebuild via the startup backfill on the restored store).
 */
export const BACKUP_MAGIC = 'MSBK1';

export interface BackupManifest {
  readonly format: 'msbackup';
  readonly formatVersion: number;
  readonly appVersion: string;
  readonly schemaVersion: number;
  readonly createdAt: number;
  readonly counts: {
    readonly sessions: number;
    readonly notes: number;
    readonly assets: number;
    readonly documents: number;
  };
}

export interface BackupAssetEntry {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

export interface BackupData {
  readonly manifest: BackupManifest;
  readonly dbBytes: Uint8Array;
  readonly assets: readonly BackupAssetEntry[];
}

interface BackupEnvelope {
  manifest: BackupManifest;
  db: string;
  assets: { relativePath: string; data: string }[];
}

export function buildBackupBlob(data: BackupData): Buffer {
  const envelope: BackupEnvelope = {
    manifest: data.manifest,
    db: Buffer.from(data.dbBytes).toString('base64'),
    assets: data.assets.map((a) => ({
      relativePath: a.relativePath,
      data: Buffer.from(a.bytes).toString('base64'),
    })),
  };
  const gz = gzipSync(Buffer.from(JSON.stringify(envelope), 'utf8'));
  return Buffer.concat([Buffer.from(BACKUP_MAGIC, 'latin1'), gz]);
}

export function parseBackupBlob(blob: Buffer): BackupData {
  const magic = blob.subarray(0, BACKUP_MAGIC.length).toString('latin1');
  if (magic !== BACKUP_MAGIC) {
    throw new Error('backup: not a MeetingSpace backup file (bad magic)');
  }
  let envelope: BackupEnvelope;
  try {
    const json = gunzipSync(blob.subarray(BACKUP_MAGIC.length)).toString('utf8');
    envelope = JSON.parse(json) as BackupEnvelope;
  } catch {
    throw new Error('backup: file is corrupt or not a valid backup');
  }
  if (!envelope?.manifest || envelope.manifest.format !== 'msbackup') {
    throw new Error('backup: missing or invalid manifest');
  }
  return {
    manifest: envelope.manifest,
    dbBytes: new Uint8Array(Buffer.from(envelope.db, 'base64')),
    assets: envelope.assets.map((a) => ({
      relativePath: a.relativePath,
      bytes: new Uint8Array(Buffer.from(a.data, 'base64')),
    })),
  };
}

export function checkBackupCompatibility(
  manifest: BackupManifest,
  currentSchemaVersion: number,
): 'ok' | 'incompatible' {
  return manifest.schemaVersion > currentSchemaVersion ? 'incompatible' : 'ok';
}

export interface CollectBackupInput {
  readonly db: Database.Database;
  readonly dbFilePath: string;
  readonly assetsRoot: string;
  readonly appVersion: string;
  readonly now?: () => number;
}

export function collectBackup(input: CollectBackupInput): BackupData {
  const { db, dbFilePath, assetsRoot, appVersion } = input;
  // Fold the WAL into the main file so the copied bytes are a consistent, consolidated DB.
  db.pragma('wal_checkpoint(TRUNCATE)');
  const dbBytes = new Uint8Array(readFileSync(dbFilePath));
  const assets = existsSync(assetsRoot) ? collectAssetBlobs(assetsRoot) : [];
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const manifest: BackupManifest = {
    format: 'msbackup',
    formatVersion: 1,
    appVersion,
    schemaVersion: db.pragma('user_version', { simple: true }) as number,
    createdAt: (input.now ?? Date.now)(),
    counts: {
      sessions: count('sessions'),
      notes: count('notes'),
      assets: count('assets'),
      documents: count('documents'),
    },
  };
  return { manifest, dbBytes, assets };
}

// Walk the assets root, collecting every blob as a posix relativePath + bytes, EXCLUDING the
// regenerable `.thumb.jpg` derivatives (they rebuild on the restored store).
function collectAssetBlobs(assetsRoot: string): BackupAssetEntry[] {
  const out: BackupAssetEntry[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), rel);
      } else if (entry.isFile() && !entry.name.endsWith('.thumb.jpg')) {
        out.push({ relativePath: rel, bytes: new Uint8Array(readFileSync(join(dir, entry.name))) });
      }
    }
  };
  walk(assetsRoot, '');
  return out;
}

/*
 * Confine a backup asset's `relativePath` to the staging root before it is written (S2-001 fix).
 * A `.msbackup` is untrusted input: its asset entries' paths come straight from the parsed file, so
 * a crafted `../../…` or absolute `relativePath` would otherwise escape staging via `join`/`resolve`
 * normalization and let `writeFileSync` land attacker bytes anywhere writable (zip-slip → arbitrary
 * file write). This mirrors storage/blob-io.ts `confinedAssetPath`: resolve, then reject anything
 * that climbs out (`..`), is absolute, or is empty. Returns the confined absolute path or null.
 */
export function confinedStagingPath(stagedRoot: string, relativePath: string): string | null {
  // Refuse outright anything that isn't a plain relative path: empty, an absolute/drive-rooted path
  // (`/etc/x`, `C:/x`), or any `.`/`..`/empty segment (`..` is the zip-slip climb; empty rejects a
  // leading-slash escape). A legitimate backup entry is always `<sessionId>/<filename>` posix.
  // Reject absolute paths in BOTH posix and win32 senses. A `.msbackup` is portable across OSes, so a
  // `C:\…`/`C:/…` entry restored on Linux/macOS (where the platform `isAbsolute` would NOT flag it)
  // must still be refused — and a `/etc/…` entry restored on Windows likewise. Platform `isAbsolute`
  // alone is the gap that let a Windows-drive path through on a posix runtime (CI caught it).
  if (!relativePath || posix.isAbsolute(relativePath) || win32.isAbsolute(relativePath)) {
    return null;
  }
  // Split on BOTH separators so a `..\..\x` backslash climb is caught by the segment check even on a
  // posix runtime, where `\` is a literal filename char (not a separator) and the resolve backstop
  // below wouldn't see it.
  const segments = relativePath.split(/[\\/]/);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null;
  }
  // Backstop: resolve and re-confine, catching any residual climb (e.g. backslash separators a
  // posix split misses on Windows) before the write lands.
  const root = resolve(stagedRoot);
  const dest = resolve(root, ...segments);
  const rel = relative(root, dest);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return null;
  }
  return dest;
}

export interface ApplyBackupInput {
  readonly targetDbFilePath: string;
  readonly targetAssetsRoot: string;
  readonly parsed: BackupData;
}

export interface ApplyBackupHooks {
  // Test seam: throw at a named swap step to prove the rollback restores the original store. Never
  // wired in production.
  fault?(step: 'after-stage' | 'after-aside' | 'after-db-swap'): void;
}

/*
 * FAILURE-SAFE restore (M06.C 🔴 fix). Restore replaces the live store, so a partial failure must
 * never leave a half-deleted store. Two phases:
 *   1. STAGE — write the new DB + assets tree into a temp staging dir (same volume as the targets,
 *      so the later moves are atomic renames). A throw here is trivially safe: the live store has
 *      not been touched.
 *   2. SWAP — move the live files ASIDE (into staging), then move the staged files INTO PLACE, via
 *      atomic renames (also EBUSY-resilient — renaming a closed file beats overwriting a locked one).
 *      Every rename pushes an undo; ANY throw runs the undo stack in reverse, restoring the ORIGINAL
 *      store exactly. The `fault` hook lets tests force a throw at a named step to prove recovery.
 * On success the staging dir (now holding only the old files) is removed.
 */
export function applyBackup(input: ApplyBackupInput, hooks: ApplyBackupHooks = {}): void {
  const { targetDbFilePath, targetAssetsRoot, parsed } = input;
  const parent = dirname(targetDbFilePath);
  mkdirSync(parent, { recursive: true });
  const staging = join(parent, '.msrestore-staging');
  rmSync(staging, { recursive: true, force: true }); // clear any leftover from a prior crash
  mkdirSync(staging, { recursive: true });

  const stagedDb = join(staging, 'new.db');
  const stagedAssets = join(staging, 'new-assets');
  const asideDb = join(staging, 'old.db');
  const asideAssets = join(staging, 'old-assets');

  try {
    // --- Phase 1: stage (live store untouched) ---
    writeFileSync(stagedDb, Buffer.from(parsed.dbBytes));
    mkdirSync(stagedAssets, { recursive: true });
    for (const asset of parsed.assets) {
      // Confine every staged write to stagedAssets — a crafted relativePath that climbs out (zip-slip)
      // is refused loudly. This happens during STAGING (live store untouched), so the throw is
      // trivially failure-safe: the finally clears staging and the original store is intact.
      const dest = confinedStagingPath(stagedAssets, asset.relativePath);
      if (dest === null) {
        throw new Error(
          `backup: refusing to restore asset outside the staging directory: ${asset.relativePath}`,
        );
      }
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, Buffer.from(asset.bytes));
    }
    hooks.fault?.('after-stage');

    // --- Phase 2: swap with rollback ---
    const undo: Array<() => void> = [];
    try {
      // The old DB's WAL/SHM sidecars are post-checkpoint empties (closeDb truncate-checkpointed
      // before restore) — drop them so they don't dangle next to the swapped-in DB.
      rmSync(`${targetDbFilePath}-wal`, { force: true });
      rmSync(`${targetDbFilePath}-shm`, { force: true });

      if (existsSync(targetDbFilePath)) {
        renameSync(targetDbFilePath, asideDb);
        undo.push(() => renameSync(asideDb, targetDbFilePath));
      }
      if (existsSync(targetAssetsRoot)) {
        renameSync(targetAssetsRoot, asideAssets);
        undo.push(() => renameSync(asideAssets, targetAssetsRoot));
      }
      hooks.fault?.('after-aside');

      renameSync(stagedDb, targetDbFilePath);
      undo.push(() => renameSync(targetDbFilePath, stagedDb));
      hooks.fault?.('after-db-swap');

      renameSync(stagedAssets, targetAssetsRoot);
    } catch (error) {
      // Roll the live store back to EXACTLY its pre-restore state, then rethrow.
      for (let i = undo.length - 1; i >= 0; i -= 1) {
        try {
          undo[i]!();
        } catch {
          // best-effort; keep unwinding the rest
        }
      }
      throw error;
    }
  } finally {
    // Remove staging (success: holds only the old files; failure: holds the staged files we rolled
    // back). Best-effort — a leftover staging dir is cleaned on the next restore.
    rmSync(staging, { recursive: true, force: true });
  }
}

export interface BackupServiceDeps {
  collect(): BackupData;
  save(blob: Buffer): Promise<BackupResult>;
  pickFile(): Promise<Buffer | null>;
  confirmReplace(): Promise<boolean>;
  apply(parsed: BackupData): void;
  closeDb(): void;
  currentSchemaVersion: number;
  // The restart leg after a successful swap is a BRANCH (the OS calls are injected so it stays
  // testable; the real relaunch/quit/dialog are the excluded main.ts wrappers):
  //  - PACKAGED → relaunch() then quit() (the app comes back in a fresh process — the real path).
  //  - DEV (electron-vite) → notifyRestart() then quit(): self-relaunch is unreliable AND strands a
  //    process holding the native better-sqlite3 lock (→ EPERM next rebuild, gotcha §10), so we
  //    prompt the developer and exit cleanly instead.
  // EXACTLY ONE quit() runs on both paths — one clean exit, no zombies.
  readonly isPackaged: boolean;
  relaunch(): void;
  quit(): void;
  notifyRestart(): void;
}

export interface BackupService {
  backup(): Promise<BackupResult>;
  restore(): Promise<RestoreResult>;
}

export function createBackupService(deps: BackupServiceDeps): BackupService {
  return {
    backup: async (): Promise<BackupResult> => {
      const blob = buildBackupBlob(deps.collect());
      return deps.save(blob);
    },
    restore: async (): Promise<RestoreResult> => {
      const file = await deps.pickFile();
      if (!file) {
        return { restored: false, reason: 'cancelled' };
      }
      let parsed: BackupData;
      try {
        parsed = parseBackupBlob(file);
      } catch {
        return { restored: false, reason: 'invalid' };
      }
      if (checkBackupCompatibility(parsed.manifest, deps.currentSchemaVersion) === 'incompatible') {
        return { restored: false, reason: 'incompatible-version' };
      }
      const confirmed = await deps.confirmReplace();
      if (!confirmed) {
        return { restored: false, reason: 'cancelled' };
      }
      // Close the live DB BEFORE swapping the file (Windows holds a mandatory lock).
      deps.closeDb();
      deps.apply(parsed);
      // Restart leg: packaged relaunches; dev prompts the developer to restart (no zombie). Exactly
      // ONE clean quit on both paths.
      if (deps.isPackaged) {
        deps.relaunch();
      } else {
        deps.notifyRestart();
      }
      deps.quit();
      return { restored: true };
    },
  };
}
