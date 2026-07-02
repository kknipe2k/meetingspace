// @vitest-environment jsdom
import { useState, type ReactElement } from 'react';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PricingApi, SettingsApi, UsageApi } from '@shared/api';
import type { KeyStatus, ModelPrice, PricingEntry, UnpricedModel } from '@shared/types';
import { ANTHROPIC_PRICING_URL } from '@shared/links';

import { SettingsModal } from '../../src/components/SettingsModal';
import { ToastHost } from '../../src/components/ToastHost';
import { ToastProvider } from '../../src/hooks/useToasts';
import { appClient } from '../../src/ipc/client';

/*
 * M10.B (ADR-0027): the in-app price override. An unpriced catalog model (a new model the seed
 * doesn't cover, or a corporate gateway's negotiated rate) shows a prominent RED "Cost tracking
 * off — set price" control with inline input/output $/MTok fields that write via pricing:update and
 * re-fetch, so the model moves to the priced list and the live counter reprices. Driven with fakes
 * — no key, no SDK, no CHAT_MODELS import (prices flow over IPC only).
 */
const KEY_STATUS: KeyStatus = { hasKey: false, encryptionAvailable: true };

function settingsClient(): SettingsApi {
  return {
    setKey: vi.fn(async () => ({ ok: true as const })),
    keyStatus: vi.fn(async () => KEY_STATUS),
    clearKey: vi.fn(async () => undefined),
    getPrefs: vi.fn(async () => ({})),
    setPrefs: vi.fn(async (p) => p),
    getProvider: vi.fn(async () => ({ provider: 'anthropic' as const })),
    setProvider: vi.fn(async (p) => p),
    pingGateway: vi.fn(async () => ({ ok: true as const })),
  };
}

const EMPTY_TOTALS = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  unpricedCalls: 0,
} as const;

// A stateful pricing pair: `pricing()` reflects the current split; `update()` moves the model from
// unpriced to priced (as the real engine does after an atomic write), so a re-fetch after Save is
// observable. Mirrors the Stage A contract (usage.pricing → { priced, unpriced }).
function statefulPricing(
  initialPriced: PricingEntry[],
  initialUnpriced: UnpricedModel[],
): { usage: UsageApi; pricing: PricingApi } {
  let priced = [...initialPriced];
  let unpriced = [...initialUnpriced];
  const usage: UsageApi = {
    summary: vi.fn(async () => ({ sessionToday: EMPTY_TOTALS, allToday: EMPTY_TOTALS })),
    pricing: vi.fn(async () => ({ priced: [...priced], unpriced: [...unpriced] })),
  };
  const pricing: PricingApi = {
    update: vi.fn(async (model: string, price: ModelPrice) => {
      const moved = unpriced.find((u) => u.id === model);
      unpriced = unpriced.filter((u) => u.id !== model);
      priced = [
        ...priced.filter((p) => p.model !== model),
        {
          model,
          label: moved?.label ?? priced.find((p) => p.model === model)?.label ?? model,
          inputPerMTok: price.inputPerMTok,
          outputPerMTok: price.outputPerMTok,
        },
      ];
    }),
    // Drop the user override. This fake models a NON-seed model (returns to unpriced) — the
    // seed-reversion branch is engine-tested (pricing-config.test.ts). A re-fetch after the real
    // delete is what reconciles the split, so pricing() reflects the move.
    delete: vi.fn(async (model: string) => {
      const moved = priced.find((p) => p.model === model);
      priced = priced.filter((p) => p.model !== model);
      if (moved) {
        unpriced = [...unpriced, { id: moved.model, label: moved.label }];
      }
    }),
  };
  return { usage, pricing };
}

const PRICED: PricingEntry[] = [
  { model: 'claude-opus-4-8', label: 'Claude Opus 4.8', inputPerMTok: 15, outputPerMTok: 75 },
];
const UNPRICED: UnpricedModel[] = [{ id: 'claude-sonnet-5', label: 'Claude Sonnet 5' }];

function renderModal(priced = PRICED, unpriced = UNPRICED) {
  const { usage, pricing } = statefulPricing(priced, unpriced);
  render(
    <SettingsModal
      client={settingsClient()}
      usageClient={usage}
      pricingClient={pricing}
      onClose={() => undefined}
    />,
  );
  return { usage, pricing };
}

// Delete uses the deferred-delete + Undo toast (F10 useDeferredDelete), which needs a real
// ToastProvider + ToastHost to render the Undo affordance (the context default is a no-op).
function renderModalWithToasts(priced = PRICED, unpriced = UNPRICED) {
  const { usage, pricing } = statefulPricing(priced, unpriced);
  render(
    <ToastProvider>
      <SettingsModal
        client={settingsClient()}
        usageClient={usage}
        pricingClient={pricing}
        onClose={() => undefined}
      />
      <ToastHost />
    </ToastProvider>,
  );
  return { usage, pricing };
}

