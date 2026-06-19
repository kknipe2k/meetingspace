import { join } from 'node:path';

import { app } from 'electron';

import { devEnv } from '../dev-env';

/*
 * The Electron-only seam: resolves storage locations under the OS `userData`
 * directory. Requires the Electron runtime (`app`), so it is not loadable under
 * the Node test runtime and is excluded from coverage (see vitest.config.ts).
 * The IPC layer (M01.C) composes these with openDatabase() / sessionAssetDir().
 *
 * `MEETINGSPACE_USER_DATA` overrides the base directory when set — used by the
 * persistence e2e to point a launched app at an isolated temp dir so test runs
 * never read or write the developer's real session data. The override is read
 * through the `!app.isPackaged`-gated `devEnv` accessor (CFG-001 / M05.G), so a
 * PACKAGED build always falls back to the real `userData` dir and never honors a
 * planted base path; the e2e runs unpackaged (`app.isPackaged === false`), so its
 * isolation is unchanged.
 */

const DB_FILENAME = 'meetingspace.db';
const ASSETS_DIRNAME = 'assets';
const KEY_FILENAME = 'anthropic-key.enc';
const PREFS_FILENAME = 'settings.json';
const GEN_TEMPLATES_FILENAME = 'gen-templates.json';
const PRICING_FILENAME = 'pricing.json';
const USER_DATA_OVERRIDE = 'MEETINGSPACE_USER_DATA';

function userDataDir(): string {
  return devEnv(USER_DATA_OVERRIDE) ?? app.getPath('userData');
}

export function databaseFilePath(): string {
  return join(userDataDir(), DB_FILENAME);
}

export function assetsRoot(): string {
  return join(userDataDir(), ASSETS_DIRNAME);
}

// The encrypted Anthropic API key blob (M03.A). safeStorage ciphertext only —
// never plaintext. Lives beside the DB under userData.
export function keyFilePath(): string {
  return join(userDataDir(), KEY_FILENAME);
}

// Non-secret app preferences JSON (M03.A) — model selection (Stage D); never holds
// the key.
export function prefsFilePath(): string {
  return join(userDataDir(), PREFS_FILENAME);
}

// Non-secret generation prompt templates JSON (M04.A) — the user's forked
// templates; never SQLite, never holds the key (the default seed is in source).
export function genTemplatesFilePath(): string {
  return join(userDataDir(), GEN_TEMPLATES_FILENAME);
}

// Updatable, config-driven model pricing JSON (M06.D, ADR-0021) — editable without a code change;
// seeded on first run. Non-secret; never holds the key. Read main-side by the usage cost rollup
// and the Settings price display.
export function pricingFilePath(): string {
  return join(userDataDir(), PRICING_FILENAME);
}
