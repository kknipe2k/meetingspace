import { describe, expect, it } from 'vitest';

import { moveItem } from '../../src/components/reorder';

// Pure list-reorder math behind the HTML5 drag-to-reorder interaction. Tested in
// isolation so the component test only has to assert the wiring (drop → client),
// not the index arithmetic.
describe('moveItem', () => {
  // Semantics: the dragged item is inserted immediately *before* the drop target.
  it('moves an item up, before the drop target (drag last onto first)', () => {
    expect(moveItem(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
  });

  it('moves an item down, landing just before the drop target', () => {
    expect(moveItem(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'a', 'c']);
  });

  it('is a no-op when source and target are the same', () => {
    expect(moveItem(['a', 'b', 'c'], 'b', 'b')).toEqual(['a', 'b', 'c']);
  });

  it('returns the original order when an id is not present', () => {
    expect(moveItem(['a', 'b', 'c'], 'x', 'a')).toEqual(['a', 'b', 'c']);
    expect(moveItem(['a', 'b', 'c'], 'a', 'x')).toEqual(['a', 'b', 'c']);
  });
});
