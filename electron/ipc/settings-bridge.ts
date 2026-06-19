import type { SettingsApi } from '@shared/api';
import type { KeyStatus, Prefs, ProviderConfig, SetKeyResult } from '@shared/types';

import { SETTINGS_CHANNELS } from './channels';
import type { IpcInvoke } from './session-bridge';

/*
 * Builds the renderer-facing SettingsApi over an injected `invoke` transport
 * (ipcRenderer.invoke in the preload). Pure and transport-agnostic so the channel
 * mapping is Node-unit-testable. Only these typed methods cross the contextBridge —
 * and none of them carries the key: `keyStatus` returns booleans, `setKey` sends
 * the plaintext one-way into main, and there is no get-the-key method at all.
 */
export function createSettingsApi(invoke: IpcInvoke): SettingsApi {
  return {
    setKey: (plaintext, providerId) =>
      invoke(SETTINGS_CHANNELS.setKey, plaintext, providerId) as Promise<SetKeyResult>,
    keyStatus: (providerId) =>
      invoke(SETTINGS_CHANNELS.keyStatus, providerId) as Promise<KeyStatus>,
    clearKey: (providerId) => invoke(SETTINGS_CHANNELS.clearKey, providerId) as Promise<void>,
    getPrefs: () => invoke(SETTINGS_CHANNELS.getPrefs) as Promise<Prefs>,
    setPrefs: (prefs) => invoke(SETTINGS_CHANNELS.setPrefs, prefs) as Promise<Prefs>,
    getProvider: () => invoke(SETTINGS_CHANNELS.getProvider) as Promise<ProviderConfig>,
    setProvider: (provider) =>
      invoke(SETTINGS_CHANNELS.setProvider, provider) as Promise<ProviderConfig>,
  };
}
