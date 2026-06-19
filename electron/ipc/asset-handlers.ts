import type { Asset, AssetKind } from '@shared/types';

import type { AssetStore } from '../storage/assets';

import { ASSET_CHANNELS } from './channels';

/*
 * Registers the asset (screenshot blob) IPC handlers against an injected
 * registrar (Electron's ipcMain in production; a fake in tests). The renderer is
 * sandboxed, but the main process is the trust boundary for storage (spec §5):
 * every save is validated here — mime allowlist, byte cap, known kind, argument
 * types — before any bytes touch disk. A malformed call fails loudly rather than
 * writing an attacker-shaped blob.
 */
type IpcInvokeHandler = (event: unknown, ...args: unknown[]) => unknown;

export interface IpcHandleRegistrar {
  handle(channel: string, handler: IpcInvokeHandler): void;
}

// 25 MiB — generous for a screenshot, small enough to reject a runaway upload.
export const MAX_BLOB_BYTES = 25 * 1024 * 1024;

// The mime → on-disk extension allowlist. A mime outside this set is rejected at
// the boundary, so the renderer can never drive an arbitrary file type to disk.
const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const ASSET_KINDS: ReadonlySet<string> = new Set<AssetKind>([
  'screenshot',
  'upload',
  'paste',
  'capture',
]);

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`asset ipc: ${field} must be a string`);
  }
  return value;
}

function asKind(value: unknown): AssetKind {
  if (typeof value !== 'string' || !ASSET_KINDS.has(value)) {
    throw new TypeError(`asset ipc: kind must be one of ${[...ASSET_KINDS].join(', ')}`);
  }
  return value as AssetKind;
}

function extensionForMime(mime: string): string {
  const ext = MIME_EXTENSIONS[mime];
  if (!ext) {
    throw new TypeError(`asset ipc: unsupported image type ${mime}`);
  }
  return ext;
}

function asBytes(value: unknown): Uint8Array {
  const bytes =
    value instanceof Uint8Array
      ? value
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : null;
  if (!bytes) {
    throw new TypeError('asset ipc: bytes must be an ArrayBuffer or Uint8Array');
  }
  if (bytes.byteLength === 0) {
    throw new RangeError('asset ipc: blob is empty');
  }
  if (bytes.byteLength > MAX_BLOB_BYTES) {
    throw new RangeError(`asset ipc: blob exceeds ${MAX_BLOB_BYTES} bytes`);
  }
  return bytes;
}

/*
 * Optional post-save hook (M06.C / F25): called with the stored Asset + its source bytes right
 * after a successful save, so main.ts can generate the sibling thumbnail derivative. A hook failure
 * must NEVER fail the save (the thumbnail is a pure optimization — the grid falls back to full-res),
 * so it is invoked defensively. Defaulted to undefined so existing callers/tests are unaffected.
 */
export type OnAssetSaved = (asset: Asset, bytes: Uint8Array) => void;

export function registerAssetHandlers(
  registrar: IpcHandleRegistrar,
  store: AssetStore,
  onAssetSaved?: OnAssetSaved,
): void {
  registrar.handle(ASSET_CHANNELS.save, (_event, sessionId, bytes, mime, kind) => {
    const ext = extensionForMime(asString(mime, 'mime'));
    const validBytes = asBytes(bytes);
    const asset = store.saveBlob(asString(sessionId, 'sessionId'), asKind(kind), validBytes, ext);
    if (onAssetSaved) {
      try {
        onAssetSaved(asset, validBytes);
      } catch {
        // A thumbnail-generation failure never fails the save — the grid falls back to full-res.
      }
    }
    return asset;
  });
  registrar.handle(ASSET_CHANNELS.list, (_event, sessionId) =>
    store.listAssets(asString(sessionId, 'sessionId')),
  );
  registrar.handle(ASSET_CHANNELS.delete, (_event, id) => store.deleteAsset(asString(id, 'id')));
}
