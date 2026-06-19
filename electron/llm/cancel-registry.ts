/*
 * The requestId-keyed cancel registry (M07.A; REVIEW-V11 F11). The IPC handlers own
 * one instance per streaming domain (chat / generation — SEPARATE instances so a
 * gen:cancel can never abort a chat). When a stream starts, the handler registers its
 * abort thunk under the renderer-generated requestId; the cancel channel looks the id
 * up and fires it; the handler unregisters on settle.
 *
 * This is NOT a second abort path — the thunk simply calls the AbortController the
 * handler threads into streamMessage, which fires the SAME stream.abort() the watchdog
 * already performs (gotcha: reuse the existing abort, triggered externally). Pure
 * in-memory map, no key, no SDK — Node-unit-testable, no OS surface.
 */
export interface CancelRegistry {
  /** Record a stream's abort thunk under its requestId (called when the stream starts). */
  register(requestId: string, abort: () => void): void;
  /** Drop the entry (called on settle — done/error/cancel — so a later cancel is a miss). */
  unregister(requestId: string): void;
  /**
   * Fire the abort for `requestId` and drop it. Returns true if an in-flight stream was
   * found and aborted, false if the id is unknown or already settled (idempotent no-op).
   */
  cancel(requestId: string): boolean;
}

export function createCancelRegistry(): CancelRegistry {
  const aborts = new Map<string, () => void>();
  return {
    register(requestId, abort) {
      aborts.set(requestId, abort);
    },
    unregister(requestId) {
      aborts.delete(requestId);
    },
    cancel(requestId) {
      const abort = aborts.get(requestId);
      if (abort === undefined) {
        return false;
      }
      // Remove BEFORE firing so a re-entrant cancel (or a settle racing the abort) is a
      // clean miss rather than a double fire.
      aborts.delete(requestId);
      abort();
      return true;
    },
  };
}