// The deferred-delete grace window (useDeferredDelete DEFAULT_GRACE_MS).
const GRACE_MS = 30000;

describe('SettingsModal — in-app price override (M10.B)', () => {
  it('shows a prominent "Cost tracking off — set price" affordance for an unpriced model', async () => {
    renderModal();
    expect(await screen.findByText('Claude Sonnet 5')).toBeInTheDocument();
    expect(screen.getByText(/cost tracking off/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /set price/i })).toBeInTheDocument();
  });

  it('shows a priced model with its rate and no red "set price" affordance', async () => {
    renderModal(PRICED, []);
    expect(await screen.findByText('Claude Opus 4.8')).toBeInTheDocument();
    expect(screen.getByText(/\$15 \/ \$75/)).toBeInTheDocument();
    expect(screen.queryByText(/cost tracking off/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /set price/i })).not.toBeInTheDocument();
  });

  it('replaces the "edit pricing.json" instruction with in-app help text', async () => {
    renderModal();
    // The old hand-edit-a-file framing must be gone.
    expect(screen.queryByText(/pricing\.json/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/edit it as prices change/i)).not.toBeInTheDocument();
    // The new help text explains cost = tokens × a local price + the "cost unknown" path.
    expect(await screen.findByText(/stored locally/i)).toBeInTheDocument();
    expect(screen.getByText(/cost unknown/i)).toBeInTheDocument();
  });

  it('Save disabled until both input and output are non-negative finite; enabled when valid', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(await screen.findByRole('button', { name: /set price/i }));

    const inputField = screen.getByLabelText(/input \$\/mtok/i);
    const outputField = screen.getByLabelText(/output \$\/mtok/i);
    const save = screen.getByRole('button', { name: /save price/i });

    // Nothing entered → disabled.
    expect(save).toBeDisabled();

    // Only one field → still disabled. (fireEvent.change sets the value directly, bypassing
    // number-input keystroke filtering so the negative case below is deterministic.)
    fireEvent.change(inputField, { target: { value: '2' } });
    expect(save).toBeDisabled();

    // A negative value is rejected client-side.
    fireEvent.change(outputField, { target: { value: '-10' } });
    expect(save).toBeDisabled();

    // Both valid → enabled.
    fireEvent.change(outputField, { target: { value: '10' } });
    expect(save).toBeEnabled();
  });

  it('Save writes via pricing:update with the right args, re-fetches, and the model moves to priced', async () => {
    const user = userEvent.setup();
    const { usage, pricing } = renderModal();

    // one initial read on mount
    await waitFor(() => expect(usage.pricing).toHaveBeenCalledTimes(1));

    await user.click(await screen.findByRole('button', { name: /set price/i }));
    fireEvent.change(screen.getByLabelText(/input \$\/mtok/i), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText(/output \$\/mtok/i), { target: { value: '10' } });
    await user.click(screen.getByRole('button', { name: /save price/i }));

    expect(pricing.update).toHaveBeenCalledWith('claude-sonnet-5', {
      inputPerMTok: 2,
      outputPerMTok: 10,
    });
    // A re-fetch (not an optimistic hide) is what reprices the live counter.
    await waitFor(() => expect(usage.pricing).toHaveBeenCalledTimes(2));

    // The model is now priced: the red affordance is gone and its rate shows.
    await waitFor(() => expect(screen.queryByText(/cost tracking off/i)).not.toBeInTheDocument());
    expect(screen.getByText(/\$2 \/ \$10/)).toBeInTheDocument();
  });

  it('lets the user cancel out of the set-price form without writing', async () => {
    const user = userEvent.setup();
    const { pricing } = renderModal();
    await user.click(await screen.findByRole('button', { name: /set price/i }));
    expect(screen.getByLabelText(/input \$\/mtok/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.queryByLabelText(/input \$\/mtok/i)).not.toBeInTheDocument();
    expect(pricing.update).not.toHaveBeenCalled();
    // The affordance is still available to reopen.
    expect(screen.getByRole('button', { name: /set price/i })).toBeInTheDocument();
  });
});

