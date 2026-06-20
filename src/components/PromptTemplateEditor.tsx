import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';

import type { GenTemplate } from '@shared/types';

import { useMutationToast } from '../hooks/useMutationToast';
import { genClient, type GenClient } from '../ipc/client';

/*
 * The prompt-template editor — the standard "protected default + user presets" surface
 * over the TemplateStore. The shipped **Default** is read-only (the immutable reference);
 * the user creates editable copies with "New from default", then edits the prompts
 * (FOCUS + white paper + minutes), renames, and saves IN PLACE (updateTemplate) or
 * deletes them. Toggling the dropdown switches the active template (driving generation),
 * which is owned by the parent (GeneratedDocView) and reported upward.
 *
 * Templates are userData JSON (TemplateStore) — never SQLite, never a secret. The Default
 * is never mutated, so there is no "revert" — Default is always there to copy from again.
 */
export interface PromptTemplateEditorProps {
  /** Injectable for tests; defaults to the real gen IPC client. */
  client?: GenClient;
  /** The active template id (drives generation), owned by the parent. */
  selectedTemplateId: string;
  onSelectTemplate(id: string): void;
  /** Collapse the editor (called after a successful Save) so the saved prompt is in
   *  effect before the user generates. */
  onClose?(): void;
}

/** Imperative surface so the parent's close paths (Generate / Regenerate / Start over)
 *  funnel through the SAME unsaved-edits guard the editor's own Close button uses. */
export interface PromptTemplateEditorHandle {
  /** Try to close the editor. With unsaved edits it opens the Save / Discard / Keep-editing
   *  confirm and DEFERS — `onProceed` runs only once the editor actually closes (after Save
   *  or Discard), never on "Keep editing". With no unsaved edits it closes and proceeds at
   *  once. */
  attemptClose(onProceed?: () => void): void;
}

export const PromptTemplateEditor = forwardRef<
  PromptTemplateEditorHandle,
  PromptTemplateEditorProps
