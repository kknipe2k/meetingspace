import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../electron/storage/db';
import { DEFAULT_SPACE_ID } from '../../electron/storage/schema';
import { UsageStore } from '../../electron/storage/usage-store';
import { SessionStore } from '../../electron/storage/sessions';
import type { ModelPrice } from '../../electron/llm/pricing-config';

/*
 * UsageStore (ADR-0021/0022/0024, passive counter). Records every call's REAL usage tagged with
 * session_id + timestamp, and rolls up two TODAY-WINDOWED rows (ADR-0024, local-midnight → now):
 * `sessionToday` (the CURRENT session, today only) and `allToday` (ALL sessions, today only) — each
 * across EVERY kind (chat + generation). The all-time total was dropped. Cost is the CONSERVATIVE
 * SPLIT: real token totals always; costUsd sums only the priced calls (input + output + cache at the
 * read/write multipliers); unpricedCalls counts calls whose model has no config price.
 */
let dir: string;
let db: ReturnType<typeof openDatabase>;

const PRICES: Record<string, ModelPrice> = {
  m3: { inputPerMTok: 3, outputPerMTok: 15 },
};
const priceFor = (model: string): ModelPrice | null => PRICES[model] ?? null;

const NOON = Date.UTC(2026, 5, 15, 18, 0, 0); // a fixed "now" well inside a local day
const TWO_DAYS_AGO = NOON - 48 * 3600 * 1000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meetingspace-usage-'));
  db = openDatabase(join(dir, 'store.db'));
  for (const id of ['s1', 's2']) {
    db.prepare(
      'INSERT INTO sessions (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, DEFAULT_SPACE_ID, id, 1, 1);
  }
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function storeAt(now: number): UsageStore {
  return new UsageStore(db, { now: () => now, priceFor });
}

describe('UsageStore', () => {
  it('sessionToday = the CURRENT session today only — excludes other sessions AND prior-day rows', () => {
    const store = storeAt(NOON);
    // s1 today (counts), s2 today (other session — excluded from s1's row), s1 two days ago (prior
    // day — excluded from BOTH today windows).
    store.record({
      sessionId: 's1',
      kind: 'chat',
      model: 'm3',
      usage: { inputTokens: 100, outputTokens: 0 },
    });
    store.record({
      sessionId: 's2',
      kind: 'chat',
      model: 'm3',
      usage: { inputTokens: 900, outputTokens: 0 },
    });
    new UsageStore(db, { now: () => TWO_DAYS_AGO, priceFor }).record({
      sessionId: 's1',
      kind: 'chat',
      model: 'm3',
      usage: { inputTokens: 5000, outputTokens: 0 },
    });

    const summary = store.summary('s1');
    // Only the NOON s1 row — not s2 (other session), not the prior-day s1 row.
    expect(summary.sessionToday.inputTokens).toBe(100);
  });

  it('allToday = ALL sessions today only — excludes prior-day rows', () => {
    const store = storeAt(NOON);
    store.record({
      sessionId: 's1',
      kind: 'chat',
      model: 'm3',
      usage: { inputTokens: 100, outputTokens: 0 },
    });
    store.record({
      sessionId: 's2',
      kind: 'chat',
      model: 'm3',
      usage: { inputTokens: 900, outputTokens: 0 },
    });
    new UsageStore(db, { now: () => TWO_DAYS_AGO, priceFor }).record({
      sessionId: 's2',
      kind: 'minutes',
      model: 'm3',
      usage: { inputTokens: 5000, outputTokens: 0 },
    });

    const summary = store.summary('s1');
    // s1 + s2 today (1000), prior-day row excluded.
    expect(summary.allToday.inputTokens).toBe(1000);
  });

  it('a prior-day row appears in NEITHER window', () => {
    const store = storeAt(NOON);
    // ONLY a prior-day row exists.
    new UsageStore(db, { now: () => TWO_DAYS_AGO, priceFor }).record({
      sessionId: 's1',
      kind: 'chat',
      model: 'm3',
      usage: { inputTokens: 4242, outputTokens: 0 },
    });

    const summary = store.summary('s1');
    expect(summary.sessionToday.inputTokens).toBe(0);
    expect(summary.allToday.inputTokens).toBe(0);
  });

  it('a GENERATION-kind row counts in BOTH windows (today, current session)', () => {
    const store = storeAt(NOON);
    store.record({
      sessionId: 's1',
      kind: 'whitepaper',
      model: 'm3',
      usage: { inputTokens: 2_000_000, outputTokens: 0 },
    });
    const summary = store.summary('s1');
    expect(summary.sessionToday.inputTokens).toBe(2_000_000);
    expect(summary.allToday.inputTokens).toBe(2_000_000);
    // Cost = 2M/1e6 * $3 = $6, on both rows.
    expect(summary.sessionToday.costUsd).toBeCloseTo(6, 6);
    expect(summary.allToday.costUsd).toBeCloseTo(6, 6);
  });

  it('prices cache tokens at the read/write multipliers (both rows)', () => {
    const store = storeAt(NOON);
    store.record({
      sessionId: 's1',
      kind: 'chat',
      model: 'm3',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
      },
    });
    // cache_read = 1M * $3 * 0.10 = $0.30 ; cache_write = 1M * $3 * 1.25 = $3.75 → $4.05
    const summary = store.summary('s1');
    expect(summary.sessionToday.costUsd).toBeCloseTo(4.05, 6);
    expect(summary.allToday.costUsd).toBeCloseTo(4.05, 6);
  });

  it('conservative split: an unpriced model contributes tokens but not cost', () => {
    const store = storeAt(NOON);
    // A priced call in s1 (current session) + an unpriced call in s2 (other session), both today.
    store.record({
      sessionId: 's1',
      kind: 'chat',
      model: 'm3',
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
    });
    store.record({
      sessionId: 's2',
      kind: 'whitepaper',
      model: 'gateway-unknown',
      usage: { inputTokens: 2_000_000, outputTokens: 0 },
    });
    const summary = store.summary('s1');

    // allToday: real tokens from both; cost only the priced 1M*$3; the gateway call is unpriced.
    expect(summary.allToday.inputTokens).toBe(3_000_000);
    expect(summary.allToday.costUsd).toBeCloseTo(3, 6);
    expect(summary.allToday.unpricedCalls).toBe(1);
    // sessionToday (s1): only the priced call — no unpriced contribution from s2.
    expect(summary.sessionToday.inputTokens).toBe(1_000_000);
    expect(summary.sessionToday.costUsd).toBeCloseTo(3, 6);
    expect(summary.sessionToday.unpricedCalls).toBe(0);
  });

  it('a deleted session removes its usage rows from allToday (cascade — orphan-free)', () => {
    const store = storeAt(NOON);
    store.record({
      sessionId: 's1',
      kind: 'chat',
      model: 'm3',
      usage: { inputTokens: 10, outputTokens: 0 },
    });
    store.record({
      sessionId: 's2',
      kind: 'whitepaper',
      model: 'm3',
      usage: { inputTokens: 20, outputTokens: 0 },
    });
    new SessionStore(db).deleteSession('s1');
    // Query from the surviving session's perspective; s1's rows are gone, s2 remains.
    expect(store.summary('s2').allToday.inputTokens).toBe(20);
  });
});
