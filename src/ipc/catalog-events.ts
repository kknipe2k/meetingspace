/*
 * A process-local "the model catalog changed" signal (renderer-side). The catalog is
 * provider-scoped and cached main-side; when the gateway curated allowlist is saved (Settings ▸
 * Gateway models), main's cache is refreshed, but each useModelCatalog instance holds its own copy.
 * This tiny pub/sub lets the save site nudge every picker to re-pull the new list immediately — so
 * the chat + white-paper dropdowns reflect a saved curation without a manual refresh. No IPC, no
 * key: it only triggers a re-fetch of already-public model metadata.
 */
type CatalogSource = symbol;
type CatalogListener = (source?: CatalogSource) => void;

const listeners = new Set<CatalogListener>();

export function subscribeCatalogChanged(listener: CatalogListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyCatalogChanged(source?: CatalogSource): void {
  // Snapshot so a listener that (un)subscribes during dispatch doesn't mutate the set mid-iteration.
  for (const listener of [...listeners]) {
    listener(source);
  }
}
