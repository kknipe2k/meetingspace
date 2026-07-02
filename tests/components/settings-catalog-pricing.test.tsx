// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { SettingsApi, UsageApi } from '@shared/api';
import type { KeyStatus, PricingEntry } from '@shared/types';

import { SettingsModal } from '../../src/components/SettingsModal';

/*
 * M06.D (ADR-0021): the Settings pricing list is CONFIG-DRIVEN (from usage.pricing), not the
 * hardcoded CHAT_MODELS table, and the white-paper section shows the 32K generation cap as a
 * static FYI. Driven with fakes — no key, no SDK.
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

const PRICING: PricingEntry[] = [
  { model: 'config-only-model', label: 'Config Only Model', inputPerMTok: 7, outputPerMTok: 21 },
];

function usageClient(): UsageApi {
  return {
    summary: vi.fn(async () => ({
      sessionToday: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        unpricedCalls: 0,
      },
      allToday: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        unpricedCalls: 0,
      },
    })),
    pricing: vi.fn(async () => ({ priced: PRICING, unpriced: [] })),
  };
}

describe('SettingsModal — config pricing + WP cap', () => {
  it('renders prices from the pricing config, not the hardcoded table', async () => {
    render(
      <SettingsModal
        client={settingsClient()}
        usageClient={usageClient()}
        onClose={() => undefined}
      />,
    );

    expect(await screen.findByText('Config Only Model')).toBeInTheDocument();
    expect(screen.getByText(/\$7 \/ \$21/)).toBeInTheDocument();
  });

  it('shows the 32K white-paper generation cap as a static FYI', () => {
    render(
      <SettingsModal
        client={settingsClient()}
        usageClient={usageClient()}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText(/32,000/)).toBeInTheDocument();
  });
});