describe('SettingsModal — edit a priced model (M10.B; PromptTemplateEditor convention)', () => {
  it('Edit reopens the inline form pre-filled and save-in-place writes via pricing:update', async () => {
    const user = userEvent.setup();
    const { pricing, usage } = renderModal(PRICED, []);
    await waitFor(() => expect(usage.pricing).toHaveBeenCalledTimes(1));

    await user.click(
      await screen.findByRole('button', { name: /edit price for claude opus 4\.8/i }),
    );
    const input = screen.getByLabelText(/input \$\/mtok/i);
    const output = screen.getByLabelText(/output \$\/mtok/i);
    // Pre-filled with the current rate (not blank — this is edit, not set).
    expect(input).toHaveValue(15);
    expect(output).toHaveValue(75);

    fireEvent.change(input, { target: { value: '20' } });
    await user.click(screen.getByRole('button', { name: /save price/i }));

    expect(pricing.update).toHaveBeenCalledWith('claude-opus-4-8', {
      inputPerMTok: 20,
      outputPerMTok: 75,
    });
    // A re-fetch reprices the live counter; the row shows the edited rate.
    await waitFor(() => expect(usage.pricing).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/\$20 \/ \$75/)).toBeInTheDocument();
  });

  it('Edit cancel writes nothing and reverts to the shown rate', async () => {
    const user = userEvent.setup();
    const { pricing } = renderModal(PRICED, []);
    await user.click(
      await screen.findByRole('button', { name: /edit price for claude opus 4\.8/i }),
    );
    fireEvent.change(screen.getByLabelText(/input \$\/mtok/i), { target: { value: '999' } });
    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(pricing.update).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/input \$\/mtok/i)).not.toBeInTheDocument();
    // The shown rate is unchanged — cancel reverted, no write.
    expect(screen.getByText(/\$15 \/ \$75/)).toBeInTheDocument();
  });

  it('opens only one inline form at a time (Edit supersedes an open Set form)', async () => {
    const user = userEvent.setup();
    renderModal(PRICED, UNPRICED); // opus priced + sonnet-5 unpriced
    await user.click(await screen.findByRole('button', { name: /set price/i }));
    expect(screen.getAllByLabelText(/input \$\/mtok/i)).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /edit price for claude opus 4\.8/i }));
    // Still exactly one form, now the edit form pre-filled with opus's rate.
    expect(screen.getAllByLabelText(/input \$\/mtok/i)).toHaveLength(1);
    expect(screen.getByLabelText(/input \$\/mtok/i)).toHaveValue(15);
  });
});

