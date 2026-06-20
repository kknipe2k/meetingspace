// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { GenApi } from '@shared/api';
import type { GenTemplate } from '@shared/types';

import { PromptTemplateEditor } from '../../src/components/PromptTemplateEditor';

/*
 * The prompt-template editor — protected Default + editable user presets. The shipped
 * Default is read-only; "New from default" creates an editable copy; editing a user
 * template and Save updates it IN PLACE (updateTemplate); Delete removes it. No revert
 * (Default is always there to copy from again).
 */
const SEED: GenTemplate = {
  id: 'default',
  name: 'Default',
  focusPrompt: 'SEED FOCUS',
  whitepaperPrompt: 'SEED WP',
  minutesPrompt: 'SEED MINUTES',
  isDefault: true,
};

const FORK: GenTemplate = {
  id: 'tmpl-1',
  name: 'Mine',
  focusPrompt: 'FORK FOCUS',
  whitepaperPrompt: 'FORK WP',
  minutesPrompt: 'FORK MINUTES',
  isDefault: false,
};

function harness(initial: GenTemplate[] = [SEED]): {
  client: GenApi;
  saveTemplate: ReturnType<typeof vi.fn>;
  updateTemplate: ReturnType<typeof vi.fn>;
  deleteTemplate: ReturnType<typeof vi.fn>;
} {
  let templates = initial;
  const NEW_FORK: GenTemplate = { ...SEED, id: 'tmpl-2', name: 'My template', isDefault: false };
  const saveTemplate = vi.fn(() => {
    templates = [...templates, NEW_FORK];
    return Promise.resolve(NEW_FORK);
  });
  const updateTemplate = vi.fn((id: string) =>
    Promise.resolve(templates.find((t) => t.id === id) ?? FORK),
  );
  const deleteTemplate = vi.fn(() => Promise.resolve());
  const handle = { detach: () => undefined, cancel: () => undefined };
  const client: GenApi = {
    generateFocus: () => handle,
    generateWhitepaper: () => handle,
    generateMinutes: () => handle,
    attach: () => handle,
    status: () => Promise.resolve(null),
    cancel: () => Promise.resolve(),
    onArtifactSaved: () => () => undefined,
    onRunStarted: () => () => undefined,
    onRunEnded: () => () => undefined,
    onProgress: () => () => undefined,
    getLatestArtifacts: () => Promise.resolve([]),
    buildRawDoc: () => Promise.resolve(''),
    exportImages: () => Promise.resolve({ images: [], omittedCount: 0 }),
    exportHtml: () => Promise.resolve({ saved: false }),
    exportMarkdown: () => Promise.resolve({ saved: false }),
    exportPdf: () => Promise.resolve({ saved: false }),
    listTemplates: () => Promise.resolve(templates),
    saveTemplate,
    updateTemplate,
    getTemplate: (id) => Promise.resolve(templates.find((t) => t.id === id) ?? null),
    deleteTemplate,
    getArtifacts: () => Promise.resolve([]),
  };
  return { client, saveTemplate, updateTemplate, deleteTemplate };
}

