// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CHAT_MODELS, DEFAULT_GENERATION_MODEL } from '@shared/models';

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
});
