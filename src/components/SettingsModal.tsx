import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import { GENERATION_MAX_TOKENS } from '@shared/limits';
import { ANTHROPIC_PRICING_URL } from '@shared/links';
import type {
  CatalogModel,
  GatewayModelProfile,
  GatewayModelVerification,
  GatewayPingResult,
  KeyStatus,
  Prefs,
  PricingEntry,
  ProviderConfig,
  ProviderId,
  UnpricedModel,
} from '@shared/types';
import {
  curateGatewayModels,
  gatewayModelProfile,
  prefsWithGatewayModelProfile,
} from '@shared/models';

import { useDeferredDelete } from '../hooks/useDeferredDelete';
import { useMutationToast } from '../hooks/useMutationToast';
import { useToasts } from '../hooks/useToasts';
import {
  appClient,
  catalogClient,
  pricingClient as defaultPricingClient,
  storageClient,
  usageClient as defaultUsageClient,
  type PricingClient,
  type SettingsClient,
  type StorageClient,
  type UsageClient,
} from '../ipc/client';

import { notifyCatalogChanged } from '../ipc/catalog-events';

import { Modal } from './Modal';
import { StorageMeter } from './StorageMeter';

export interface SettingsModalProps {
  client: SettingsClient;
  /** Injectable for tests; defaults to the real storage IPC client (backup/restore). */
  storage?: StorageClient;
  /** Injectable for tests; defaults to the real usage IPC client (config-driven pricing, M06.D). */
  usageClient?: UsageClient;
  /** Injectable for tests; defaults to the real pricing IPC client (in-app override, M10.B). */
  pricingClient?: PricingClient;
  onClose(): void;
}

// Test-connection state: a testing-in-flight marker, then the typed ping result.
type PingState = { readonly testing: true } | GatewayPingResult;

function formatTestedAt(testedAt: number): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(testedAt));
}

