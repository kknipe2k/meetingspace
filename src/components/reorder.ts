/*
 * Pure list-reorder math behind the HTML5 drag-to-reorder interaction. Returns a
 * new array with `fromId` moved to the position immediately before `toId`. If
 * either id is absent or they are equal, the original order is returned
 * unchanged. Kept separate so the component only wires drop → client and the
 * index arithmetic is unit-tested in isolation (tests/unit/reorder.test.ts).
 */
export function moveItem<T>(items: readonly T[], fromId: T, toId: T): T[] {
  if (fromId === toId) {
    return [...items];
  }
  const fromIndex = items.indexOf(fromId);
  const toIndex = items.indexOf(toId);
  if (fromIndex === -1 || toIndex === -1) {
    return [...items];
  }
  const next = [...items];
  next.splice(fromIndex, 1);
  const insertAt = next.indexOf(toId);
  next.splice(insertAt, 0, fromId);
  return next;
}
