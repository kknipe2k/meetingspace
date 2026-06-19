import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KeyStore, type SafeStorageLike } from '../../electron/secure-store';

// A reversible, NON-identity stand-in for Electron's safeStorage. XOR fully
// obscures the bytes (the ciphertext neither equals nor contains the plaintext),
// so the "stored bytes != key" assertion is meaningful and the round-trip still
// holds. `available` flips the isEncryptionAvailable() gate for the unavailable
// path (gotcha §2). The real safeStorage is injected in main.ts — the only
// uncovered wrapper; this seam is fully Node-testable.
const XOR = 0x5a;

function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from([...Buffer.from(plain, 'utf8')].map((b) => b ^ XOR)),
    decryptString: (buf) => Buffer.from([...buf].map((b) => b ^ XOR)).toString('utf8'),
  };
}

const KEY = 'sk-ant-api03-THIS-IS-A-FAKE-TEST-KEY-000';

let dir: string;
let keyPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-securestore-'));
  keyPath = join(dir, 'anthropic-key.enc');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('KeyStore', () => {
  it('encrypts the key at rest — the stored blob is neither the plaintext nor contains it', () => {
    const store = new KeyStore(fakeSafeStorage(), keyPath);

    const result = store.setKey(KEY);

    expect(result).toEqual({ ok: true });
    expect(existsSync(keyPath)).toBe(true);
    const stored = readFileSync(keyPath);
    expect(stored.equals(Buffer.from(KEY, 'utf8'))).toBe(false);
    expect(stored.toString('utf8')).not.toContain(KEY);
    expect(stored.toString('latin1')).not.toContain(KEY);
  });

  it('round-trips the key back for main-process use via getKeyForMain', () => {
    const store = new KeyStore(fakeSafeStorage(), keyPath);
    store.setKey(KEY);

    expect(store.getKeyForMain()).toBe(KEY);
  });

  it('hasKey reflects presence across set and clear', () => {
    const store = new KeyStore(fakeSafeStorage(), keyPath);
    expect(store.hasKey()).toBe(false);

    store.setKey(KEY);
    expect(store.hasKey()).toBe(true);

    store.clearKey();
    expect(store.hasKey()).toBe(false);
    expect(existsSync(keyPath)).toBe(false);
  });

  it('getKeyForMain returns null when no key is stored', () => {
    const store = new KeyStore(fakeSafeStorage(), keyPath);
    expect(store.getKeyForMain()).toBeNull();
  });

  it('clearKey is a no-op (no throw) when no key file exists', () => {
    const store = new KeyStore(fakeSafeStorage(), keyPath);
    expect(() => store.clearKey()).not.toThrow();
  });

  // Mutation target #1: remove the isEncryptionAvailable() gate and this fails —
  // setKey would call encryptString and write a blob instead of refusing.
  it('refuses to store and writes nothing when encryption is unavailable (no plaintext fallback)', () => {
    const store = new KeyStore(fakeSafeStorage(false), keyPath);

    const result = store.setKey(KEY);

    expect(result).toEqual({ ok: false, reason: 'encryption-unavailable' });
    expect(existsSync(keyPath)).toBe(false);
    expect(store.hasKey()).toBe(false);
  });

  it('reports encryption availability through to the caller', () => {
    expect(new KeyStore(fakeSafeStorage(true), keyPath).isEncryptionAvailable()).toBe(true);
    expect(new KeyStore(fakeSafeStorage(false), keyPath).isEncryptionAvailable()).toBe(false);
  });

  it('replaces an existing key on a second setKey and leaves no temp file behind', () => {
    const store = new KeyStore(fakeSafeStorage(), keyPath);
    store.setKey('first-key-value');
    store.setKey(KEY);

    expect(store.getKeyForMain()).toBe(KEY);
    // Atomic write (temp + rename) must not leave stray files in the dir.
    expect(readdirSync(dir)).toEqual(['anthropic-key.enc']);
  });
});