describe('SettingsModal — delete a priced model (M10.B ext#2; immediate reconcile + Undo)', () => {
  beforeEach(() => {
    // shouldAdvanceTime lets RTL's findBy polling proceed while still allowing explicit
    // advanceTimersByTime to jump the deferred-delete grace window.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('moves the row into the red "Cost tracking off" section IMMEDIATELY (never absent from both)', async () => {
    const { pricing } = renderModalWithToasts(PRICED, []); // opus priced, none unpriced
    fireEvent.click(
      await screen.findByRole('button', { name: /delete price for claude opus 4\.8/i }),
    );

    // Gone from the priced list...
    await waitFor(() => expect(screen.queryByText(/\$15 \/ \$75/)).not.toBeInTheDocument());
    // ...and immediately present in the red "Cost tracking off" section (optimistic reconcile —
    // never a render where it is in neither list), while the Undo toast is still up.
    expect(
      within(screen.getByTestId('settings-pricing-unpriced')).getByText('Claude Opus 4.8'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(pricing.delete).not.toHaveBeenCalled();
  });

  it('Undo restores the priced row, removes the optimistic unpriced entry, and fires no delete', async () => {
    const { pricing } = renderModalWithToasts(PRICED, []);
    fireEvent.click(
      await screen.findByRole('button', { name: /delete price for claude opus 4\.8/i }),
    );
    // The optimistic red entry appears first (proves the immediate reconcile ran)...
    expect(
      await within(screen.getByTestId('settings-pricing-unpriced')).findByText('Claude Opus 4.8'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    // ...then Undo reverses BOTH moves: the priced row is back, the optimistic red entry is gone.
    expect(await screen.findByText(/\$15 \/ \$75/)).toBeInTheDocument();
    expect(screen.queryByTestId('settings-pricing-unpriced')).not.toBeInTheDocument();

    // Grace elapses — Undo cancelled the delete, so it never fires.
    act(() => vi.advanceTimersByTime(GRACE_MS * 2));
    expect(pricing.delete).not.toHaveBeenCalled();
  });

  it('fires pricing:delete after the grace window; the model stays in "cost tracking off"', async () => {
    const { pricing } = renderModalWithToasts(PRICED, []);
    fireEvent.click(
      await screen.findByRole('button', { name: /delete price for claude opus 4\.8/i }),
    );

    await act(async () => {
      vi.advanceTimersByTime(GRACE_MS);
    });

    expect(pricing.delete).toHaveBeenCalledWith('claude-opus-4-8');
    // The optimistic entry + the post-delete re-fetch agree — still unpriced.
    expect(await screen.findByText(/cost tracking off/i)).toBeInTheDocument();
  });
});

describe('SettingsModal — undo correctness (M10.B ext#3)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const TWO_PRICED: PricingEntry[] = [
    { model: 'claude-opus-4-8', label: 'Claude Opus 4.8', inputPerMTok: 15, outputPerMTok: 75 },
    { model: 'claude-sonnet-5', label: 'Claude Sonnet 5', inputPerMTok: 2, outputPerMTok: 10 },
  ];

  it('commits a pending price-delete when Settings closes — unmount flush (Gmail navigate-away)', async () => {
    const { usage, pricing } = statefulPricing(PRICED, []);
    // The ToastProvider + ToastHost outlive the modal (app-level host), like the real app; only the
    // SettingsModal unmounts when Settings closes.
    function Wrapper(): ReactElement {
      const [open, setOpen] = useState(true);
      return (
        <ToastProvider>
          {open && (
            <SettingsModal
              client={settingsClient()}
              usageClient={usage}
              pricingClient={pricing}
              onClose={() => undefined}
            />
          )}
          <ToastHost />
          <button type="button" onClick={() => setOpen(false)}>
            close-settings
          </button>
        </ToastProvider>
      );
    }
    render(<Wrapper />);

    fireEvent.click(
      await screen.findByRole('button', { name: /delete price for claude opus 4\.8/i }),
    );
    expect(pricing.delete).not.toHaveBeenCalled();

    // Close Settings while the Undo toast is still up → the delete flushes now (no grace wait),
    // instead of the default cancel-on-unmount that would silently drop it.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'close-settings' }));
    });
    expect(pricing.delete).toHaveBeenCalledWith('claude-opus-4-8');

    // The grace timer was cleared on flush — advancing does not double-fire.
    await act(async () => {
      vi.advanceTimersByTime(GRACE_MS * 2);
    });
    expect(pricing.delete).toHaveBeenCalledTimes(1);
  });

  it('re-fetches ONLY after the last pending delete — no snap-back with two in flight', async () => {
    const { usage, pricing } = renderModalWithToasts(TWO_PRICED, []);
    await waitFor(() => expect(usage.pricing).toHaveBeenCalledTimes(1)); // one read on mount

    // Delete A at t=0; its 30s timer fires at t=GRACE_MS.
    fireEvent.click(
      await screen.findByRole('button', { name: /delete price for claude opus 4\.8/i }),
    );
    // Delete B half a grace window later; its own 30s timer fires at t=1.5·GRACE_MS.
    act(() => vi.advanceTimersByTime(GRACE_MS / 2));
    fireEvent.click(screen.getByRole('button', { name: /delete price for claude sonnet 5/i }));

    // Reach A's fire time (t=GRACE_MS) — B is still pending.
    await act(async () => {
      vi.advanceTimersByTime(GRACE_MS / 2);
    });
    expect(pricing.delete).toHaveBeenCalledWith('claude-opus-4-8');
    // First commit with B still pending → NO re-fetch (a re-fetch here would report B as priced and
    // snap it back into the priced list). Still just the mount read.
    expect(usage.pricing).toHaveBeenCalledTimes(1);

    // Reach B's fire time (t=1.5·GRACE_MS) — the pending set is now empty.
    await act(async () => {
      vi.advanceTimersByTime(GRACE_MS);
    });
    expect(pricing.delete).toHaveBeenCalledWith('claude-sonnet-5');
    // Last commit → exactly one re-fetch reconciles from the source of truth.
    expect(usage.pricing).toHaveBeenCalledTimes(2);
  });

  it('an Undo of the only pending delete does not re-fetch (optimistic state already correct)', async () => {
    const { usage, pricing } = renderModalWithToasts(PRICED, []);
    await waitFor(() => expect(usage.pricing).toHaveBeenCalledTimes(1));

    fireEvent.click(
      await screen.findByRole('button', { name: /delete price for claude opus 4\.8/i }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    // Grace elapses — Undo cancelled the delete and no re-fetch ran (still just the mount read).
    act(() => vi.advanceTimersByTime(GRACE_MS * 2));
    expect(pricing.delete).not.toHaveBeenCalled();
    expect(usage.pricing).toHaveBeenCalledTimes(1);
  });
});

describe('SettingsModal — Anthropic pricing-docs link (M10.B ext#2, §10)', () => {
  it('renders the pricing-docs URL and opens it via appClient.openPricingDocs (no window.open)', async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(appClient, 'openPricingDocs').mockImplementation(() => undefined);
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    try {
      renderModal(PRICED, []);
      const link = await screen.findByRole('button', {
        name: /anthropic pricing page/i,
      });
      // The visible text IS the canonical URL (from the shared constant).
      expect(link).toHaveTextContent(ANTHROPIC_PRICING_URL);

      await user.click(link);

      // The link goes over the argument-less IPC channel — never window.open / navigation.
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(windowOpen).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
      windowOpen.mockRestore();
    }
  });
});
