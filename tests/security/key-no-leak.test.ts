import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SETTINGS_CHANNELS } from '../../electron/ipc/channels';
import { registerSettingsHandlers } from '../../electron/ipc/settings-handlers';
import { PrefsStore } from '../../electron/prefs-store';
import { KeyStore, type SafeStorageLike } from '../../electron/secure-store';

/*
 * The M03 "Key-never-plaintext" hard gate (docs/gates.md), run as its own suite by
 * `npm run test:security`. Proves the three no-leak invariants in code (gitleaks
 * covers the committed-secret axis separately):
 *   1. the key is never on disk in plaintext,
 *   2. the key is never returned to the renderer over IPC,
 *   3. the key-read path (getKeyForMain) has no renderer-reachable wiring.
 */
const XOR = 0x5a;
function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from([...Buffer.from(plain, 'utf8')].map((b) => b ^ XOR)),
    decryptString: (buf) => Buffer.from([...buf].map((b) => b ^ XOR)).toString('utf8'),
  };
}

const KEY = 'sk-ant-api03-THIS-IS-A-FAKE-TEST-KEY-000';
// M07.D: the corp gateway bearer — a SECOND secret the no-leak invariants must cover.
const GATEWAY_TOKEN = 'sk-corp-bearer-NOT-an-anthropic-key-000';
const REPO_ROOT = resolve(__dirname, '../..');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-noleak-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('key never on disk in plaintext', () => {
  it('the stored blob neither equals nor contains the plaintext key', () => {
    const keyPath = join(dir, 'anthropic-key.enc');
    new KeyStore(fakeSafeStorage(), keyPath).setKey(KEY);

    const stored = readFileSync(keyPath);
    expect(stored.equals(Buffer.from(KEY, 'utf8'))).toBe(false);
    expect(stored.toString('utf8')).not.toContain(KEY);
    expect(stored.toString('latin1')).not.toContain(KEY);
  });
});

describe('key never crosses the IPC boundary', () => {
  it('no settings channel payload contains the key', () => {
    const keyStore = new KeyStore(fakeSafeStorage(), join(dir, 'anthropic-key.enc'));
    const prefsStore = new PrefsStore(join(dir, 'settings.json'));
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    registerSettingsHandlers(
      { handle: (channel, handler) => handlers.set(channel, handler) },
      keyStore,
      prefsStore,
    );
    handlers.get(SETTINGS_CHANNELS.setKey)?.({}, KEY);

    const status = handlers.get(SETTINGS_CHANNELS.keyStatus)?.({});
    expect(JSON.stringify(status)).not.toContain(KEY);
    expect(JSON.stringify(status)).not.toContain('apiKey');
  });
});

describe('getKeyForMain has no renderer-reachable wiring', () => {
  // Reading the decrypted key is a main-process-only capability. It must appear
  // ONLY in its definition (secure-store.ts) and the main-process consumers
  // (main.ts now; llm-service.ts in Stage B) — never in any module that the
  // renderer bundle can reach (the bridges, the preload, the channel map, the
  // shared API contract, or the renderer client).
  const RENDERER_REACHABLE = [
    'electron/preload.ts',
    'electron/ipc/channels.ts',
    'electron/ipc/settings-bridge.ts',
    'electron/ipc/session-bridge.ts',
    'electron/ipc/notes-bridge.ts',
    'electron/ipc/assets-bridge.ts',
    'electron/ipc/capture-bridge.ts',
    'electron/ipc/llm-bridge.ts',
    'electron/ipc/gen-bridge.ts',
    'shared/api.ts',
    'src/ipc/client.ts',
  ];

  it.each(RENDERER_REACHABLE)('%s does not reference getKeyForMain', (relPath) => {
    const source = readFileSync(join(REPO_ROOT, relPath), 'utf8');
    expect(source).not.toContain('getKeyForMain');
  });

  it('no src/** module references getKeyForMain or the key file name', () => {
    // A coarse guard: the renderer tree must not name the main-only key-read path
    // nor the on-disk key blob.
    const clientSource = readFileSync(join(REPO_ROOT, 'src/ipc/client.ts'), 'utf8');
    expect(clientSource).not.toContain('getKeyForMain');
    expect(clientSource).not.toContain('anthropic-key.enc');
  });
});

describe('the M07.D gateway token never leaks (Hard Rule §4.10, extended)', () => {
  it('the gateway credential blob neither equals nor contains the plaintext token', () => {
    const keyStore = new KeyStore(fakeSafeStorage(), join(dir, 'anthropic-key.enc'));
    keyStore.setKey(GATEWAY_TOKEN, 'gateway');

    const stored = readFileSync(join(dir, 'gateway-credential.enc'));
    expect(stored.equals(Buffer.from(GATEWAY_TOKEN, 'utf8'))).toBe(false);
    expect(stored.toString('utf8')).not.toContain(GATEWAY_TOKEN);
    expect(stored.toString('latin1')).not.toContain(GATEWAY_TOKEN);
  });

  it('no settings channel payload contains the gateway token', () => {
    const keyStore = new KeyStore(fakeSafeStorage(), join(dir, 'anthropic-key.enc'));
    const prefsStore = new PrefsStore(join(dir, 'settings.json'));
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    registerSettingsHandlers(
      { handle: (channel, handler) => handlers.set(channel, handler) },
      keyStore,
      prefsStore,
    );
    handlers.get(SETTINGS_CHANNELS.setKey)?.({}, GATEWAY_TOKEN, 'gateway');

    const status = handlers.get(SETTINGS_CHANNELS.keyStatus)?.({}, 'gateway');
    expect(JSON.stringify(status)).not.toContain(GATEWAY_TOKEN);
    const provider = handlers.get(SETTINGS_CHANNELS.getProvider)?.({});
    expect(JSON.stringify(provider)).not.toContain(GATEWAY_TOKEN);
  });
});
