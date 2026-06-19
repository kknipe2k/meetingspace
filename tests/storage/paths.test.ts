import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { sessionAssetDir } from '../../electron/storage/paths';

describe('sessionAssetDir', () => {
  it('resolves a per-session directory under the assets root', () => {
    expect(sessionAssetDir('/data/assets', 'sess-42')).toBe(join('/data/assets', 'sess-42'));
  });

  it('keeps distinct sessions in distinct directories', () => {
    expect(sessionAssetDir('/root', 'a')).not.toBe(sessionAssetDir('/root', 'b'));
  });
});
