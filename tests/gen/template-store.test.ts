import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SEED_TEMPLATE_ID } from '../../electron/gen/prompt-templates';
import { TemplateStore } from '../../electron/gen/template-store';

/*
 * The generation template store (M04.A): the shipped default is a read-only seed;
 * the user forks it into named, editable copies. Stored as a JSON file in userData
 * (mirrors PrefsStore) — NEVER SQLite, NEVER the key. The path + id generator are
 * injected so the store is fully Node-testable and deterministic.
 */
let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-gentmpl-'));
  filePath = join(dir, 'gen-templates.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const PARTS = {
  name: 'My White Paper',
  focusPrompt: 'custom focus',
  whitepaperPrompt: 'custom whitepaper',
};

describe('TemplateStore', () => {
  it('always lists the immutable default seed first, even with no file', () => {
    const list = new TemplateStore(filePath).listTemplates();
    expect(list[0]?.id).toBe(SEED_TEMPLATE_ID);
    expect(list[0]?.isDefault).toBe(true);
  });

  it('returns the default seed by id', () => {
    const seed = new TemplateStore(filePath).getTemplate(SEED_TEMPLATE_ID);
    expect(seed?.isDefault).toBe(true);
    expect(typeof seed?.focusPrompt).toBe('string');
  });

  it('forks the default into a named, editable copy with a generated id', () => {
    const store = new TemplateStore(filePath, () => 'tmpl-1');

    const fork = store.saveTemplate(PARTS);

    expect(fork).toMatchObject({ id: 'tmpl-1', name: PARTS.name, isDefault: false });
    expect(store.getTemplate('tmpl-1')).toEqual(fork);
  });

  it('persists forks across a fresh instance (reopen)', () => {
    new TemplateStore(filePath, () => 'tmpl-1').saveTemplate(PARTS);

    const reopened = new TemplateStore(filePath).getTemplate('tmpl-1');
    expect(reopened).toMatchObject({ id: 'tmpl-1', focusPrompt: 'custom focus' });
  });

  it('never writes the default seed into the persisted file (forks only)', () => {
    new TemplateStore(filePath, () => 'tmpl-1').saveTemplate(PARTS);

    const onDisk = readFileSync(filePath, 'utf8');
    expect(onDisk).not.toContain(SEED_TEMPLATE_ID);
    expect(onDisk).toContain('tmpl-1');
  });

  it('updates an existing fork in place (same id, new name + prompts)', () => {
    const store = new TemplateStore(filePath, () => 'tmpl-1');
    store.saveTemplate(PARTS);

    const updated = store.updateTemplate('tmpl-1', {
      name: 'Renamed Paper',
      focusPrompt: 'edited focus',
      whitepaperPrompt: 'edited whitepaper',
    });

    expect(updated).toMatchObject({
      id: 'tmpl-1',
      name: 'Renamed Paper',
      focusPrompt: 'edited focus',
      whitepaperPrompt: 'edited whitepaper',
      isDefault: false,
    });
    expect(store.getTemplate('tmpl-1')).toEqual(updated);
  });

  it('refuses to update the immutable default seed', () => {
    const store = new TemplateStore(filePath, () => 'tmpl-1');

    expect(() => store.updateTemplate(SEED_TEMPLATE_ID, PARTS)).toThrow(
      'Unknown template: ' + SEED_TEMPLATE_ID,
    );
    expect(store.getTemplate(SEED_TEMPLATE_ID)?.isDefault).toBe(true);
  });

  it('throws when updating a non-existent fork id', () => {
    const store = new TemplateStore(filePath, () => 'tmpl-1');

    expect(() => store.updateTemplate('nope', PARTS)).toThrow('Unknown template: nope');
  });

  it('deletes a fork but leaves the immutable default seed intact', () => {
    const store = new TemplateStore(filePath, () => 'tmpl-1');
    store.saveTemplate(PARTS);

    store.deleteTemplate('tmpl-1');
    expect(store.getTemplate('tmpl-1')).toBeNull();

    store.deleteTemplate(SEED_TEMPLATE_ID); // no-op — the seed is immutable
    expect(store.getTemplate(SEED_TEMPLATE_ID)?.isDefault).toBe(true);
  });

  it('tolerates a corrupt file by degrading to the default seed only (never throws on read)', () => {
    writeFileSync(filePath, '{ not json');

    const list = new TemplateStore(filePath).listTemplates();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(SEED_TEMPLATE_ID);
  });
});
