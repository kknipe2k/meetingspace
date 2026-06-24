import { describe, expect, it } from 'vitest';

import { SETTINGS_CHANNELS } from '../../electron/ipc/channels';
import { createSettingsApi } from '../../electron/ipc/settings-bridge';
import type { KeyStatus, Prefs, ProviderConfig, SetKeyResult } from '@shared/types';

/*
 * The renderer-facing settings bridge (M03.A). Closes TD-009: brings the lone
 * uncovered bridge in line with its siblings (session/notes/llm bridges). Pure
 * channel mapping over an injected invoke — proves each typed method targets the
 * right channel with the right args, and that no get-the-key method exists (the
 * renderer only ever learns the boolean key STATUS; the plaintext never crosses).
 */
function fakeInvoke(result: unknown = undefined): {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  calls: Array<{ channel: string; args: unknown[] }>;
} {
  const calls: Array<{ channel: string; args: unknown[] }> = [];
  return {
    calls,
    invoke: (channel, ...args) => {
      calls.push({ channel, args });
      return Promise.resolve(result);
    },
  };
}

describe('createSettingsApi', () => {
  it('exposes exactly the settings methods (no get-the-key method)', () => {
    const { invoke } = fakeInvoke();
    expect(new Set(Object.keys(createSettingsApi(invoke)))).toEqual(
      new Set([
        'setKey',
        'keyStatus',
        'clearKey',
        'getPrefs',
        'setPrefs',
        'getProvider',
        'setProvider',
        'pingGateway',
        'listGatewayModels',
        'diagnoseGatewayModels',
      ]),
    );
  });

  it('setKey sends the plaintext + providerId one-way to settings:setKey', async () => {
    const f = fakeInvoke({ ok: true } satisfies SetKeyResult);
    // M07.D: the optional providerId forwards over the wire (default anthropic omits it).
    const result = await createSettingsApi(f.invoke).setKey('sk-secret', 'gateway');

    expect(f.calls).toEqual([
      { channel: SETTINGS_CHANNELS.setKey, args: ['sk-secret', 'gateway'] },
    ]);
    expect(result).toEqual({ ok: true });
  });

  it('keyStatus forwards the providerId to settings:keyStatus', async () => {
    const status: KeyStatus = { hasKey: true, encryptionAvailable: true };
    const f = fakeInvoke(status);
    expect(await createSettingsApi(f.invoke).keyStatus('gateway')).toEqual(status);
    expect(f.calls).toEqual([{ channel: SETTINGS_CHANNELS.keyStatus, args: ['gateway'] }]);
  });

  it('clearKey forwards the providerId to settings:clearKey', async () => {
    const f = fakeInvoke();
    await createSettingsApi(f.invoke).clearKey('gateway');
    expect(f.calls).toEqual([{ channel: SETTINGS_CHANNELS.clearKey, args: ['gateway'] }]);
  });

  it('getProvider / setProvider target their channels (non-secret config)', async () => {
    const provider: ProviderConfig = { provider: 'gateway', baseURL: 'https://corp.example' };
    const f = fakeInvoke(provider);
    const api = createSettingsApi(f.invoke);

    await api.getProvider();
    await api.setProvider(provider);

    expect(f.calls).toEqual([
      { channel: SETTINGS_CHANNELS.getProvider, args: [] },
      { channel: SETTINGS_CHANNELS.setProvider, args: [provider] },
    ]);
  });

  it('getPrefs / setPrefs target their channels', async () => {
    const prefs: Prefs = { generationModel: 'claude-opus-4-8' };
    const f = fakeInvoke(prefs);
    const api = createSettingsApi(f.invoke);

    await api.getPrefs();
    await api.setPrefs(prefs);

    expect(f.calls).toEqual([
      { channel: SETTINGS_CHANNELS.getPrefs, args: [] },
      { channel: SETTINGS_CHANNELS.setPrefs, args: [prefs] },
    ]);
  });

  it('listGatewayModels / diagnoseGatewayModels target their channels (ids forwarded)', async () => {
    const f = fakeInvoke([]);
    const api = createSettingsApi(f.invoke);

    await api.listGatewayModels?.();
    await api.diagnoseGatewayModels?.(['model-a', 'model-b']);

    expect(f.calls).toEqual([
      { channel: SETTINGS_CHANNELS.listGatewayModels, args: [] },
      { channel: SETTINGS_CHANNELS.diagnoseGatewayModels, args: [['model-a', 'model-b']] },
    ]);
  });
});
