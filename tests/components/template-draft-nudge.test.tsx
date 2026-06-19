// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { GenTemplate } from '@shared/types';

import { PromptTemplateEditor } from '../../src/components/PromptTemplateEditor';

/*
 * F18 (M06.B): the template editor loses editable drafts on close/switch without a nudge. With
 * an editable fork dirty, switching away must warn before discarding — the drafts are otherwise
 * silently lost. Pins: a dirty indicator appears only when edited; switching with a dirty draft
 * raises a discard confirm; "Keep editing" cancels the switch (drafts retained), "Discard"
 * proceeds.
 */
const seed: GenTemplate = {
  id: 'default',
  name: 'Default',
  focusPrompt: 'seed focus',
  whitepaperPrompt: 'seed wp',
  isDefault: true,
};
const fork: GenTemplate = {
  id: 'fork1',
  name: 'My fork',
  focusPrompt: 'fork focus',
  whitepaperPrompt: 'fork wp',
  isDefault: false,
};

function client() {
  return {
    listTemplates: () => Promise.resolve([seed, fork]),
    saveTemplate: () => Promise.resolve(fork),
    deleteTemplate: () => Promise.resolve(),
  } as unknown as NonNullable<Parameters<typeof PromptTemplateEditor>[0]['client']>;
}

function renderEditor(onSelect = vi.fn()) {
  render(
    <PromptTemplateEditor
      client={client()}
      selectedTemplateId="fork1"
      onSelectTemplate={onSelect}
    />,
  );
  return onSelect;
}

describe('PromptTemplateEditor unsaved-draft nudge (F18)', () => {
  it('shows no unsaved indicator before any edit', async () => {
    renderEditor();
    await screen.findByDisplayValue('fork focus');
    expect(screen.queryByText(/unsaved/i)).toBeNull();
  });

  it('marks the editor dirty after a draft edit', async () => {
    renderEditor();
    const focus = await screen.findByLabelText('Focus prompt');
    await userEvent.type(focus, ' extra');
    expect(screen.getByText(/unsaved/i)).toBeInTheDocument();
  });

  it('nudges before discarding when switching templates with a dirty draft; Keep editing cancels', async () => {
    const onSelect = renderEditor();
    const focus = await screen.findByLabelText('Focus prompt');
    await userEvent.type(focus, ' extra');

    // Attempt to switch away.
    await userEvent.selectOptions(screen.getByLabelText('Template'), 'default');

    // The switch is intercepted by a discard confirm — not applied yet.
    expect(screen.getByText(/discard unsaved/i)).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /keep editing/i }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('fork focus extra')).toBeInTheDocument();
  });

  it('Discard proceeds with the switch', async () => {
    const onSelect = renderEditor();
    const focus = await screen.findByLabelText('Focus prompt');
    await userEvent.type(focus, ' extra');

    await userEvent.selectOptions(screen.getByLabelText('Template'), 'default');
    await userEvent.click(screen.getByRole('button', { name: /discard/i }));

    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('default'));
  });
});