describe('PromptTemplateEditor', () => {
  it('shows the Default as read-only, offering "New from default" to start editing', async () => {
    const { client } = harness();
    render(
      <PromptTemplateEditor
        client={client}
        selectedTemplateId="default"
        onSelectTemplate={vi.fn()}
      />,
    );

    const focus = (await screen.findByLabelText(/focus prompt/i)) as HTMLTextAreaElement;
    await waitFor(() => expect(focus).toHaveValue('SEED FOCUS'));
    expect(focus.readOnly).toBe(true);
    expect(screen.getByRole('button', { name: /new from default/i })).toBeInTheDocument();
    // No Save/Delete on the immutable default.
    expect(screen.queryByRole('button', { name: /^save$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /delete template/i })).toBeNull();
  });

  it('creates an editable copy of the factory prompts and selects it (New from default)', async () => {
    const { client, saveTemplate } = harness();
    const onSelectTemplate = vi.fn();
    render(
      <PromptTemplateEditor
        client={client}
        selectedTemplateId="default"
        onSelectTemplate={onSelectTemplate}
      />,
    );
    await screen.findByDisplayValue('SEED FOCUS');

    await userEvent.click(screen.getByRole('button', { name: /new from default/i }));

    expect(saveTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        focusPrompt: 'SEED FOCUS',
        whitepaperPrompt: 'SEED WP',
        minutesPrompt: 'SEED MINUTES',
      }),
    );
    await waitFor(() => expect(onSelectTemplate).toHaveBeenCalledWith('tmpl-2'));
  });

  it('edits a user template in place — Save calls updateTemplate with the edits', async () => {
    const { client, updateTemplate } = harness([SEED, FORK]);
    render(
      <PromptTemplateEditor
        client={client}
        selectedTemplateId="tmpl-1"
        onSelectTemplate={vi.fn()}
      />,
    );

    const focus = (await screen.findByLabelText(/focus prompt/i)) as HTMLTextAreaElement;
    await waitFor(() => expect(focus).toHaveValue('FORK FOCUS'));
    // A user template is editable.
    expect(focus.readOnly).toBe(false);

    await userEvent.clear(focus);
    await userEvent.type(focus, 'EDITED FOCUS');
    const minutes = screen.getByLabelText(/minutes prompt/i);
    await userEvent.clear(minutes);
    await userEvent.type(minutes, 'EDITED MINUTES');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(updateTemplate).toHaveBeenCalledWith(
      'tmpl-1',
      expect.objectContaining({ focusPrompt: 'EDITED FOCUS', minutesPrompt: 'EDITED MINUTES' }),
    );
  });

  it('collapses the editor after a successful Save (onClose)', async () => {
    const { client } = harness([SEED, FORK]);
    const onClose = vi.fn();
    render(
      <PromptTemplateEditor
        client={client}
        selectedTemplateId="tmpl-1"
        onSelectTemplate={vi.fn()}
        onClose={onClose}
      />,
    );
    const focus = (await screen.findByLabelText(/focus prompt/i)) as HTMLTextAreaElement;
    await waitFor(() => expect(focus).toHaveValue('FORK FOCUS'));
    await userEvent.type(focus, ' tweak');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('renames a user template via the name field (Save → updateTemplate with the new name)', async () => {
    const { client, updateTemplate } = harness([SEED, FORK]);
    render(
      <PromptTemplateEditor
        client={client}
        selectedTemplateId="tmpl-1"
        onSelectTemplate={vi.fn()}
      />,
    );

    const nameField = (await screen.findByLabelText(/template name/i)) as HTMLInputElement;
    await waitFor(() => expect(nameField).toHaveValue('Mine'));
    await userEvent.clear(nameField);
    await userEvent.type(nameField, 'Renamed');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(updateTemplate).toHaveBeenCalledWith(
      'tmpl-1',
      expect.objectContaining({ name: 'Renamed' }),
    );
  });

  it('deletes a user template', async () => {
    const { client, deleteTemplate } = harness([SEED, FORK]);
    const onSelectTemplate = vi.fn();
    render(
      <PromptTemplateEditor
        client={client}
        selectedTemplateId="tmpl-1"
        onSelectTemplate={onSelectTemplate}
      />,
    );
    await screen.findByDisplayValue('FORK FOCUS');

    await userEvent.click(screen.getByRole('button', { name: /delete template/i }));

    expect(deleteTemplate).toHaveBeenCalledWith('tmpl-1');
    await waitFor(() => expect(onSelectTemplate).toHaveBeenCalledWith('default'));
  });

  it('Close collapses the editor immediately when there are no unsaved edits', async () => {
    const { client } = harness([SEED, FORK]);
    const onClose = vi.fn();
    render(
      <PromptTemplateEditor
        client={client}
        selectedTemplateId="tmpl-1"
        onSelectTemplate={vi.fn()}
        onClose={onClose}
      />,
    );
    await screen.findByDisplayValue('FORK FOCUS');

    await userEvent.click(screen.getByRole('button', { name: /^close$/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog', { name: /unsaved/i })).toBeNull();
  });

  it('Close warns on unsaved edits and "Discard & close" drops them (no save)', async () => {
    const { client, updateTemplate } = harness([SEED, FORK]);
    const onClose = vi.fn();
    render(
      <PromptTemplateEditor
        client={client}
        selectedTemplateId="tmpl-1"
        onSelectTemplate={vi.fn()}
        onClose={onClose}
      />,
    );
    const focus = (await screen.findByLabelText(/focus prompt/i)) as HTMLTextAreaElement;
    await waitFor(() => expect(focus).toHaveValue('FORK FOCUS'));
    await userEvent.type(focus, ' tweak'); // dirty

    await userEvent.click(screen.getByRole('button', { name: /^close$/i }));
    // Held — warning shown, not yet closed.
    expect(screen.getByRole('alertdialog', { name: /unsaved/i })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /discard & close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(updateTemplate).not.toHaveBeenCalled(); // discarded, never persisted
  });

  it('"Save & close" from the unsaved-edits warning persists then closes', async () => {
    const { client, updateTemplate } = harness([SEED, FORK]);
    const onClose = vi.fn();
    render(
      <PromptTemplateEditor
        client={client}
        selectedTemplateId="tmpl-1"
        onSelectTemplate={vi.fn()}
        onClose={onClose}
      />,
    );
    const focus = (await screen.findByLabelText(/focus prompt/i)) as HTMLTextAreaElement;
    await waitFor(() => expect(focus).toHaveValue('FORK FOCUS'));
    await userEvent.clear(focus);
    await userEvent.type(focus, 'SAVED FOCUS'); // dirty

    await userEvent.click(screen.getByRole('button', { name: /^close$/i }));
    await userEvent.click(screen.getByRole('button', { name: /save & close/i }));

    expect(updateTemplate).toHaveBeenCalledWith(
      'tmpl-1',
      expect.objectContaining({ focusPrompt: 'SAVED FOCUS' }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('"Keep editing" dismisses the warning and keeps the draft (no close)', async () => {
    const { client } = harness([SEED, FORK]);
    const onClose = vi.fn();
    render(
      <PromptTemplateEditor
        client={client}
        selectedTemplateId="tmpl-1"
        onSelectTemplate={vi.fn()}
        onClose={onClose}
      />,
    );
    const focus = (await screen.findByLabelText(/focus prompt/i)) as HTMLTextAreaElement;
    await waitFor(() => expect(focus).toHaveValue('FORK FOCUS'));
    await userEvent.type(focus, ' tweak'); // dirty

    await userEvent.click(screen.getByRole('button', { name: /^close$/i }));
    await userEvent.click(screen.getByRole('button', { name: /keep editing/i }));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog', { name: /unsaved/i })).toBeNull();
    expect((screen.getByLabelText(/focus prompt/i) as HTMLTextAreaElement).value).toBe(
      'FORK FOCUS tweak',
    );
  });

  it('reports the active template upward when the selection changes', async () => {
    const { client } = harness([SEED, FORK]);
    const onSelectTemplate = vi.fn();
    render(
      <PromptTemplateEditor
        client={client}
        selectedTemplateId="default"
        onSelectTemplate={onSelectTemplate}
      />,
    );
    await screen.findByRole('option', { name: 'Mine' });

    await userEvent.selectOptions(screen.getByRole('combobox', { name: /template/i }), 'tmpl-1');

    expect(onSelectTemplate).toHaveBeenCalledWith('tmpl-1');
  });
});
