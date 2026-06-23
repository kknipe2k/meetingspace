import { useCallback, useEffect, useState, type ReactElement } from 'react';

import { GENERATION_MAX_TOKENS } from '@shared/limits';
import type {
  GatewayPingResult,
  KeyStatus,
  PricingEntry,
  ProviderConfig,
  ProviderId,
} from '@shared/types';

import { useMutationToast } from '../hooks/useMutationToast';
import { useToasts } from '../hooks/useToasts';
import {
  catalogClient,
  storageClient,
  usageClient as defaultUsageClient,
  type SettingsClient,
  type StorageClient,
  type UsageClient,
} from '../ipc/client';

import { Modal } from './Modal';
import { StorageMeter } from './StorageMeter';

export interface SettingsModalProps {
  client: SettingsClient;
  /** Injectable for tests; defaults to the real storage IPC client (backup/restore). */
  storage?: StorageClient;
  /** Injectable for tests; defaults to the real usage IPC client (config-driven pricing, M06.D). */
  usageClient?: UsageClient;
  onClose(): void;
}

// Test-connection state: a testing-in-flight marker, then the typed ping result.
type PingState = { readonly testing: true } | GatewayPingResult;

/*
 * The settings surface (M03.A; M07.D adds the provider switch). Enter the credential for the
 * active provider, see its STATUS, clear it. The secret is masked on entry, sent one-way to
 * the main process (encrypted via safeStorage), and NEVER rendered back — the modal only ever
 * reads booleans (`hasKey`/`encryptionAvailable`), never the secret. When OS encryption is
 * unavailable, saving is disabled and a clear error is shown (no plaintext fallback — gotcha
 * §2 / Hard Rule §10).
 *
 * M07.D: a provider picker (Anthropic | Gateway). Anthropic uses an `sk-ant-` x-api-key;
 * Gateway uses a base URL + an `sk-` BEARER token (the corp credential routes to Bedrock
 * behind the gateway). The gateway base URL is validated main-side (https except loopback) —
 * a save with a remote http URL is rejected and surfaced here, never transmitted.
 */
