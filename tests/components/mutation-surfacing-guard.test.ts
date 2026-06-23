import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/*
 * F13 COMPLETENESS GUARD (M06.B, owner-required). The "no silent mutation failure" 🔴 stays
 * closed only if EVERY renderer mutation call is classified: surfaced (rejection routed to a
 * toast/ErrorState), exempt (with a reason), or preexisting (already has its own error path).
 * This is mechanical, not a hand-list — it scans src/ for client mutation calls and fails if the
 * discovered multiset differs from the REGISTRY below. A NEW unhandled mutation (added in a later
 * stage) changes the multiset → this fails → forcing the author to classify it AND write a
 * per-site behavior test (see error-surfacing.test.tsx). Mirrors the literal-absence class
 * guards in tests/security/.
 *
 * `updateSync` is deliberately NOT a tracked method: it is the pagehide teardown flush — the
 * renderer is unmounting, there is no UI left to toast (the only structural exemption).
 */
const SRC_ROOT = resolve(__dirname, '../../src');
// The IPC definition layer DEFINES these methods (pass-throughs); it is not a call site.
const EXCLUDE = new Set(['ipc/client.ts']);

const RECEIVERS = '(client|gen|settings|noteClient|notes|storage)';
// Longest-first so `deleteMany`/`addWithContent`/`saveTemplate`/`deleteTemplate` win over their
// prefixes; each must be followed by `(` so `updateSync(` never matches `update`. M06.C adds the
// export-PDF + backup/restore mutation sites.
const METHODS =
  '(deleteMany|addWithContent|saveTemplate|deleteTemplate|updateTemplate|exportHtml|exportMarkdown|exportImages|exportPdf|setProvider|setPrefs|setKey|clearKey|reorder|restore|backup|create|rename|delete|update|add|save)';
// Allow whitespace/newlines around the dot so a fluent chain (`client\n  .update(...)`) can't
// hide a mutation from the guard.
function mutationRegex(): RegExp {
  return new RegExp(`\\b${RECEIVERS}\\s*\\.\\s*${METHODS}\\s*\\(`, 'g');
}

/*
 * The classified registry. Every entry is one discovered call site occurrence
 * (`<relpath> <receiver>.<method>`); duplicates are listed once per occurrence.
 * Disposition for each is in the trailing comment:
 *   S  = surfaced this stage (rejection → error toast; has a behavior test)
 *   SD = surfaced via deferred-delete (optimistic; commit failure restores + toast)
 *   P  = preexisting error path (kept)
 */
const REGISTRY: readonly string[] = [
  // App — session ops (F15) + bulk delete
  'App.tsx client.create', // S
  'App.tsx client.rename', // S
  'App.tsx client.delete', // SD (single-session deferred delete)
  'App.tsx client.deleteMany', // SD (bulk deferred delete) — NEW this stage
  'App.tsx settings.setPrefs', // S — persist the resizable sidebar width (IRL request)
  // NoteBlocks — note add/upload/delete/reorder (F13)
  'components/NoteBlocks.tsx client.add', // S
  'components/NoteBlocks.tsx client.addWithContent', // S (over-cap upload repro)
  'components/NoteBlocks.tsx client.delete', // SD
  'components/NoteBlocks.tsx client.reorder', // S — the drop-applied reorder (failure restores)
  'components/NoteBlocks.tsx client.reorder', // S — the F10 reorder-undo revert (surfaced)
  // NoteBlock — autosave (F13; once-only)
  'components/NoteBlock.tsx client.update', // S
  // Screenshots — save/delete (F13)
  'components/Screenshots.tsx client.save', // S (over-cap image)
  'components/Screenshots.tsx client.delete', // S (optimistic; restore on failure)
  // ChatPanel — save reply as note (F13)
  'components/ChatPanel.tsx noteClient.addWithContent', // S
  // Onboarding — first-run key setup + sample-space seed (M06.E; all surfaced)
  'components/Onboarding.tsx settings.setKey', // S — first-run key save (keeps modal on failure)
  'components/Onboarding.tsx settings.setPrefs', // S — persist the onboardingSeen flag
  'components/Onboarding.tsx client.create', // S — seed the sample space
  'components/Onboarding.tsx notes.addWithContent', // S — seed the welcome note
  // GeneratedDocView — export quartet (F15; M06.C adds PDF)
  'components/GeneratedDocView.tsx gen.exportMarkdown', // S
  'components/GeneratedDocView.tsx gen.exportImages', // S
  'components/GeneratedDocView.tsx gen.exportHtml', // S
  'components/GeneratedDocView.tsx gen.exportPdf', // S (M06.C)
  // PromptTemplateEditor — preset create (New from default) / update-in-place / delete
  'components/PromptTemplateEditor.tsx client.saveTemplate', // S (New from default)
  'components/PromptTemplateEditor.tsx client.updateTemplate', // S (Save edits in place)
  'components/PromptTemplateEditor.tsx client.deleteTemplate', // S
  // SettingsModal — key/provider mutations
  'components/SettingsModal.tsx client.setProvider', // S (handleProviderChange → anthropic)
  'components/SettingsModal.tsx client.setProvider', // P (handleSave gateway → providerError)
  'components/SettingsModal.tsx client.setKey', // S
  'components/SettingsModal.tsx client.clearKey', // S
  'components/SettingsModal.tsx client.setPrefs', // S — gateway curated model allowlist (surface())
  // SettingsModal — full backup/restore (M06.C, surfaced via surface())
  'components/SettingsModal.tsx storage.backup', // S (M06.C)
  'components/SettingsModal.tsx storage.restore', // S (M06.C)
  // Preference writes (F18 "by design" → surfaced this stage to keep the exemption set minimal)
  'components/LLMPanel.tsx settings.setPrefs', // S — chat model
  'components/LLMPanel.tsx settings.setPrefs', // S — generation model
  'components/LLMPanel.tsx settings.setPrefs', // S — F8 chat scroll offset (M06.D); debounced, surfaced
  'hooks/useTheme.ts settings.setPrefs', // S
];

function tsSourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...tsSourcesUnder(full));
    } else if (
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.includes('.test.') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

function relKey(absPath: string): string {
  return relative(SRC_ROOT, absPath).split(sep).join('/');
}

// Strip line comments so a `// client.delete(id)` note is not counted as a call site.
function stripLineComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');
}

function discoverMutations(): string[] {
  const found: string[] = [];
  for (const file of tsSourcesUnder(SRC_ROOT)) {
    const rel = relKey(file);
    if (EXCLUDE.has(rel)) {
      continue;
    }
    const text = stripLineComments(readFileSync(file, 'utf8'));
    for (const match of text.matchAll(mutationRegex())) {
      found.push(`${rel} ${match[1]}.${match[2]}`);
    }
  }
  return found;
}

describe('F13 completeness guard — every renderer mutation call is classified', () => {
  it('the discovered mutation call multiset equals the classified registry', () => {
    expect(discoverMutations().sort()).toEqual([...REGISTRY].sort());
  });

  it('the matcher actually detects a mutation call (anti-vacuous self-check)', () => {
    const re = mutationRegex();
    expect(re.test('void client.delete(id)')).toBe(true);
    re.lastIndex = 0;
    expect(re.test('client.deleteMany(ids)')).toBe(true);
    re.lastIndex = 0;
    // updateSync is the teardown-flush exemption — must NOT be matched as `update`.
    expect(/\bclient\.update\(/.test('client.updateSync(id, v)')).toBe(false);
  });

  it('the registry is non-empty (a vacuous registry would defeat the guard)', () => {
    expect(REGISTRY.length).toBeGreaterThan(10);
  });
});
