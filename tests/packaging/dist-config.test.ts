import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/*
 * Distribution config shape (M06.E). Guards the SOURCE electron-builder config + the icon
 * artwork (the bundle CONTENTS are guarded separately by verify-package.test.ts). Mutation:
 * dropping the mac dmg target, the probe exclusion, or build/icon.png fails one of these.
 *
 * The macOS DMG + .zip are built on a Mac/CI runner — electron-builder cannot cross-build mac
 * from Windows (ADR-0015). This test only proves the config DECLARES the targets; the actual
 * mac build + .zip boot smoke is an owed carry-forward recorded at closeout (not owner-run).
 */
const ROOT = resolve(__dirname, '../..');
const yml = readFileSync(resolve(ROOT, 'electron-builder.yml'), 'utf8');
const macSection = yml.slice(yml.indexOf('mac:'));

describe('electron-builder.yml', () => {
  it('targets the Windows NSIS installer + portable zip (both no-npm downloads)', () => {
    const winSection = yml.slice(yml.indexOf('win:'), yml.indexOf('mac:'));
    expect(winSection).toMatch(/-\s*nsis/);
    expect(winSection).toMatch(/-\s*zip/);
  });

  it('targets BOTH macOS dmg (M06.E) and the zip portability smoke (ADR-0015)', () => {
    expect(macSection).toMatch(/dmg/);
    expect(macSection).toMatch(/zip/);
  });

  it('builds macOS for BOTH Apple Silicon (arm64) and Intel (x64)', () => {
    expect(macSection).toMatch(/arm64/);
    expect(macSection).toMatch(/x64/);
  });

  it('declares the GitHub publish provider (used by release.yml --publish always)', () => {
    expect(yml).toMatch(/publish:\s*\n\s*provider:\s*github/);
  });

  it('keeps the test-only probe.html excluded from the shipped bundle', () => {
    expect(yml).toMatch(/!out\/renderer\/probe\.html/);
  });
});

describe('custom app icon (M06.E)', () => {
  it('ships a build/icon.png source for cross-platform icon generation', () => {
    // electron-builder converts a single build/icon.png (>=512x512) to win .ico + mac .icns.
    expect(existsSync(resolve(ROOT, 'build/icon.png'))).toBe(true);
  });

  it('ships the raw icon png as an extraResource for the live BrowserWindow (IRL fix)', () => {
    // The packaged window resolves <resources>/build/icon.png (resolveAppIconPath); the binary-only
    // .ico/.icns conversion does NOT brand the runtime window. The png must ship to that path or the
    // window silently falls back to the default Electron icon. Mutation: dropping this fails here.
    const extra = yml.slice(yml.indexOf('extraResources:'), yml.indexOf('files:'));
    expect(extra).toMatch(/from:\s*build\/icon\.png/);
    expect(extra).toMatch(/to:\s*build\/icon\.png/);
  });
});
