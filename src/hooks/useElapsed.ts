import { useEffect, useState } from 'react';

/*
 * The elapsed-time counter behind the D-01 "expectation toast" (replaces the M04.C 12s
 * boolean alarm). While `active` (a stream is in flight) it ticks the elapsed
 * milliseconds at ~1s granularity so the UI can show a calm, persistent reassurance
 * with a LIVE counter ("Generating — this can take 5+ minutes · 1:23"). It resets to 0
 * the moment streaming ends, so a normal-speed response shows nothing meaningful and a
 * re-run starts from zero. This is purely a reassurance — the main process is what
 * actually aborts (anthropic-client's three-tier watchdog) and surfaces a typed TIMEOUT.
 */
const TICK_MS = 1000;

export function useElapsed(active: boolean): number {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!active) {
      setElapsed(0);
      return undefined;
    }
    setElapsed(0);
    const start = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - start), TICK_MS);
    return () => clearInterval(id);
  }, [active]);

  return elapsed;
}

// Format elapsed milliseconds as m:ss (e.g. 83_000 -> "1:23") for the live counter.
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
