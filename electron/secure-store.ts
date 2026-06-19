import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ProviderId, SetKeyResult } from '@shared/types';

/*
 * The encrypted Anthropic API key store — the load-bearing security primitive of
 * M03 (Hard Rule §10). The key is stored ONLY via Electron `safeStorage` (the OS
 * credential vault), never plaintext on disk, never logged, never returned to the
 * renderer. `safeStorage` is injected so the whole store is Node-testable; the real
 * Electron `safeStorage` is wired in main.ts (the only uncovered wrapper).
 *
 * `getKeyForMain()` decrypts on demand for the main-process SDK call (Stage B). It
 * is deliberately NOT exposed on any IPC channel — there is no renderer-reachable
 * path to the plaintext. The renderer learns only the boolean key STATUS.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export class KeyStore {
  constructor(
    private readonly safeStorage: SafeStorageLike,
    private readonly filePath: string,
  ) {}

  // M07.D: the file that holds a provider's secret. The default / `anthropic` provider
  // resolves to the LEGACY `filePath` verbatim (additive migration — a pre-D
  // `anthropic-key.enc` keeps working untouched). A new provider (gateway) writes a sibling
  // `<providerId>-credential.enc` in the SAME directory, with the same safeStorage + atomic
  // discipline. Each provider's secret is independent.
  private pathFor(providerId?: ProviderId): string {
    if (providerId === undefined || providerId === 'anthropic') {
      return this.filePath;
    }
    return join(dirname(this.filePath), `${providerId}-credential.enc`);
  }

  isEncryptionAvailable(): boolean {
    return this.safeStorage.isEncryptionAvailable();
  }

  /*
   * Gate on `isEncryptionAvailable()` BEFORE touching the secret (gotcha §2): if the
   * OS vault is unavailable, write nothing and report it — never a plaintext
   * fallback. On success, encrypt and atomically replace the on-disk blob.
   */
  setKey(plaintext: string, providerId?: ProviderId): SetKeyResult {
    if (!this.safeStorage.isEncryptionAvailable()) {
      return { ok: false, reason: 'encryption-unavailable' };
    }
    const path = this.pathFor(providerId);
    const encrypted = this.safeStorage.encryptString(plaintext);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    // 0o600 where the OS honors it; atomic temp-then-rename so a crash mid-write
    // never leaves a half-written (or stray temp) secret file.
    writeFileSync(tmp, encrypted, { mode: 0o600 });
    renameSync(tmp, path);
    return { ok: true };
  }

  hasKey(providerId?: ProviderId): boolean {
    return existsSync(this.pathFor(providerId));
  }

  clearKey(providerId?: ProviderId): void {
    rmSync(this.pathFor(providerId), { force: true });
  }

  // Main-process only — decrypts the stored blob for the Anthropic SDK call.
  // No IPC channel references this; the secret never crosses the contextBridge.
  getKeyForMain(providerId?: ProviderId): string | null {
    const path = this.pathFor(providerId);
    if (!existsSync(path)) {
      return null;
    }
    return this.safeStorage.decryptString(readFileSync(path));
  }
}