export function SettingsModal({
  client,
  storage = storageClient,
  usageClient = defaultUsageClient,
  onClose,
}: SettingsModalProps): ReactElement {
  const [provider, setProvider] = useState<ProviderId>('anthropic');
  const [gatewayUrl, setGatewayUrl] = useState('');
  const [proxyUrl, setProxyUrl] = useState('');
  const [pingResult, setPingResult] = useState<PingState | null>(null);
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [providerError, setProviderError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pricing, setPricing] = useState<PricingEntry[]>([]);
  const { surface } = useMutationToast();
  const { show } = useToasts();

  // Config-driven pricing (M06.D, ADR-0021): the price list is read from the updatable pricing
  // config main-side — NEVER hardcoded in this component.
  useEffect(() => {
    let active = true;
    void usageClient.pricing().then((entries) => {
      if (active) {
        setPricing(entries);
      }
    });
    return () => {
      active = false;
    };
  }, [usageClient]);

  // Load the active provider's status. The status is per-provider so the picker reflects
  // whether THIS provider has a credential saved.
  const refresh = useCallback(
    async (which: ProviderId): Promise<void> => {
      setStatus(await client.keyStatus(which));
    },
    [client],
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      const config = await client.getProvider();
      if (!active) {
        return;
      }
      setProvider(config.provider);
      if (config.provider === 'gateway') {
        setGatewayUrl(config.baseURL);
        setProxyUrl(config.proxyUrl ?? '');
      }
      setStatus(await client.keyStatus(config.provider));
    })();
    return () => {
      active = false;
    };
  }, [client]);

  // Before the first status load, assume encryption is available (so we don't flash an
  // error) and no key (so we don't claim one exists).
  const encryptionAvailable = status?.encryptionAvailable ?? true;
  const hasKey = status?.hasKey ?? false;
  const canSave = encryptionAvailable && draft.length > 0;

  // Switching the picker: anthropic persists immediately (no URL needed); gateway defers
  // persistence to Save (it needs a validated base URL). The credential status reloads for
  // the newly-selected provider either way.
  const handleProviderChange = useCallback(
    async (next: ProviderId): Promise<void> => {
      setProvider(next);
      setDraft('');
      setProviderError(null);
      setPingResult(null);
      setProxyUrl('');
      if (next === 'anthropic') {
        await surface(
          () => client.setProvider({ provider: 'anthropic' }),
          "Couldn't switch provider.",
        );
      }
      // The model catalog is provider-scoped (gateway serves a fixed set); invalidate the
      // main-process cache so the picker reflects the active provider on its next read.
      void catalogClient.refresh();
      await refresh(next);
    },
    [client, refresh, surface],
  );

  const handleSave = useCallback(async (): Promise<void> => {
    if (!encryptionAvailable || draft.length === 0) {
      return;
    }
    setProviderError(null);
    if (provider === 'gateway') {
      // Persist the (main-side validated) provider config first; the token is NOT sent until the
      // gateway is configured. An http non-localhost save succeeds but raises a non-blocking warning.
      try {
        const saved2: ProviderConfig = await client.setProvider({
          provider: 'gateway',
          baseURL: gatewayUrl,
          ...(proxyUrl ? { proxyUrl } : {}),
        });
        if (saved2.provider === 'gateway') {
          setGatewayUrl(saved2.baseURL);
        }
        // Provider-scoped model cache: refresh so the picker shows the gateway's fixed set.
        void catalogClient.refresh();
        try {
          const parsedUrl = new URL(gatewayUrl);
          const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
          if (parsedUrl.protocol === 'http:' && !loopbackHosts.has(parsedUrl.hostname)) {
            show({
              variant: 'warning',
              message:
                'Gateway saved using HTTP (not HTTPS). Ensure you are on a trusted network or VPN.',
              durationMs: 8000,
            });
          }
        } catch {
          /* non-URL: skip the HTTP warning */
        }
      } catch {
        setProviderError(
          'The gateway URL could not be saved. Ensure the URL is valid (http:// or https://).',
        );
        return;
      }
    }
    const saved = await surface(
      () => client.setKey(draft, provider),
      "Couldn't save your credential.",
    );
    if (saved === undefined) {
      return; // the failure was surfaced; keep the draft so the user can retry
    }
    // Drop the plaintext from renderer state the moment it is handed off.
    setDraft('');
    await refresh(provider);
  }, [client, draft, encryptionAvailable, gatewayUrl, proxyUrl, provider, refresh, show, surface]);

  const handleClear = useCallback(async (): Promise<void> => {
    const ok = await surface(
      () => client.clearKey(provider).then(() => true),
      "Couldn't clear your credential.",
    );
    if (!ok) {
      return;
    }
    await refresh(provider);
  }, [client, provider, refresh, surface]);

  // Test connection (gateway): a one-shot ping surfacing the auth + routing result inline.
  const handlePing = useCallback(async (): Promise<void> => {
    setPingResult({ testing: true });
    try {
      const result = await client.pingGateway();
      setPingResult(result);
    } catch {
      setPingResult({ ok: false, error: 'Ping failed — check console for details.' });
    }
  }, [client]);

  // Full backup (M06.C): export the whole store to one portable file. A cancelled save dialog is
  // silent; a success confirms the path. Errors route through surface().
  const handleBackup = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await surface(() => storage.backup(), "Couldn't create the backup.");
      if (result?.saved) {
        show({ variant: 'info', message: 'Backup saved.' });
      }
    } finally {
      setBusy(false);
    }
  }, [storage, surface, show]);

  // Restore (M06.C): destructive — the confirm + relaunch happen main-side. On success the app
  // relaunches (this UI won't continue). A newer-schema backup or a corrupt file is refused with a
  // clear message; a cancel is silent.
  const handleRestore = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await surface(() => storage.restore(), "Couldn't restore the backup.");
      if (result && !result.restored) {
        if (result.reason === 'incompatible-version') {
          show({
            variant: 'error',
            message:
              'That backup was made by a newer version of MeetingSpace and can’t be restored here.',
          });
        } else if (result.reason === 'invalid') {
          show({ variant: 'error', message: 'That file isn’t a valid MeetingSpace backup.' });
        }
      }
    } finally {
      setBusy(false);
    }
  }, [storage, surface, show]);

  const isGateway = provider === 'gateway';
  const keyLabel = isGateway ? 'Gateway token' : 'Anthropic API key';
  const keyPlaceholder = isGateway ? 'sk-…' : 'sk-ant-…';

  return (
    <Modal
      label="Settings"
      className="settings-modal"
      scrimTestId="settings-scrim"
      onClose={onClose}
    >
      <h2 className="settings-title">Settings</h2>

      <section className="settings-section">
        <h3 className="settings-subheading">Claude provider</h3>
        <p className="settings-help">
          Talk to Claude directly with an Anthropic API key, or through a corporate gateway (base
          URL + bearer token).
        </p>
        <label className="settings-field-label" htmlFor="provider-select">
          Provider
        </label>
        <select
          id="provider-select"
          className="settings-provider-select"
          aria-label="Claude provider"
          value={provider}
          onChange={(event) => void handleProviderChange(event.target.value as ProviderId)}
        >
          <option value="anthropic">Anthropic (direct API key)</option>
          <option value="gateway">Corporate gateway (base URL + token)</option>
        </select>
      </section>

      <section className="settings-section">
        <h3 className="settings-subheading">
          {isGateway ? 'Gateway credentials' : 'Anthropic API key'}
        </h3>
        <p className="settings-help">
          Used only by MeetingSpace, from this device. Your {isGateway ? 'token' : 'key'} is
          encrypted at rest by your operating system and never leaves your machine in plain text.
        </p>

        {!encryptionAvailable && (
          <p className="settings-error" data-testid="settings-encryption-error" role="alert">
            Your operating system’s secure storage is unavailable, so the{' '}
            {isGateway ? 'token' : 'key'} can’t be saved securely. It was not stored — MeetingSpace
            never falls back to plain text.
          </p>
        )}

        {providerError && (
          <p className="settings-error" data-testid="settings-provider-error" role="alert">
            {providerError}
          </p>
        )}

        {isGateway && (
          <>
            <label className="settings-field-label" htmlFor="gateway-url">
              Gateway base URL
            </label>
            <input
              id="gateway-url"
              className="settings-key-input"
              type="text"
              value={gatewayUrl}
              onChange={(event) => setGatewayUrl(event.target.value)}
              placeholder="https://gateway.example.com"
              autoComplete="off"
              spellCheck={false}
            />
            <label className="settings-field-label" htmlFor="gateway-proxy">
              Proxy URL (advanced — usually leave blank)
            </label>
            <input
              id="gateway-proxy"
              className="settings-key-input"
              type="text"
              value={proxyUrl}
              onChange={(event) => setProxyUrl(event.target.value)}
              placeholder="http://proxy.corp.example.com:8080"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="settings-help">
              Leave blank to use your system proxy — that works on most managed corporate machines.
              Only enter a proxy here if Test connection fails while this is blank (e.g. a machine
              with no system proxy configured); a value here overrides your system proxy.
            </p>
          </>
        )}

        <p className="settings-key-status" data-testid="settings-key-status">
          {hasKey
            ? `${isGateway ? 'Gateway token' : 'API key'} saved ✓`
            : `No ${isGateway ? 'gateway token' : 'API key'} saved`}
        </p>

        <label className="settings-field-label" htmlFor="anthropic-api-key">
          {keyLabel}
        </label>
        <input
          id="anthropic-api-key"
          className="settings-key-input"
          type="password"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={keyPlaceholder}
          autoComplete="off"
          spellCheck={false}
        />

        <div className="settings-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleSave()}
            disabled={!canSave}
          >
            {isGateway ? 'Save gateway' : 'Save key'}
          </button>
          {hasKey && (
            <button type="button" className="btn btn-secondary" onClick={() => void handleClear()}>
              {isGateway ? 'Clear token' : 'Clear key'}
            </button>
          )}
          {isGateway && hasKey && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void handlePing()}
              disabled={pingResult !== null && 'testing' in pingResult}
            >
              {pingResult !== null && 'testing' in pingResult ? 'Testing…' : 'Test connection'}
            </button>
          )}
        </div>

        {isGateway && pingResult !== null && !('testing' in pingResult) && (
          <p
            className={pingResult.ok ? 'settings-help' : 'settings-error'}
            data-testid="settings-ping-result"
            role="status"
          >
            {pingResult.ok
              ? '✓ Gateway reachable — Haiku responded successfully.'
              : `✗ ${pingResult.error}`}
          </p>
        )}
      </section>

      <section className="settings-section" data-testid="settings-spend-guidance">
        <h3 className="settings-subheading">Token usage &amp; cost</h3>
        <p className="settings-help">
          You pay for your own API usage. Approximate prices per million tokens (input / output),
          read from an editable pricing config — update it as prices change, no reinstall needed:
        </p>
        <ul className="settings-pricing">
          {pricing.map((entry) => (
            <li key={entry.model} className="settings-pricing-row">
              <span className="settings-pricing-model">{entry.label}</span>
              <span className="settings-pricing-rate">
                ${entry.inputPerMTok} / ${entry.outputPerMTok} per MTok
              </span>
            </li>
          ))}
        </ul>
        <p className="settings-help settings-pricing-note">
          Prompt caching reuses the session context at roughly a tenth of the input price. A model
          with no entry shows “cost unknown” in the counter — never a wrong number. The live token
          counter (next to the chat) shows your real usage for this session and today.
        </p>
      </section>

      <section className="settings-section" data-testid="settings-generation-cap">
        <h3 className="settings-subheading">White-paper generation</h3>
        <p className="settings-help">
          White-paper generation is capped at {GENERATION_MAX_TOKENS.toLocaleString('en-US')} output
          tokens per step (or the model’s own ceiling, whichever is lower), so a single step can’t
          run away on length.
        </p>
      </section>

      <StorageMeter />

      <section className="settings-section" data-testid="settings-backup">
        <h3 className="settings-subheading">Backup &amp; restore</h3>
        <p className="settings-help">
          Save everything — sessions, notes, screenshots, and generated documents — to a single
          portable file, or restore from one. Restoring replaces all current data and restarts the
          app.
        </p>
        <div className="settings-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void handleBackup()}
            disabled={busy}
          >
            Back up all data…
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void handleRestore()}
            disabled={busy}
          >
            Restore from backup…
          </button>
        </div>
      </section>

      <div className="settings-footer">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
