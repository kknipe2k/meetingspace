import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KeyStore, type SafeStorageLike } from '../../electron/secure-store';

/*
 * M07.D — the KeyStore goes MULTI-CREDENTIAL (REVIEW-V11 F19), ADDITIVELY: the legacy
 * single-secret `anthropic-key.enc` keeps working untouched (the anthropic/default path),
 * and the gateway token lands in a sibling `gateway-credential.enc` under the same
 * safeStorage + atomic-write discipline (Hard Rule §4.10 extends verbatim).
 *
 * OLD-KEY COMPAT IS PINNED FIRST (per the stage's RED additions): a file written by the
 * pre-D single-secret store must load unchanged through the new API.
 */
const XOR = 0x5a;
function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from([...Buffer.from(plain, 'utf8')].map((b) => b ^ XOR)),
    decryptString: (buf) => Buffer.from([...buf].map((b) => b ^ XOR)).toString('utf8'),
  };
}
function legacyBlob(plain: string): Buffer {
  // Exactly what the pre-D setKey wrote: the safeStorage-encrypted bytes, no envelope.
  return Buffer.from([...Buffer.from(plain, 'utf8')].map((b) => b ^ XOR));
}

const ANTHROPIC_KEY = 'sk-ant-api03-THIS-IS-A-FAKE-TEST-KEY-000';
const GATEWAY_TOKEN = 'sk-corp-bearer-NOT-an-anthropic-key-000';

let dir: string;
let keyPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-multicred-'));
  keyPath = join(dir, 'anthropic-key.enc');
});

afterEach(() => {
  // tmp dir left for the OS to reap; isolation is per-test via mkdtempSync.
});

describe('OLD-KEY COMPAT (first)', () => {
  it('reads a pre-D anthropic-key.enc written by the legacy single-secret store, unchanged', () => {
    writeFileSync(keyPath, legacyBlob(ANTHROPIC_KEY));
    const store = new KeyStore(fakeSafeStorage(), keyPath);

    // The default (no providerId) path AND the explicit 'anthropic' provider both resolve
    // to the legacy file — the existing key keeps working without migration.
    expect(store.getKeyForMain()).toBe(ANTHROPIC_KEY);
    expect(store.getKeyForMain('anthropic')).toBe(ANTHROPIC_KEY);
    expect(store.hasKey()).toBe(true);
    expect(store.hasKey('anthropic')).toBe(true);
  });
});

describe('multi-credential round-trip', () => {
  it('stores the gateway token in its OWN file (not anthropic-key.enc) and round-trips it', () => {
    const store = new KeyStore(fakeSafeStorage(), keyPath);

    const result = store.setKey(GATEWAY_TOKEN, 'gateway');

    expect(result).toEqual({ ok: true });
    expect(existsSync(join(dir, 'gateway-credential.enc'))).toBe(true);
    expect(existsSync(keyPath)).toBe(false);
    expect(store.getKeyForMain('gateway')).toBe(GATEWAY_TOKEN);
  });

  it('the providers are independent — setting/clearing gateway does not touch anthropic', () => {
    const store = new KeyStore(fakeSafeStorage(), keyPath);
    store.setKey(ANTHROPIC_KEY); // legacy/default path
    store.setKey(GATEWAY_TOKEN, 'gateway');

    expect(store.hasKey('anthropic')).toBe(true);
    expect(store.hasKey('gateway')).toBe(true);

    store.clearKey('gateway');
    expect(store.hasKey('gateway')).toBe(false);
    expect(store.getKeyForMain()).toBe(ANTHROPIC_KEY); // anthropic untouched
  });

  it('encrypts the gateway token at rest — the blob neither equals nor contains it (Hard Rule §4.10)', () => {
    const store = new KeyStore(fakeSafeStorage(), keyPath);
    store.setKey(GATEWAY_TOKEN, 'gateway');

    const stored = readFileSync(join(dir, 'gateway-credential.enc'));
    expect(stored.equals(Buffer.from(GATEWAY_TOKEN, 'utf8'))).toBe(false);
    expect(stored.toString('utf8')).not.toContain(GATEWAY_TOKEN);
    expect(stored.toString('latin1')).not.toContain(GATEWAY_TOKEN);
  });
});
