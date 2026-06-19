import type { MenuItemConstructorOptions } from 'electron';

/*
 * The right-click context menu (M06.A; REVIEW-V11 F2). The app had no context menu at all — no
 * mouse cut/copy/paste/select-all in note/chat fields, unreachable spellcheck suggestions, no
 * copy-image on screenshots. `buildContextMenuTemplate` is a PURE seam mapping the Electron
 * `context-menu` event's params (editFlags / mediaType / dictionarySuggestions) onto the menu;
 * the `Menu.buildFromTemplate(...).popup()` call is the thin wrapper in electron/main.ts.
 */
export interface ContextMenuEditFlags {
  readonly canCut: boolean;
  readonly canCopy: boolean;
  readonly canPaste: boolean;
  readonly canSelectAll: boolean;
}

export interface ContextMenuParams {
  readonly isEditable: boolean;
  readonly editFlags: ContextMenuEditFlags;
  // 'none' | 'image' | 'audio' | 'video' | 'canvas' | 'file' | 'plugin' (Electron's set).
  readonly mediaType: string;
  readonly dictionarySuggestions: readonly string[];
  readonly selectionText: string;
}

export interface ContextMenuActions {
  replaceMisspelling(word: string): void;
  copyImage(): void;
}

export function buildContextMenuTemplate(
  params: ContextMenuParams,
  actions: ContextMenuActions,
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];

  // Spellcheck suggestions only make sense in an editable field with a misspelled word.
  if (params.isEditable && params.dictionarySuggestions.length > 0) {
    for (const word of params.dictionarySuggestions) {
      items.push({ label: word, click: () => actions.replaceMisspelling(word) });
    }
    items.push({ type: 'separator' });
  }

  if (params.isEditable) {
    items.push(
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
    );
  } else if (params.editFlags.canCopy) {
    // A non-editable selection: copy only (no cut/paste into read-only content).
    items.push({ role: 'copy' });
  }

  if (params.mediaType === 'image') {
    if (items.length > 0) {
      items.push({ type: 'separator' });
    }
    items.push({ label: 'Copy Image', click: () => actions.copyImage() });
  }

  if (params.editFlags.canSelectAll) {
    if (items.length > 0 && items[items.length - 1]?.type !== 'separator') {
      items.push({ type: 'separator' });
    }
    items.push({ role: 'selectAll' });
  }

  return items;
}
