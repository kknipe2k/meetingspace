import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { GenTemplate, GenTemplateParts } from '@shared/types';

import { DEFAULT_TEMPLATE, SEED_TEMPLATE_ID } from './prompt-templates';

/*
 * The generation template store (M04.A). The shipped DEFAULT_TEMPLATE is a
 * read-only seed; the user forks it into named, editable copies. Forks live in a
 * JSON file in userData (the same non-secret pattern as PrefsStore) — NEVER
 * SQLite, NEVER holding the key. The path + id generator are injected so the store
 * is fully Node-testable and deterministic; main.ts resolves the real userData
 * path.
 *
 * The seed is virtual: it is always returned (first) but never written to disk,
 * so it can be neither overwritten nor deleted. `get()`-style reads never throw —
 * a missing or corrupt file degrades to "just the seed".
 */
export class TemplateStore {
  constructor(
    private readonly filePath: string,
    private readonly newId: () => string = randomUUID,
  ) {}

  listTemplates(): GenTemplate[] {
    return [DEFAULT_TEMPLATE, ...this.readForks()];
  }

  getTemplate(id: string): GenTemplate | null {
    if (id === SEED_TEMPLATE_ID) {
      return DEFAULT_TEMPLATE;
    }
    return this.readForks().find((template) => template.id === id) ?? null;
  }

  saveTemplate(parts: GenTemplateParts): GenTemplate {
    const fork: GenTemplate = {
      id: this.newId(),
      name: parts.name,
      focusPrompt: parts.focusPrompt,
      whitepaperPrompt: parts.whitepaperPrompt,
      // M07.C pipeline parts — optional; absent fields are omitted (not stored as
      // undefined) so a fork file stays v1-shaped until a part is actually edited.
      ...(parts.planPrompt !== undefined ? { planPrompt: parts.planPrompt } : {}),
      ...(parts.cssPrompt !== undefined ? { cssPrompt: parts.cssPrompt } : {}),
      ...(parts.htmlPrompt !== undefined ? { htmlPrompt: parts.htmlPrompt } : {}),
      isDefault: false,
    };
    this.writeForks([...this.readForks(), fork]);
    return fork;
  }

  deleteTemplate(id: string): void {
    // The seed is immutable — deleting it is a no-op.
    if (id === SEED_TEMPLATE_ID) {
      return;
    }
    this.writeForks(this.readForks().filter((template) => template.id !== id));
  }

  private readForks(): GenTemplate[] {
    if (!existsSync(this.filePath)) {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      return Array.isArray(parsed) ? parsed.filter(isForkTemplate) : [];
    } catch {
      return [];
    }
  }

  private writeForks(forks: GenTemplate[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(forks), 'utf8');
    renameSync(tmp, this.filePath);
  }
}

function isForkTemplate(value: unknown): value is GenTemplate {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const optionalString = (field: unknown): boolean =>
    field === undefined || typeof field === 'string';
  return (
    typeof record.id === 'string' &&
    record.id !== SEED_TEMPLATE_ID &&
    typeof record.name === 'string' &&
    typeof record.focusPrompt === 'string' &&
    typeof record.whitepaperPrompt === 'string' &&
    // M07.C pipeline parts are OPTIONAL (v1 fork files stay valid) but must be
    // strings when present — a corrupt part degrades the fork away, not the run.
    optionalString(record.planPrompt) &&
    optionalString(record.cssPrompt) &&
    optionalString(record.htmlPrompt)
  );
}
