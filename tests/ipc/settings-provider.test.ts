import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SETTINGS_CHANNELS } from '../../electron/ipc/channels';
import { registerSettingsHandlers } from '../../electron/ipc/settings-handlers';
import { PrefsStore } from '../../electron/prefs-store';
import { KeyStore, type SafeStorageLike } from '../../electron/secure-store';

/*
 * M07.D — the settings IPC surface for the provider switch (REVIEW-V11 F19). New channels:
 * getProvider/setProvider (non-secret config in prefs); setKey/keyStatus/clearKey gain an
 * optional providerId (default anthropic = compat). setProvider validates the gateway baseURL:
 * https is required (http allowed only for loopback, or a non-loopback host under the explicit
 * MEETINGSPACE_ALLOW_INSECURE_GATEWAY_HTTP override), so a bearer token can't transit cleartext.
 */
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

const GATEWAY_TOKEN = 'sk-corp-bearer-NOT-an-anthropic-key-000';

let dir: string;
let handlers: Map<string, Handler>;

function setup(): void {
  const keyStore = new KeyStore(fakeSafeStorage(), join(dir, 'anthropic-key.enc'));
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
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-settingsprovider-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('settings IPC — provider config', () => {
  it('defaults to the anthropic provider', () => {
    setup();
    expect(call(SETTINGS_CHANNELS.getProvider)).toEqual({ provider: 'anthropic' });
  });

  it('round-trips a gateway provider with an https baseURL', () => {
    setup();
    call(SETTINGS_CHANNELS.setProvider, {
      provider: 'gateway',
      baseURL: 'https://corp.example/v1',
    });
    expect(call(SETTINGS_CHANNELS.getProvider)).toEqual({
      provider: 'gateway',
      baseURL: 'https://corp.example/v1',
    });
  });

  it('REJECTS a remote http gateway baseURL by default (no token over cleartext)', () => {
    setup();
    // Load-bearing precondition so the throw below proves the GUARD rejected, not that the channel
    // is merely unregistered (a missing handler would also throw — gotcha #1).
    expect(handlers.has(SETTINGS_CHANNELS.setProvider)).toBe(true);
    expect(() =>
      call(SETTINGS_CHANNELS.setProvider, {
        provider: 'gateway',
        baseURL: 'http://gateway.corp.example',
      }),
    ).toThrow();
    // … but NOT a valid https URL (so a handler that threw unconditionally would fail here).
    expect(() =>
      call(SETTINGS_CHANNELS.setProvider, {
        provider: 'gateway',
        baseURL: 'https://corp.example/v1',
      }),
    ).not.toThrow();
  });

  it('stores a remote http gateway baseURL ONLY under the insecure-HTTP override', () => {
    const prior = process.env.MEETINGSPACE_ALLOW_INSECURE_GATEWAY_HTTP;
    process.env.MEETINGSPACE_ALLOW_INSECURE_GATEWAY_HTTP = '1';
    try {
      setup();
      call(SETTINGS_CHANNELS.setProvider, {
        provider: 'gateway',
        baseURL: 'http://gateway.corp.internal',
      });
      expect(call(SETTINGS_CHANNELS.getProvider)).toEqual({
        provider: 'gateway',
        baseURL: 'http://gateway.corp.internal',
      });
    } finally {
      if (prior === undefined) {
        delete process.env.MEETINGSPACE_ALLOW_INSECURE_GATEWAY_HTTP;
      } else {
        process.env.MEETINGSPACE_ALLOW_INSECURE_GATEWAY_HTTP = prior;
      }
    }
  });
});

describe('settings IPC — per-provider secrets', () => {
  it('setKey with a providerId stores under that provider; keyStatus is per-provider', () => {
    setup();
    call(SETTINGS_CHANNELS.setKey, GATEWAY_TOKEN, 'gateway');

    expect((call(SETTINGS_CHANNELS.keyStatus, 'gateway') as { hasKey: boolean }).hasKey).toBe(true);
    // The anthropic slot is independent — setting the gateway token didn't populate it.
    expect((call(SETTINGS_CHANNELS.keyStatus, 'anthropic') as { hasKey: boolean }).hasKey).toBe(
      false,
    );
  });

  it('no provider channel returns the gateway token in its payload (or echoes it on error)', () => {
    setup();
    call(SETTINGS_CHANNELS.setKey, GATEWAY_TOKEN, 'gateway');
    for (const [channel, args] of [
      [SETTINGS_CHANNELS.keyStatus, ['gateway']],
      [SETTINGS_CHANNELS.getProvider, []],
    ] as Array<[string, unknown[]]>) {
      let observed: string;
      try {
        observed = JSON.stringify(call(channel, ...args) ?? null);
      } catch (error) {
        observed = String(error);
      }
      expect(observed).not.toContain(GATEWAY_TOKEN);
    }
  });
});