function verificationLabel(result: GatewayModelVerification): string {
  const date = formatTestedAt(result.testedAt);
  if (result.stale) {
    return `Needs retest - last tested ${date}`;
  }
  if (result.status === 'available') {
    return `Available - verified ${date}`;
  }
  if (result.status === 'substituted') {
    return `Substituted - the gateway serves ${result.served ?? 'another model'} instead - tested ${date}`;
  }
  if (result.status === 'timeout') {
    return `Timed out - tested ${date}`;
  }
  return `Unavailable - tested ${date}${result.error ? `: ${result.error}` : ''}`;
}

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
  pricingClient = defaultPricingClient,
  onClose,
}: SettingsModalProps): ReactElement {
  const [provider, setProvider] = useState<ProviderId>('anthropic');
  const [gatewayUrl, setGatewayUrl] = useState('');
  const [savedGatewayUrl, setSavedGatewayUrl] = useState('');
  const [proxyUrl, setProxyUrl] = useState('');
  const [pingResult, setPingResult] = useState<PingState | null>(null);
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [providerError, setProviderError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pricing, setPricing] = useState<PricingEntry[]>([]);
  // M10.B (ADR-0027): the active-provider catalog models with no price + the in-app override form
  // state. Only one model is edited at a time, so a single pair of draft fields is shared.
  const [unpriced, setUnpriced] = useState<UnpricedModel[]>([]);
  const [editingModel, setEditingModel] = useState<string | null>(null);
  const [inputDraft, setInputDraft] = useState('');
  const [outputDraft, setOutputDraft] = useState('');
  const [savingPrice, setSavingPrice] = useState(false);
  // Gateway diagnostics (curated picker): the FULL advertised model list, the user's working
  // selection (seeded from the saved curation), and the per-id "what does it actually serve" results.
  const [gatewayModels, setGatewayModels] = useState<CatalogModel[]>([]);
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const [savedModelIds, setSavedModelIds] = useState<string[]>([]);
  const [modelDiagnosis, setModelDiagnosis] = useState<Record<string, GatewayModelVerification>>(
    {},
  );
  const [loadingModels, setLoadingModels] = useState(false);
  const [testingModels, setTestingModels] = useState(false);
  const [modelListError, setModelListError] = useState<string | null>(null);
  const [modelSelectionError, setModelSelectionError] = useState<string | null>(null);
  const { surface } = useMutationToast();
  const { show } = useToasts();
  // M10.B: delete a saved price via the F10 deferred-delete + Undo toast (optimistic remove; the
  // real pricing:delete fires only after the grace window; Undo cancels it; a failure restores).
  const { remove: deferRemove } = useDeferredDelete();
  // M10.B ext#3: ids of price-deletes still pending (added on Delete; removed on Undo, commit, and
  // failure-restore). The post-commit re-fetch runs only when this set is empty — last-mutation-wins
  // reconciliation, so a commit doesn't re-fetch a still-pending sibling as priced (the snap-back).
  const pendingPriceDeletes = useRef<Set<string>>(new Set());
  // Fire the "now test your models" nudge once per open, when a saved gateway list has never been
  // tested — an untested list can advertise models the gateway silently substitutes.
  const firstRunNudgeShown = useRef(false);

  const applyGatewayProfile = useCallback((baseURL: string, prefs: Prefs): void => {
    const profile = gatewayModelProfile(prefs, baseURL);
    const curated =
      profile.curatedModelIds.length > 0
        ? curateGatewayModels(profile.models, profile.curatedModelIds)
        : [];
    setGatewayModels([
      ...profile.models,
      ...curated.filter((model) => !profile.models.some((saved) => saved.id === model.id)),
    ]);
    setSelectedModelIds([...profile.curatedModelIds]);
    setSavedModelIds([...profile.curatedModelIds]);
    setModelDiagnosis({ ...profile.verifications });
    setModelListError(null);
    setModelSelectionError(null);
  }, []);

  // Config-driven pricing (M06.D, ADR-0021): the price list is read from the updatable pricing
  // config main-side — NEVER hardcoded in this component. M10.B: usage.pricing returns
  // { priced, unpriced }; the unpriced entries drive the in-app "set price" override.
  const refetchPricing = useCallback(async (): Promise<void> => {
    const status = await usageClient.pricing();
    setPricing(status.priced);
    setUnpriced(status.unpriced);
  }, [usageClient]);

  useEffect(() => {
    let active = true;
    void usageClient.pricing().then((status) => {
      if (active) {
        setPricing(status.priced);
        setUnpriced(status.unpriced);
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
      const [config, prefs] = await Promise.all([client.getProvider(), client.getPrefs()]);
      if (!active) {
        return;
      }
      setProvider(config.provider);
      if (config.provider === 'gateway') {
        setGatewayUrl(config.baseURL);
        setSavedGatewayUrl(config.baseURL);
        setProxyUrl(config.proxyUrl ?? '');
        applyGatewayProfile(config.baseURL, prefs);
      }
      setStatus(await client.keyStatus(config.provider));
    })();
    return () => {
      active = false;
    };
  }, [applyGatewayProfile, client]);

  // First-run nudge: a saved model list with zero recorded tests means the user hasn't yet checked
  // what the gateway actually serves. Prompt them to test (once), so a silently-substituted model
  // can't slip into the pickers untested.
  useEffect(() => {
    if (
      !firstRunNudgeShown.current &&
      gatewayModels.length > 0 &&
      Object.keys(modelDiagnosis).length === 0
    ) {
      firstRunNudgeShown.current = true;
      show({
        variant: 'info',
        message: 'Test your gateway models so the pickers only show what the gateway truly serves.',
      });
    }
  }, [gatewayModels, modelDiagnosis, show]);

  // Before the first status load, assume encryption is available (so we don't flash an
  // error) and no key (so we don't claim one exists).
  const encryptionAvailable = status?.encryptionAvailable ?? true;
  const hasKey = status?.hasKey ?? false;
  const canSave = encryptionAvailable && draft.length > 0;

  const persistGatewayProfile = useCallback(
    async (baseURL: string, profile: GatewayModelProfile): Promise<Prefs> => {
      const prefs = await client.getPrefs();
      return client.setPrefs(prefsWithGatewayModelProfile(prefs, baseURL, profile));
    },
    [client],
  );

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
        notifyCatalogChanged();
      } else {
        setSavedGatewayUrl('');
        setGatewayModels([]);
        setSelectedModelIds([]);
        setSavedModelIds([]);
        setModelDiagnosis({});
      }
      await refresh(next);
    },
    [client, refresh, surface],
  );

  const handleSave = useCallback(async (): Promise<void> => {
    if (!encryptionAvailable || draft.length === 0) {
      return;
    }
    setProviderError(null);
    let configuredGatewayUrl = savedGatewayUrl;
    if (provider === 'gateway') {
      // Persist the (main-side validated) provider config first; the token is NOT sent until the
      // gateway is configured. The base URL must be https (http only for localhost, or the explicit
      // MEETINGSPACE_ALLOW_INSECURE_GATEWAY_HTTP override) — a rejected URL surfaces below, unsent.
      try {
        const saved2: ProviderConfig = await client.setProvider({
          provider: 'gateway',
          baseURL: gatewayUrl,
          ...(proxyUrl ? { proxyUrl } : {}),
        });
        if (saved2.provider === 'gateway') {
          setGatewayUrl(saved2.baseURL);
          setSavedGatewayUrl(saved2.baseURL);
          configuredGatewayUrl = saved2.baseURL;
        }
      } catch {
        setProviderError(
          'The gateway URL was not saved. Use an https:// URL (http:// is allowed only for localhost).',
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
    if (provider === 'gateway' && saved.ok && configuredGatewayUrl) {
      const prefs = await client.getPrefs();
      const profile = gatewayModelProfile(prefs, configuredGatewayUrl);
      const staleProfile: GatewayModelProfile = {
        ...profile,
        verifications: Object.fromEntries(
          Object.entries(profile.verifications).map(([id, result]) => [
            id,
            { ...result, stale: true },
          ]),
        ),
      };
      const persisted = await surface(
        () => persistGatewayProfile(configuredGatewayUrl, staleProfile),
        "Couldn't update your saved model tests.",
      );
      if (persisted !== undefined) {
        applyGatewayProfile(configuredGatewayUrl, persisted);
      }
      await catalogClient.refresh();
      notifyCatalogChanged();
    }
    // Drop the plaintext from renderer state the moment it is handed off.
    setDraft('');
    await refresh(provider);
  }, [
    applyGatewayProfile,
    client,
    draft,
    encryptionAvailable,
    gatewayUrl,
    persistGatewayProfile,
    proxyUrl,
    provider,
    refresh,
    savedGatewayUrl,
    surface,
  ]);

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

  // Toggle a model in the working selection (the curated allowlist the dropdowns will show).
  const toggleModel = useCallback((id: string): void => {
    setModelSelectionError(null);
    setSelectedModelIds((prev) =>
      prev.includes(id) ? prev.filter((existing) => existing !== id) : [...prev, id],
    );
  }, []);

  // Refreshing the advertised list is explicit. Opening Settings only reads the persisted profile.
  const handleRefreshGatewayModels = useCallback(async (): Promise<void> => {
    if (!savedGatewayUrl) {
      return;
    }
    setLoadingModels(true);
    setModelListError(null);
    try {
      const models = (await client.listGatewayModels?.()) ?? [];
      const profile: GatewayModelProfile = {
        models,
        curatedModelIds: savedModelIds,
        verifications: modelDiagnosis,
      };
      const persisted = await surface(
        () => persistGatewayProfile(savedGatewayUrl, profile),
        "Couldn't save the refreshed model list.",
      );
      if (persisted !== undefined) {
        applyGatewayProfile(savedGatewayUrl, persisted);
        setSelectedModelIds([...selectedModelIds]);
        await catalogClient.refresh();
        notifyCatalogChanged();
        show({ variant: 'info', message: 'Gateway model list refreshed.' });
      }
    } catch {
      setModelListError(
        "Couldn't load the gateway model list. Check the gateway, proxy, and token, then retry.",
      );
    } finally {
      setLoadingModels(false);
    }
  }, [
    applyGatewayProfile,
    client,
    modelDiagnosis,
    persistGatewayProfile,
    savedGatewayUrl,
    savedModelIds,
    selectedModelIds,
    show,
    surface,
  ]);

  // Test a set of model ids: ping each (a streaming request shaped like real chat, so the gateway's
  // governance redirect fires) and record the model it ACTUALLY serves per row — so a substitution
  // (ask for Opus, get Sonnet) is visible before the user commits. The working selection is preserved
  // across the persist/reload. Shared by "Test selected" (the ticked ids) and "Test all" (every id).
  const runDiagnose = useCallback(
    async (ids: readonly string[]): Promise<void> => {
      if (ids.length === 0) {
        return;
      }
      setTestingModels(true);
      setModelSelectionError(null);
      try {
        const results = (await client.diagnoseGatewayModels?.(ids)) ?? [];
        const nextResults: Record<string, GatewayModelVerification> = { ...modelDiagnosis };
        for (const result of results) {
          nextResults[result.id] = { ...result, stale: false };
        }
        const profile: GatewayModelProfile = {
          models: gatewayModels,
          curatedModelIds: savedModelIds,
          verifications: nextResults,
        };
        const persisted = await surface(
          () => persistGatewayProfile(savedGatewayUrl, profile),
          "Couldn't save the model test results.",
        );
        if (persisted !== undefined) {
          applyGatewayProfile(savedGatewayUrl, persisted);
          setSelectedModelIds([...selectedModelIds]);
        }
      } catch {
        setModelSelectionError("Couldn't test the models. Please try again.");
      } finally {
        setTestingModels(false);
      }
    },
    [
      applyGatewayProfile,
      client,
      gatewayModels,
      modelDiagnosis,
      persistGatewayProfile,
      savedGatewayUrl,
      savedModelIds,
      selectedModelIds,
      surface,
    ],
  );

  const handleTestModels = useCallback(
    (): Promise<void> => runDiagnose(selectedModelIds),
    [runDiagnose, selectedModelIds],
  );

  // Test every advertised model in one pass — the fastest way to discover which ids the gateway
  // silently substitutes without ticking each one first.
  const handleTestAllModels = useCallback(
    (): Promise<void> => runDiagnose(gatewayModels.map((model) => model.id)),
    [gatewayModels, runDiagnose],
  );

  // Persist the verified allowlist, then refresh the provider-scoped catalog so both pickers update.
  const handleSaveModels = useCallback(async (): Promise<void> => {
    const unverified = selectedModelIds.filter(
      (id) =>
        !savedModelIds.includes(id) &&
        (!modelDiagnosis[id]?.ok || modelDiagnosis[id]?.stale === true),
    );
    if (selectedModelIds.length === 0) {
      setModelSelectionError('Select at least one model.');
      return;
    }
    if (unverified.length > 0) {
      setModelSelectionError('Test newly selected models successfully before adding them.');
      return;
    }
    const profile: GatewayModelProfile = {
      models: gatewayModels,
      curatedModelIds: selectedModelIds,
      verifications: modelDiagnosis,
    };
    const saved = await surface(
      () => persistGatewayProfile(savedGatewayUrl, profile),
      "Couldn't save your model selection.",
    );
    if (saved === undefined) {
      return;
    }
    // Refresh main's provider-scoped cache to the new curation, then nudge every open picker (chat +
    // white paper) to re-pull it — so the dropdowns update immediately, with no manual refresh.
    await catalogClient.refresh();
    notifyCatalogChanged();
    applyGatewayProfile(savedGatewayUrl, saved);
    show({ variant: 'info', message: 'Model list saved.' });
  }, [
    applyGatewayProfile,
    gatewayModels,
    modelDiagnosis,
    persistGatewayProfile,
    savedGatewayUrl,
    savedModelIds,
    selectedModelIds,
    show,
    surface,
  ]);

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

  // M10.B: client-side input hygiene — both fields must parse to a finite, non-negative number
  // before Save enables. Main re-validates (Stage A), so the renderer is never the only guard.
  const inputValue = Number(inputDraft);
  const outputValue = Number(outputDraft);
  const priceValid =
    inputDraft.trim() !== '' &&
    outputDraft.trim() !== '' &&
    Number.isFinite(inputValue) &&
    inputValue >= 0 &&
    Number.isFinite(outputValue) &&
    outputValue >= 0;

  const beginSetPrice = useCallback((modelId: string): void => {
    setEditingModel(modelId);
    setInputDraft('');
    setOutputDraft('');
  }, []);

  const cancelSetPrice = useCallback((): void => {
    setEditingModel(null);
    setInputDraft('');
    setOutputDraft('');
  }, []);

  const handleSetPrice = useCallback(
    async (modelId: string): Promise<void> => {
      if (!priceValid) {
        return;
      }
      setSavingPrice(true);
      try {
        const ok = await surface(
          () =>
            pricingClient
              .update(modelId, { inputPerMTok: inputValue, outputPerMTok: outputValue })
              .then(() => true),
          "Couldn't save the price.",
        );
        if (ok === undefined) {
          return; // failure surfaced; keep the form open so the user can retry
        }
        // Re-fetch (not an optimistic hide) so the model moves to the priced list AND the live
        // counter reprices with the new number — the IRL teeth is the counter, not jsdom green.
        await refetchPricing();
        setEditingModel(null);
        setInputDraft('');
        setOutputDraft('');
      } finally {
        setSavingPrice(false);
      }
    },
    [inputValue, outputValue, priceValid, pricingClient, refetchPricing, surface],
  );

  // M10.B: reopen the SAME inline form pre-filled with a priced model's current rate (edit reuses
  // pricing:update — save-in-place, cancel reverts; mirror PromptTemplateEditor). editingModel is a
  // single id, so only one row's form is ever open at a time (a new open supersedes the last).
  const beginEditPrice = useCallback((entry: PricingEntry): void => {
    setEditingModel(entry.model);
    setInputDraft(String(entry.inputPerMTok));
    setOutputDraft(String(entry.outputPerMTok));
  }, []);

  // M10.B (§10): delete a saved price — deferred (F10). Remove the row optimistically; the real
  // pricing:delete fires only after the grace window. Undo restores and fires no delete. commit is
  // the delete ONLY (its rejection is what restores); the re-fetch runs AFTER a successful delete
  // with its own catch, so a re-fetch failure never restores a row already deleted on disk.
  const handleDeletePrice = useCallback(
    (entry: PricingEntry): void => {
      const index = pricing.findIndex((e) => e.model === entry.model);
      if (index < 0) {
        return;
      }
      // Immediate reconcile (ext#2): the row leaves the priced list AND appears in the red "Cost
      // tracking off" section in the SAME update — never absent from both. Undo/failure reverses
      // both moves. (Every deleted model goes unpriced now — seed-revert is gone; the post-delete
      // re-fetch replaces this optimistic entry with the authoritative one.)
      setPricing((prev) => prev.filter((e) => e.model !== entry.model));
      setUnpriced((prev) =>
        prev.some((u) => u.id === entry.model)
          ? prev
          : [...prev, { id: entry.model, label: entry.label }],
      );
      // ext#3: this delete is now pending. Removed on every exit (Undo/failure via revertOptimistic;
      // success in commit) — a leaked id would permanently suppress the post-commit re-fetch.
      pendingPriceDeletes.current.add(entry.model);
      const revertOptimistic = (): void => {
        pendingPriceDeletes.current.delete(entry.model);
        setPricing((prev) => {
          if (prev.some((e) => e.model === entry.model)) {
            return prev;
          }
          const next = [...prev];
          next.splice(Math.min(index, next.length), 0, entry);
          return next;
        });
        setUnpriced((prev) => prev.filter((u) => u.id !== entry.model));
      };
      deferRemove({
        key: `price-del-${entry.model}`,
        label: 'Price removed',
        errorMessage: "Couldn't remove the price.",
        // ext#3: closing Settings while the Undo toast is up commits the delete (Gmail
        // navigate-away semantics) instead of the default cancel-on-unmount that would drop it.
        onUnmount: 'commit',
        commit: async () => {
          await pricingClient.delete(entry.model);
          pendingPriceDeletes.current.delete(entry.model);
          // ext#3: reconcile + reprice the live counter ONLY after the LAST pending delete lands —
          // re-fetching while a sibling delete is still pending would report it as priced and snap
          // it back. A re-fetch failure must NOT restore a row already deleted on disk — swallow it.
          if (pendingPriceDeletes.current.size === 0) {
            void refetchPricing().catch(() => undefined);
          }
        },
        restore: revertOptimistic,
      });
    },
    [pricing, deferRemove, pricingClient, refetchPricing],
  );

  // The shared inline two-field price form (M10.B) — used by both the unpriced "Set price" flow and
  // the priced-row "Edit" flow. Save-in-place and Cancel are identical; only the pre-fill differs
  // (beginSetPrice clears, beginEditPrice pre-fills), so the form itself is one definition.
  const renderPriceForm = (modelId: string): ReactElement => (
    <form
      className="settings-pricing-form"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSetPrice(modelId);
      }}
    >
      <label className="settings-pricing-field">
        <span className="settings-field-label">Input $/MTok</span>
        <input
          className="settings-key-input"
          type="number"
          min="0"
          step="any"
          inputMode="decimal"
          value={inputDraft}
          onChange={(event) => setInputDraft(event.target.value)}
        />
      </label>
      <label className="settings-pricing-field">
        <span className="settings-field-label">Output $/MTok</span>
        <input
          className="settings-key-input"
          type="number"
          min="0"
          step="any"
          inputMode="decimal"
          value={outputDraft}
          onChange={(event) => setOutputDraft(event.target.value)}
        />
      </label>
      <div className="settings-actions">
        <button type="submit" className="btn btn-primary" disabled={!priceValid || savingPrice}>
          {savingPrice ? 'Saving…' : 'Save price'}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={cancelSetPrice}
          disabled={savingPrice}
        >
          Cancel
        </button>
      </div>
    </form>
  );

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
            <p className="settings-help">
              Must be an <strong>https://</strong> URL (http:// is allowed only for localhost).
            </p>
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

      {isGateway && hasKey && savedGatewayUrl && (
        <section className="settings-section" data-testid="settings-gateway-models">
          <h3 className="settings-subheading">Gateway models</h3>
          <p className="settings-help">
            Your saved model list and test results stay on this device for this gateway. Refresh the
            list or retest only when you choose. Newly selected models must pass a test before they
            can be added to both the chat and white-paper pickers.
          </p>

          <div className="settings-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void handleRefreshGatewayModels()}
              disabled={loadingModels || testingModels}
            >
              {loadingModels ? 'Refreshing list…' : 'Refresh model list'}
            </button>
          </div>

          {modelListError && (
            <p className="settings-error" role="alert" data-testid="settings-model-list-error">
              {modelListError}
            </p>
          )}

          {loadingModels ? (
            <p className="settings-help" data-testid="settings-gateway-models-loading">
              Contacting the gateway’s model endpoint…
            </p>
          ) : gatewayModels.length === 0 ? (
            <p className="settings-help">No model list is saved yet. Refresh the list to begin.</p>
          ) : (
            <ul className="settings-gateway-models">
              {gatewayModels.map((model) => {
                const result = modelDiagnosis[model.id];
                return (
                  <li key={model.id} className="settings-gateway-model">
                    <label className="settings-gateway-model-pick">
                      <input
                        type="checkbox"
                        checked={selectedModelIds.includes(model.id)}
                        onChange={() => toggleModel(model.id)}
                        aria-label={`Show ${model.label} in the model pickers`}
                      />
                      <span className="settings-gateway-model-label">{model.label}</span>
                      <code className="settings-gateway-model-id">{model.id}</code>
                    </label>
                    {result && (
                      <span
                        className={
                          result.status === 'available' && !result.stale
                            ? 'settings-success'
                            : 'settings-error'
                        }
                        data-testid="settings-gateway-model-served"
                      >
                        {verificationLabel(result)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {modelSelectionError && (
            <p className="settings-error" role="alert" data-testid="settings-model-selection-error">
              {modelSelectionError}
            </p>
          )}

          <div className="settings-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void handleTestModels()}
              disabled={testingModels || selectedModelIds.length === 0}
            >
              {testingModels ? 'Testing…' : 'Test selected'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void handleTestAllModels()}
              disabled={testingModels || gatewayModels.length === 0}
            >
              {testingModels ? 'Testing…' : 'Test all'}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handleSaveModels()}
              disabled={testingModels || loadingModels}
            >
              Save models
            </button>
          </div>
        </section>
      )}

      <section className="settings-section" data-testid="settings-spend-guidance">
        <h3 className="settings-subheading">Token usage &amp; cost</h3>
        <p className="settings-help">
          Cost is your token usage × these prices. Anthropic doesn’t send prices in its API, so
          they’re stored locally and you can set or edit them right here — no reinstall. A new model
          (or a corporate gateway’s negotiated rate) may show “cost unknown” until you set a price
          below.
        </p>
        <p className="settings-help">
          Anthropic’s current published prices:{' '}
          <button
            type="button"
            className="settings-link-button"
            aria-label="Open Anthropic pricing page in your browser"
            onClick={() => appClient.openPricingDocs()}
          >
            {ANTHROPIC_PRICING_URL}
          </button>
        </p>

        {unpriced.length > 0 && (
          <ul className="settings-pricing-unpriced" data-testid="settings-pricing-unpriced">
            {unpriced.map((model) => {
              const editing = editingModel === model.id;
              return (
                <li key={model.id} className="settings-pricing-unpriced-row">
                  <div className="settings-pricing-unpriced-head">
                    <span className="settings-pricing-model">{model.label}</span>
                    <span className="settings-pricing-unpriced-chip">Cost tracking off</span>
                    {!editing && (
                      <button
                        type="button"
                        className="btn btn-primary settings-set-price-btn"
                        onClick={() => beginSetPrice(model.id)}
                      >
                        Set price
                      </button>
                    )}
                  </div>
                  {editing && renderPriceForm(model.id)}
                </li>
              );
            })}
          </ul>
        )}

        <ul className="settings-pricing">
          {pricing.map((entry) => {
            const editing = editingModel === entry.model;
            return (
              <li key={entry.model} className="settings-pricing-row">
                <div className="settings-pricing-row-head">
                  <span className="settings-pricing-model">{entry.label}</span>
                  <span className="settings-pricing-rate">
                    ${entry.inputPerMTok} / ${entry.outputPerMTok} per MTok
                  </span>
                  {!editing && (
                    <span className="settings-pricing-actions">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        aria-label={`Edit price for ${entry.label}`}
                        onClick={() => beginEditPrice(entry)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        aria-label={`Delete price for ${entry.label}`}
                        onClick={() => handleDeletePrice(entry)}
                      >
                        Delete
                      </button>
                    </span>
                  )}
                </div>
                {editing && renderPriceForm(entry.model)}
              </li>
            );
          })}
        </ul>

        <p className="settings-help settings-pricing-note">
          Prompt caching reuses the session context at roughly a tenth of the input price. Prices
          take effect immediately — the live token counter (next to the chat) shows your real usage
          for this session and today.
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
