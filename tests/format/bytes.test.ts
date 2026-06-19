import { describe, expect, it } from 'vitest';

import { formatBytes } from '../../src/format/bytes';

describe('formatBytes', () => {
  it('formats bytes, KB, MB, GB with one decimal above bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1_572_864)).toBe('1.5 MB');
    expect(formatBytes(1_073_741_824)).toBe('1.0 GB');
  });
});
