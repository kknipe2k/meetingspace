// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { GenApi } from '@shared/api';
import type { GenTemplate, GenTemplateParts } from '@shared/types';

import { PromptTemplateEditor } from '../../src/components/PromptTemplateEditor';

/*
 * The prompt-template editor (M04.C) — the "ship default + user fork/save" surface
 * over the M04.A TemplateStore. It lists the templates, shows the selected one's two
 * parts (FOCUS + white paper), and lets the user fork the read-only seed into named,
 * editable, versioned copies. The seed default is read-only (you fork to edit); a
 * generation uses the selected template (the editor reports the active id upward).
 */
const SEED: GenTemplate = {
  id: 'default',
  name: 'Default',
  focusPrompt: 'SEED FOCUS',
  whitepaperPrompt: 'SEED WP',
  isDefault: true,
};

const FORK: GenTemplate = {
  id: 'tmpl-1',
  name: 'Mine',
  focusPrompt: 'SEED FOCUS',
  whitepaperPrompt: 'SEED WP',
  isDefault: false,
};

function harness(initial: GenTemplate[] = [SEED]): {
  client: GenApi;
  saveTemplate: ReturnType<typeof vi.fn>;
} {
  let templates = initial;
  const saveTemplate = vi.fn((_parts: GenTemplateParts) => {
    templates = [SEED, FORK];
    return Promise.resolve(FORK);
  });
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
    getTemplate: (id) => Promise.resolve(templates.find((t) => t.id === id) ?? null),
    deleteTemplate: () => Promise.resolve(),
    getArtifacts: () => Promise.resolve([]),
  };
  return { client, saveTemplate };
}

describe('PromptTemplateEditor', () => {
  it('shows the seed default as read-only (fork to edit)', async () => {
    const { client } = harness();
    render(
      <PromptTemplateEditor
        client={client}
        selectedTemplateId="default"
        onSelectTemplate={() => undefined}
      />,
    );

    const focus = (await screen.findByLabelText(/focus prompt/i)) as HTMLTextAreaElement;
    // Drafts seed once the template list resolves.
    await waitFor(() => expect(focus).toHaveValue('SEED FOCUS'));
    expect(focus.readOnly).toBe(true);
  });

  it('forks the seed into a named, saved template and selects it', async () => {
    const { client, saveTemplate } = harness();
    const onSelectTemplate = vi.fn();
    render(
      <PromptTemplateEditor
        client={client}
        selectedTemplateId="default"
        onSelectTemplate={onSelectTemplate}
      />,
    );
    // Wait for the drafts to seed from the selected template before forking.
    await screen.findByDisplayValue('SEED FOCUS');

    await userEvent.type(screen.getByLabelText(/template name/i), 'Mine');
    await userEvent.click(screen.getByRole('button', { name: /save as new version/i }));

    expect(saveTemplate).toHaveBeenCalledWith({
      name: 'Mine',
      focusPrompt: 'SEED FOCUS',
      whitepaperPrompt: 'SEED WP',
    });
    await waitFor(() => expect(onSelectTemplate).toHaveBeenCalledWith('tmpl-1'));
    // The freshly saved fork appears in the list.
    await screen.findByRole('option', { name: 'Mine' });
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
