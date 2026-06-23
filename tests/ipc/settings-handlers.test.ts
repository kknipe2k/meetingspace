import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SETTINGS_CHANNELS } from '../../electron/ipc/channels';
import { registerSettingsHandlers } from '../../electron/ipc/settings-handlers';
import { PrefsStore } from '../../electron/prefs-store';
import { KeyStore, type SafeStorageLike } from '../../electron/secure-store';

// Mirrors note-handlers.test: a fake registrar captures handlers by channel so the
// settings IPC surface runs under Node without an Electron ipcMain.
type Handler = (event: unknown, ...args: unknown[]) => unknown;

function fakeRegistrar(): {
  handle: (c: string, h: Handler) => void;
  handlers: Map<string, Handler>;
} {
  const handlers = new Map<string, Handler>();
  return { handle: (channel, handler) => handlers.set(channel, handler), handlers };
}

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
let handlers: Map<string, Handler>;

function setup(available = true): void {
  const keyStore = new KeyStore(fakeSafeStorage(available), join(dir, 'anthropic-key.enc'));
  const prefsStore = new PrefsStore(join(dir, 'settings.json'));
  const registrar = fakeRegistrar();
  registerSettingsHandlers(registrar, keyStore, prefsStore);
  handlers = registrar.handlers;
}

function call(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`no handler for ${channel}`);
  }
  return handler({}, ...args);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-settingshandlers-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('settings IPC handlers', () => {
  it('registers exactly the settings channels (incl. M07.D provider config)', () => {
    setup();
    expect([...handlers.keys()].sort()).toEqual(
      [
        SETTINGS_CHANNELS.setKey,
        SETTINGS_CHANNELS.keyStatus,
        SETTINGS_CHANNELS.clearKey,
        SETTINGS_CHANNELS.getPrefs,
        SETTINGS_CHANNELS.setPrefs,
        SETTINGS_CHANNELS.getProvider,
        SETTINGS_CHANNELS.setProvider,
      ].sort(),
    );
  });

  it('keyStatus returns ONLY booleans — never the key', () => {
    setup();
    call(SETTINGS_CHANNELS.setKey, KEY);

    const status = call(SETTINGS_CHANNELS.keyStatus) as Record<string, unknown>;

    expect(status).toEqual({ hasKey: true, encryptionAvailable: true });
    expect(Object.values(status).every((v) => typeof v === 'boolean')).toBe(true);
    expect(JSON.stringify(status)).not.toContain(KEY);
  });

  it('setKey then clearKey toggles hasKey', () => {
    setup();
    expect((call(SETTINGS_CHANNELS.keyStatus) as { hasKey: boolean }).hasKey).toBe(false);

    call(SETTINGS_CHANNELS.setKey, KEY);
    expect((call(SETTINGS_CHANNELS.keyStatus) as { hasKey: boolean }).hasKey).toBe(true);

    call(SETTINGS_CHANNELS.clearKey);
    expect((call(SETTINGS_CHANNELS.keyStatus) as { hasKey: boolean }).hasKey).toBe(false);
  });

  it('reports the encryption-unavailable gate through keyStatus and refuses setKey', () => {
    setup(false);

    const result = call(SETTINGS_CHANNELS.setKey, KEY);

    expect(result).toEqual({ ok: false, reason: 'encryption-unavailable' });
    expect(call(SETTINGS_CHANNELS.keyStatus)).toEqual({
      hasKey: false,
      encryptionAvailable: false,
    });
  });

  it('round-trips non-secret prefs through getPrefs / setPrefs', () => {
    setup();
    expect(call(SETTINGS_CHANNELS.getPrefs)).toEqual({});

    const merged = call(SETTINGS_CHANNELS.setPrefs, { chatModel: 'claude-haiku-4-5' });

    expect(merged).toEqual({ chatModel: 'claude-haiku-4-5' });
    expect(call(SETTINGS_CHANNELS.getPrefs)).toEqual({ chatModel: 'claude-haiku-4-5' });
  });

  it('NO registered channel returns the stored key in its payload (or echoes it on error)', () => {
    setup();
    call(SETTINGS_CHANNELS.setKey, KEY);

    // Exercise every channel with the same (valid) key as input; whether it
    // returns a payload or throws, the plaintext must never appear in either.
    const probes: Array<[string, unknown[]]> = [
      [SETTINGS_CHANNELS.setKey, [KEY]],
      [SETTINGS_CHANNELS.keyStatus, []],
      [SETTINGS_CHANNELS.clearKey, []],
      [SETTINGS_CHANNELS.getPrefs, []],
      [SETTINGS_CHANNELS.setPrefs, [{ chatModel: 'claude-haiku-4-5' }]],
      [SETTINGS_CHANNELS.getProvider, []],
      [SETTINGS_CHANNELS.setProvider, [{ provider: 'anthropic' }]],
    ];
    expect(probes.map(([c]) => c).sort()).toEqual([...handlers.keys()].sort());

    for (const [channel, args] of probes) {
      let observed: string;
      try {
        observed = JSON.stringify(call(channel, ...args) ?? null);
      } catch (error) {
        observed = String(error);
      }
      expect(observed).not.toContain(KEY);
    }
  });

  it('validates argument types at the main-process boundary', () => {
    setup();
    expect(() => call(SETTINGS_CHANNELS.setKey, 123)).toThrow(TypeError);
    expect(() => call(SETTINGS_CHANNELS.setPrefs, 'not-an-object')).toThrow(TypeError);
    expect(() => call(SETTINGS_CHANNELS.setPrefs, { chatModel: 42 })).toThrow(TypeError);
    // gatewayModels (the curated picker allowlist) must be a string[].
    expect(() => call(SETTINGS_CHANNELS.setPrefs, { gatewayModels: 'nope' })).toThrow(TypeError);
    expect(() => call(SETTINGS_CHANNELS.setPrefs, { gatewayModels: [1, 2] })).toThrow(TypeError);
  });

  it('round-trips the curated gateway model allowlist (string[])', () => {
    setup();
    const ids = ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
    expect(call(SETTINGS_CHANNELS.setPrefs, { gatewayModels: ids })).toEqual({
      gatewayModels: ids,
    });
    expect(call(SETTINGS_CHANNELS.getPrefs)).toEqual({ gatewayModels: ids });
  });
});
