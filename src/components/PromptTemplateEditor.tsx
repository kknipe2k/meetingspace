import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import type { GenTemplate } from '@shared/types';

import { useMutationToast } from '../hooks/useMutationToast';
import { genClient, type GenClient } from '../ipc/client';

/*
 * The prompt-template editor (M04.C) — the "ship default + user fork/save" surface
 * over the M04.A TemplateStore. It lists the saved templates, shows the selected
 * one's two parts (FOCUS + white paper), and lets the user fork the read-only seed
 * into named, editable, versioned copies. The seed default is read-only — you fork
 * it to edit. The active template id is owned by the parent (GeneratedDocView) and
 * fed into the generation request, so the surface reports selection changes upward.
 *
 * Templates are userData JSON (TemplateStore) — never SQLite, never a secret. Only
 * the white-paper two-part prompt is editable here; the minutes prompt ships fixed
 * in v1 (it is not part of the forkable template).
 */
export interface PromptTemplateEditorProps {
  /** Injectable for tests; defaults to the real gen IPC client. */
  client?: GenClient;
  /** The active template id (drives generation), owned by the parent. */
  selectedTemplateId: string;
  onSelectTemplate(id: string): void;
}

export function PromptTemplateEditor({
  client = genClient,
  selectedTemplateId,
  onSelectTemplate,
}: PromptTemplateEditorProps): ReactElement {
  const [templates, setTemplates] = useState<GenTemplate[]>([]);
  const [name, setName] = useState('');
  const [focusDraft, setFocusDraft] = useState('');
  const [whitepaperDraft, setWhitepaperDraft] = useState('');
  // M07.D (F23): two-step confirm for reverting the editable drafts to the factory seed.
  const [revertArmed, setRevertArmed] = useState(false);
  // F18 (M06.B): a pending template switch held back while the editable draft is dirty, so the
  // user is nudged before unsaved changes are discarded.
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);
  const { surface } = useMutationToast();

  const refresh = useCallback(
    () =>
      client.listTemplates().then((list) => {
        setTemplates(list);
        return list;
      }),
    [client],
  );

  useEffect(() => {
    let active = true;
    void client.listTemplates().then((list) => {
      if (active) {
        setTemplates(list);
      }
    });
    return () => {
      active = false;
    };
  }, [client]);

  const selected = useMemo(
    () =>
      templates.find((template) => template.id === selectedTemplateId) ??
      templates.find((template) => template.isDefault) ??
      null,
    [templates, selectedTemplateId],
  );

  // Seed the editable drafts from the selected template (read-only for the seed).
  useEffect(() => {
    if (selected) {
      setFocusDraft(selected.focusPrompt);
      setWhitepaperDraft(selected.whitepaperPrompt);
    }
  }, [selected]);

  const readOnly = selected?.isDefault ?? true;

  // F18: an editable fork with draft edits not yet saved as a version.
  const dirty =
    !readOnly &&
    selected != null &&
    (focusDraft !== selected.focusPrompt || whitepaperDraft !== selected.whitepaperPrompt);

  // Switching templates discards the editable drafts — nudge first when dirty.
  const requestSwitch = (id: string): void => {
    if (dirty && id !== selectedTemplateId) {
      setPendingSwitch(id);
    } else {
      onSelectTemplate(id);
    }
  };

  const save = async (): Promise<void> => {
    const saved = await surface(
      () =>
        client.saveTemplate({
          name: name.trim() || 'Untitled template',
          focusPrompt: focusDraft,
          whitepaperPrompt: whitepaperDraft,
        }),
      "Couldn't save the template.",
    );
    if (!saved) {
      return;
    }
    await refresh();
    setName('');
    onSelectTemplate(saved.id);
  };

  const remove = async (): Promise<void> => {
    if (!selected || selected.isDefault) {
      return;
    }
    const ok = await surface(
      () => client.deleteTemplate(selected.id).then(() => true),
      "Couldn't delete the template.",
    );
    if (!ok) {
      return;
    }
    await refresh();
    onSelectTemplate('default');
  };

  // The virtual factory seed is always present in the list (TemplateStore guarantees it).
  const factory = useMemo(() => templates.find((t) => t.isDefault) ?? null, [templates]);

  // Revert-to-factory (F23): reset the editable drafts to the seed text. It is a LOCAL draft
  // reset — it never writes or deletes a saved fork (the seed is structurally recoverable).
  const revertToFactory = (): void => {
    if (factory) {
      setFocusDraft(factory.focusPrompt);
      setWhitepaperDraft(factory.whitepaperPrompt);
    }
    setRevertArmed(false);
  };

  return (
    <div className="prompt-editor" data-testid="prompt-editor">
      <div className="prompt-editor-row">
        <label className="prompt-editor-label" htmlFor="prompt-template-select">
          Template
        </label>
        <select
          id="prompt-template-select"
          aria-label="Template"
          value={selectedTemplateId}
          onChange={(event) => requestSwitch(event.target.value)}
        >
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </select>
        {!readOnly && (
          <button type="button" className="btn btn-secondary" onClick={() => void remove()}>
            Delete template
          </button>
        )}
        {!readOnly && factory && !revertArmed && (
          <button type="button" className="btn btn-secondary" onClick={() => setRevertArmed(true)}>
            Revert to factory
          </button>
        )}
        {!readOnly && factory && revertArmed && (
          <button type="button" className="btn btn-secondary" onClick={revertToFactory}>
            Confirm revert to factory
          </button>
        )}
      </div>

      {dirty && pendingSwitch === null && (
        <p className="prompt-editor-dirty" role="status">
          Unsaved changes — “Save as new version” to keep them.
        </p>
      )}

      {pendingSwitch !== null && (
        <div
          className="prompt-editor-nudge"
          role="alertdialog"
          aria-label="Discard unsaved changes"
        >
          <span>Discard unsaved changes?</span>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              const id = pendingSwitch;
              setPendingSwitch(null);
              onSelectTemplate(id);
            }}
          >
            Discard
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setPendingSwitch(null)}
          >
            Keep editing
          </button>
        </div>
      )}

      <label className="prompt-editor-label" htmlFor="focus-prompt">
        Focus prompt
      </label>
      <textarea
        id="focus-prompt"
        aria-label="Focus prompt"
        className="prompt-editor-text"
        value={focusDraft}
        readOnly={readOnly}
        onChange={(event) => setFocusDraft(event.target.value)}
        rows={6}
      />

      <label className="prompt-editor-label" htmlFor="whitepaper-prompt">
        White paper prompt
      </label>
      <textarea
        id="whitepaper-prompt"
        aria-label="White paper prompt"
        className="prompt-editor-text"
        value={whitepaperDraft}
        readOnly={readOnly}
        onChange={(event) => setWhitepaperDraft(event.target.value)}
        rows={6}
      />

      <div className="prompt-editor-row">
        <label className="prompt-editor-label" htmlFor="template-name">
          Template name
        </label>
        <input
          id="template-name"
          aria-label="Template name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button type="button" className="btn btn-primary" onClick={() => void save()}>
          Save as new version
        </button>
      </div>
    </div>
  );
}
