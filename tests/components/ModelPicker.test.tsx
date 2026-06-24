// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CHAT_MODELS, DEFAULT_GENERATION_MODEL } from '@shared/models';
import type { CatalogModel } from '@shared/types';
import type { CatalogClient } from '../../src/ipc/client';

import { ModelPicker } from '../../src/components/ModelPicker';

/*
 * The generation model picker (M04.C). It offers all three tiers from the
 * shared/models catalog (Haiku / Sonnet / Opus), defaults to Sonnet 4.6
 * (DEFAULT_GENERATION_MODEL, per ADR-0012), and reports the chosen id to its owner
 * (LLMPanel persists it as a non-secret pref). It is a controlled select.
 */
describe('ModelPicker', () => {
  it('offers every catalog tier', () => {
    render(<ModelPicker model={DEFAULT_GENERATION_MODEL} onChange={() => undefined} />);
    const select = screen.getByRole('combobox', { name: /generation model/i });
    const values = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(new Set(values)).toEqual(new Set(CHAT_MODELS.map((m) => m.id)));
  });

  it('reflects the selected model (default Sonnet 4.6)', () => {
    render(<ModelPicker model={DEFAULT_GENERATION_MODEL} onChange={() => undefined} />);
    expect(screen.getByRole('combobox', { name: /generation model/i })).toHaveValue(
      'claude-sonnet-4-6',
    );
  });

  it('reports the chosen model on change', async () => {
    const onChange = vi.fn();
    render(<ModelPicker model={DEFAULT_GENERATION_MODEL} onChange={onChange} />);

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: /generation model/i }),
      'claude-opus-4-8',
    );

    expect(onChange).toHaveBeenCalledWith('claude-opus-4-8');
  });

  it('snaps an out-of-catalog selection to a valid model (stale-pref guard)', async () => {
    const onChange = vi.fn();
    // A raw gateway id saved by an older build is no longer in the catalog → reconcile to the default.
    render(<ModelPicker model="us.anthropic.claude-3-5-sonnet-stale" onChange={onChange} />);

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(DEFAULT_GENERATION_MODEL));
  });

  it('does not overwrite a saved gateway model while the live catalog is still loading', async () => {
    const custom: CatalogModel = {
      id: 'corp-custom-model',
      label: 'Corp Custom Model',
      maxOutputTokens: 32000,
    };
    let resolveList: (models: CatalogModel[]) => void = () => undefined;
    const catalogClient: CatalogClient = {
      list: vi.fn(
        () =>
          new Promise<CatalogModel[]>((resolve) => {
            resolveList = resolve;
          }),
      ),
      refresh: vi.fn(async () => [custom]),
    };
    const onChange = vi.fn();
    render(<ModelPicker model={custom.id} onChange={onChange} catalogClient={catalogClient} />);

    expect(onChange).not.toHaveBeenCalled();
    await act(async () => resolveList([custom]));

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /generation model/i })).toHaveValue(custom.id),
    );
    expect(onChange).not.toHaveBeenCalled();
  });
});
