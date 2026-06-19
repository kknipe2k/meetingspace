import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/*
 * The M03 "Main-process-only LLM" hard gate (docs/gates.md). The Anthropic SDK is
 * server-side by design and holds the key path; it must never be reachable from
 * the renderer bundle. This static-source scan (mirroring the key-no-leak guard)
 * asserts no renderer-reachable module imports @anthropic-ai/sdk and that
 * `dangerouslyAllowBrowser` (gotcha §3) appears nowhere it could.
 */
const REPO_ROOT = resolve(__dirname, '../..');
const SDK = '@anthropic-ai/sdk';

function tsFilesUnder(relDir: string): string[] {
  const root = join(REPO_ROOT, relDir);
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

// Renderer-reachable surface: the whole renderer tree plus the preload and the
// contextBridge mappings it pulls in. None of these may name the SDK.
const RENDERER_REACHABLE = [
  ...tsFilesUnder('src'),
  join(REPO_ROOT, 'electron/preload.ts'),
  join(REPO_ROOT, 'electron/ipc/llm-bridge.ts'),
  join(REPO_ROOT, 'electron/ipc/settings-bridge.ts'),
  join(REPO_ROOT, 'electron/ipc/session-bridge.ts'),
  join(REPO_ROOT, 'electron/ipc/notes-bridge.ts'),
  join(REPO_ROOT, 'electron/ipc/assets-bridge.ts'),
  join(REPO_ROOT, 'electron/ipc/capture-bridge.ts'),
  join(REPO_ROOT, 'electron/ipc/gen-bridge.ts'),
  join(REPO_ROOT, 'shared/api.ts'),
  join(REPO_ROOT, 'shared/types.ts'),
];

describe('the Anthropic SDK is main-process only', () => {
  it.each(RENDERER_REACHABLE)('%s does not import @anthropic-ai/sdk', (file) => {
    expect(readFileSync(file, 'utf8')).not.toContain(SDK);
  });

  it('no renderer-reachable module enables dangerouslyAllowBrowser', () => {
    for (const file of RENDERER_REACHABLE) {
      expect(readFileSync(file, 'utf8')).not.toContain('dangerouslyAllowBrowser');
    }
  });

  it('the SDK IS imported in the main-only client wrapper (the scan is not vacuous)', () => {
    const source = readFileSync(join(REPO_ROOT, 'electron/llm/anthropic-client.ts'), 'utf8');
    expect(source).toContain(SDK);
  });
});