>(function PromptTemplateEditor(
  { client = genClient, selectedTemplateId, onSelectTemplate, onClose },
  ref,
): ReactElement {
  const [templates, setTemplates] = useState<GenTemplate[]>([]);
  const [name, setName] = useState('');
  const [focusDraft, setFocusDraft] = useState('');
  const [whitepaperDraft, setWhitepaperDraft] = useState('');
  const [minutesDraft, setMinutesDraft] = useState('');
  // A pending template switch held back while the editable draft is dirty, so the user
  // is nudged before unsaved changes are discarded.
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);
  // A pending CLOSE held back while the draft is dirty (Close button or a parent-driven
  // Generate/Regenerate/Start over). `onProceed` is the deferred action to run once the
  // editor actually closes.
  const [pendingClose, setPendingClose] = useState<{ onProceed: (() => void) | null } | null>(null);
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

  // The factory seed is always present in the list (TemplateStore guarantees it).
  const factory = useMemo(() => templates.find((t) => t.isDefault) ?? null, [templates]);

  const isSeed = selected?.isDefault ?? true;

  // Older forks predate the minutes prompt — fall back to the factory's so the editor
  // shows the real default to edit, never an empty box.
  const minutesBaseline = selected?.minutesPrompt ?? factory?.minutesPrompt ?? '';

  // Seed the editable drafts + name from the selected template.
  useEffect(() => {
    if (selected) {
      setName(selected.isDefault ? '' : selected.name);
      setFocusDraft(selected.focusPrompt);
      setWhitepaperDraft(selected.whitepaperPrompt);
      setMinutesDraft(selected.minutesPrompt ?? factory?.minutesPrompt ?? '');
    }
  }, [selected, factory]);

  // Unsaved edits on an editable (non-default) template — the Default is never dirty.
  const dirty =
    !isSeed &&
    selected != null &&
    (name !== selected.name ||
      focusDraft !== selected.focusPrompt ||
      whitepaperDraft !== selected.whitepaperPrompt ||
      minutesDraft !== minutesBaseline);

  // Switching templates discards the editable drafts — nudge first when dirty.
  const requestSwitch = (id: string): void => {
    if (dirty && id !== selectedTemplateId) {
      setPendingSwitch(id);
    } else {
      onSelectTemplate(id);
    }
  };

  // New from default: create an editable copy of the factory's prompts and select it.
  // (Pipeline parts plan/css/html aren't edited here, so they're left to default at run
  // time — same as a fork that never touches them.)
  const newFromDefault = async (): Promise<void> => {
    if (!factory) {
      return;
    }
    const created = await surface(
      () =>
        client.saveTemplate({
          name: 'My template',
          focusPrompt: factory.focusPrompt,
          whitepaperPrompt: factory.whitepaperPrompt,
          ...(factory.minutesPrompt !== undefined ? { minutesPrompt: factory.minutesPrompt } : {}),
        }),
      "Couldn't create the template.",
    );
    if (!created) {
      return;
    }
    await refresh();
    onSelectTemplate(created.id);
  };

  // Save: persist the edits to the selected user template IN PLACE (no copy-spam).
  // Returns whether the save succeeded so callers can gate close/proceed on it (a failed
  // save keeps the editor open with the draft intact — the toast already explained why).
  const save = async (): Promise<boolean> => {
    if (!selected || selected.isDefault) {
      return false;
    }
    const updated = await surface(
      () =>
        client.updateTemplate(selected.id, {
          name: name.trim() || selected.name,
          focusPrompt: focusDraft,
          whitepaperPrompt: whitepaperDraft,
          minutesPrompt: minutesDraft,
        }),
      "Couldn't save the template.",
    );
    if (!updated) {
      return false;
    }
    await refresh();
    return true;
  };

  // The bottom Save button: persist, then collapse the editor so the just-saved prompt is
  // what the next Generate uses (the M07 "Save closes the editor" behavior).
  const saveClose = async (): Promise<void> => {
    if (await save()) {
      onClose?.();
    }
  };

  // The one guarded-close path. Clean → close (and run the deferred action) immediately;
  // dirty → defer behind the Save / Discard / Keep-editing confirm. Held on a ref so the
  // imperative handle always calls the latest closure (current `dirty`/`onClose`).
  const guardedClose = (onProceed?: () => void): void => {
    if (dirty) {
      setPendingClose({ onProceed: onProceed ?? null });
    } else {
      onClose?.();
      onProceed?.();
    }
  };
  const guardedCloseRef = useRef(guardedClose);
  guardedCloseRef.current = guardedClose;
  useImperativeHandle(
    ref,
    () => ({ attemptClose: (onProceed?: () => void) => guardedCloseRef.current(onProceed) }),
    [],
  );

  // Resolve a deferred close: Save & close persists first (and aborts on save failure);
  // Discard & close drops the draft. Both then close and run the deferred action.
  const confirmSaveClose = async (): Promise<void> => {
    if (!(await save())) {
      return;
    }
    const proceed = pendingClose?.onProceed;
    setPendingClose(null);
    onClose?.();
    proceed?.();
  };
  const confirmDiscardClose = (): void => {
    const proceed = pendingClose?.onProceed;
    setPendingClose(null);
    onClose?.();
    proceed?.();
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
              {template.isDefault ? `${template.name} (read-only)` : template.name}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-secondary" onClick={() => void newFromDefault()}>
          New from default
        </button>
        {!isSeed && selected && (
          <button type="button" className="btn btn-secondary" onClick={() => void remove()}>
            Delete template
          </button>
        )}
        <button type="button" className="btn btn-secondary" onClick={() => guardedClose()}>
          Close
        </button>
      </div>

      {isSeed && (
        <p className="prompt-editor-hint" role="status">
          The default is read-only. Use “New from default” to create an editable copy.
        </p>
      )}

      {dirty && pendingSwitch === null && (
        <p className="prompt-editor-dirty" role="status">
          Unsaved changes — “Save” to keep them.
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

      {pendingClose !== null && (
        <div className="prompt-editor-nudge" role="alertdialog" aria-label="Unsaved prompt changes">
          <span>Unsaved prompt changes.</span>
          <button type="button" className="btn btn-primary" onClick={() => void confirmSaveClose()}>
            Save &amp; close
          </button>
          <button type="button" className="btn btn-danger" onClick={confirmDiscardClose}>
            Discard &amp; close
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setPendingClose(null)}>
            Keep editing
          </button>
        </div>
      )}

      {!isSeed && (
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
        readOnly={isSeed}
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
        readOnly={isSeed}
        onChange={(event) => setWhitepaperDraft(event.target.value)}
        rows={6}
      />

      <label className="prompt-editor-label" htmlFor="minutes-prompt">
        Minutes prompt
      </label>
      <textarea
        id="minutes-prompt"
        aria-label="Minutes prompt"
        className="prompt-editor-text"
        value={minutesDraft}
        readOnly={isSeed}
        onChange={(event) => setMinutesDraft(event.target.value)}
        rows={6}
      />

      {!isSeed && (
        <div className="prompt-editor-row">
          <button type="button" className="btn btn-primary" onClick={() => void saveClose()}>
            Save
          </button>
        </div>
      )}
    </div>
  );
});
