import { describe, expect, it, vi } from 'vitest';

import { notifyCatalogChanged, subscribeCatalogChanged } from '../../src/ipc/catalog-events';

/*
 * The renderer-side "catalog changed" signal: the gateway-curation save site calls
 * notifyCatalogChanged() so every useModelCatalog instance re-pulls the new list without a manual
 * refresh. Pure pub/sub — proves fan-out to all subscribers and clean unsubscribe.
 */
describe('catalog-events', () => {
  it('notifies every subscriber until it unsubscribes', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeCatalogChanged(a);
    const offB = subscribeCatalogChanged(b);

    notifyCatalogChanged();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    offB();
    notifyCatalogChanged();
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1); // unsubscribed — no further calls

    offA();
  });
});
