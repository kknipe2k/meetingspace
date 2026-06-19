// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { GenApi } from '@shared/api';
import type { GenTemplate } from '@shared/types';

import { PromptTemplateEditor } from '../../src/components/PromptTemplateEditor';

/*
 * M07.D (REVIEW-V11 F23) — per-template "Revert to factory". The virtual seed is always
 * recoverable (TemplateStore guarantees it), so revert resets the editable drafts to the
 * factory seed text behind a confirm step; the saved fork list is untouched (no save, no
 * delete). RED until the affordance exists.
 */
const SEED: GenTemplate = {
  id: 'default',
  name: 'Default',
  focusPrompt: 'SEED FOCUS',
  whitepaperPrompt: 'SEED WP',
  isDefault: true,
};

const EDITED_FORK: GenTemplate = {
  id: 'tmpl-1',
  name: 'Mine',
  focusPrompt: 'EDITED FOCUS',
  whitepaperPrompt: 'EDITED WP',
  isDefault: false,
};

function harness(): {
  client: GenApi;
  saveTemplate: ReturnType<typeof vi.fn>;
  deleteTemplate: ReturnType<typeof vi.fn>;
} {
  const templates = [SEED, EDITED_FORK];
  const saveTemplate = vi.fn(() => Promise.resolve(EDITED_FORK));
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
    getTemplate: (id) => Promise.resolve(templates.find((t) => t.id === id) ?? null),
    deleteTemplate,
    getArtifacts: () => Promise.resolve([]),
  };
  return { client, saveTemplate, deleteTemplate };
}

describe('PromptTemplateEditor — revert to factory', () => {
  it('resets the editable drafts to the factory seed text (confirm step) without touching the fork list', async () => {
    const { client, saveTemplate, deleteTemplate } = harness();
    render(
      <PromptTemplateEditor
        client={client}
        selectedTemplateId="tmpl-1"
        onSelectTemplate={() => undefined}
      />,
    );

    const focus = (await screen.findByLabelText(/focus prompt/i)) as HTMLTextAreaElement;
    await waitFor(() => expect(focus).toHaveValue('EDITED FOCUS'));

    await userEvent.click(screen.getByRole('button', { name: /revert to factory/i }));
    // Two-step confirm — the revert is destructive to the draft.
    await userEvent.click(screen.getByRole('button', { name: /confirm revert/i }));

    await waitFor(() => expect(focus).toHaveValue('SEED FOCUS'));
    expect((screen.getByLabelText(/white paper prompt/i) as HTMLTextAreaElement).value).toBe(
      'SEED WP',
    );
    // Revert is a local draft reset — it never writes or deletes a saved template.
    expect(saveTemplate).not.toHaveBeenCalled();
    expect(deleteTemplate).not.toHaveBeenCalled();
  });
});
