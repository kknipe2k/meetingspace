import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

// The pure decision seam of the dual-ABI guard (gotcha §1). The require+rebuild
// wrapper in scripts/ensure-node-abi.cjs is the excluded OS-call layer; the
// classifier that decides "is this a Node/Electron ABI mismatch?" is testable.
const require = createRequire(import.meta.url);
const { isAbiMismatch } = require('../../scripts/abi-guard.cjs') as {
  isAbiMismatch: (error: unknown) => boolean;
};

describe('isAbiMismatch', () => {
  it('is true for a NODE_MODULE_VERSION mismatch error', () => {
    const err = new Error(
      'The module was compiled against a different Node.js version using NODE_MODULE_VERSION 125. ' +
        'This version of Node.js requires NODE_MODULE_VERSION 127.',
    );
    expect(isAbiMismatch(err)).toBe(true);
  });

  it('is true when the message names a different Node.js version', () => {
    const err = new Error('was compiled against a different Node.js version');
    expect(isAbiMismatch(err)).toBe(true);
  });

  it('is false for an unrelated error (do not rebuild on noise)', () => {
    expect(isAbiMismatch(new Error('SQLITE_CANTOPEN: unable to open database file'))).toBe(false);
  });

  it('is false for a non-error value', () => {
    expect(isAbiMismatch(undefined)).toBe(false);
    expect(isAbiMismatch('NODE_MODULE_VERSION')).toBe(false);
  });
});
