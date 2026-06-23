import type { Prefs, ProviderConfig, ProviderId } from '@shared/types';

import { isAllowedGatewayUrl } from '../llm/provider-config';
import type { PrefsStore } from '../prefs-store';
import type { KeyStore } from '../secure-store';

import { SETTINGS_CHANNELS } from './channels';
import type { IpcHandleRegistrar } from './note-handlers';

/*
 * Registers the settings IPC handlers against an injected registrar (Electron's
 * ipcMain in production; a fake in tests). The key store and prefs store are
 * injected so the surface runs under Node without an Electron runtime.
 *
 * The trust boundary is here (spec §5): every argument is validated main-side. The
 * key/token NEVER crosses back to the renderer — `keyStatus` returns booleans only, and
 * no handler returns a plaintext secret. The decrypted secret is read only in main via
 * KeyStore.getKeyForMain() (no channel).
 *
 * M07.D: setKey/keyStatus/clearKey take an OPTIONAL providerId (default anthropic = compat);
 * getProvider/setProvider carry the non-secret provider config, and setProvider validates the
 * gateway baseURL (https except loopback) so a token can never ride over cleartext (§4.10).
 */
function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`settings ipc: ${field} must be a string`);
  }
  return value;
}

function asProviderId(value: unknown): ProviderId | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value !== 'anthropic' && value !== 'gateway') {
    throw new TypeError('settings ipc: providerId must be "anthropic" or "gateway"');
  }
  return value;
}

function asPrefs(value: unknown): Prefs {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('settings ipc: prefs must be an object');
  }
  const record = value as Record<string, unknown>;
  for (const field of ['chatModel', 'generationModel'] as const) {
    if (record[field] !== undefined && typeof record[field] !== 'string') {
      throw new TypeError(`settings ipc: ${field} must be a string`);
    }
  }
  if (
    record.themePreference !== undefined &&
    record.themePreference !== 'system' &&
    record.themePreference !== 'light' &&
    record.themePreference !== 'dark'
  ) {
    throw new TypeError('settings ipc: themePreference must be "system", "light", or "dark"');
  }
  return value as Prefs;
}

// Validate the non-secret provider config main-side. The gateway baseURL is the load-bearing
// check: it must be https except loopback, or a bearer token would transit in cleartext.
function asProviderConfig(value: unknown): ProviderConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('settings ipc: provider must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record.provider === 'anthropic') {
    return { provider: 'anthropic' };
  }
  if (record.provider === 'gateway') {
    const baseURL = asString(record.baseURL, 'baseURL');
    if (!isAllowedGatewayUrl(baseURL)) {
      throw new TypeError(
        'settings ipc: gateway baseURL must be https (http allowed only for localhost, or set ' +
          'MEETINGSPACE_ALLOW_INSECURE_GATEWAY_HTTP=1 for an internal HTTP gateway)',
      );
    }
    const proxyUrl =
      typeof record.proxyUrl === 'string' && record.proxyUrl.length > 0 ? record.proxyUrl : null;
    return { provider: 'gateway', baseURL, ...(proxyUrl ? { proxyUrl } : {}) };
  }
  throw new TypeError('settings ipc: provider must be "anthropic" or "gateway"');
}

const DEFAULT_PROVIDER: ProviderConfig = { provider: 'anthropic' };

export function registerSettingsHandlers(
  registrar: IpcHandleRegistrar,
  keyStore: KeyStore,
  prefsStore: PrefsStore,
): void {
  registrar.handle(SETTINGS_CHANNELS.setKey, (_event, plaintext, providerId) =>
    keyStore.setKey(asString(plaintext, 'key'), asProviderId(providerId)),
  );
  // Booleans only — never the key/token.
  registrar.handle(SETTINGS_CHANNELS.keyStatus, (_event, providerId) => ({
    hasKey: keyStore.hasKey(asProviderId(providerId)),
    encryptionAvailable: keyStore.isEncryptionAvailable(),
  }));
  registrar.handle(SETTINGS_CHANNELS.clearKey, (_event, providerId) =>
    keyStore.clearKey(asProviderId(providerId)),
  );
  registrar.handle(SETTINGS_CHANNELS.getPrefs, () => prefsStore.get());
  registrar.handle(SETTINGS_CHANNELS.setPrefs, (_event, prefs) => prefsStore.set(asPrefs(prefs)));
  // M07.D provider config (non-secret) — stored in prefs; the baseURL is validated here.
  registrar.handle(
    SETTINGS_CHANNELS.getProvider,
    () => prefsStore.get().provider ?? DEFAULT_PROVIDER,
  );
  registrar.handle(SETTINGS_CHANNELS.setProvider, (_event, provider) => {
    const validated = asProviderConfig(provider);
    prefsStore.set({ provider: validated });
    return validated;
  });
}
