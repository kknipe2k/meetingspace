import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { GenKind, LlmUsage, UsageSummary, UsageTotals } from '@shared/types';

import { CACHE_READ_MULT, CACHE_WRITE_MULT, type ModelPrice } from '../llm/pricing-config';

interface UsageRow {
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

type Clock = () => number;
type IdFactory = () => string;
type PriceLookup = (model: string) => ModelPrice | null;

export type UsageKind = 'chat' | GenKind;

export interface UsageStoreDeps {
  now?: Clock;
  newId?: IdFactory;
  priceFor: PriceLookup;
}

/*
 * The real-usage token + cost counter store (M06.D, ADR-0021/0022/0024, passive — shows used, never
 * caps). Records every call's ACTUAL usage (input/output/cache tokens) tagged with session_id + a
 * timestamp, and rolls up two TODAY-WINDOWED rows (ADR-0024, local-midnight → now): THIS SESSION
 * today (filtered by session_id) and ALL SESSIONS today — each across all kinds (chat + generation).
 * The all-time total row was dropped (ADR-0024 supersedes ADR-0022; recording model unchanged).
 * Cost is computed at READ time from the injected pricing lookup (never stored — a price change must
 * not rewrite history) using the CONSERVATIVE SPLIT: real token totals always, costUsd over priced
 * calls only, `unpricedCalls` counting models with no config price (excluded from cost) — never a
 * wrong number.
 *
 * The key NEVER reaches this layer — it records token counts off the same stream-result path the
 * watchdog taps (F29 read-only lock unaffected). Cascade-on-session-delete (schema v8) keeps it
 * orphan-free.
 */
export class UsageStore {
  private readonly db: Database.Database;
  private readonly now: Clock;
  private readonly newId: IdFactory;
  private readonly priceFor: PriceLookup;

  constructor(db: Database.Database, deps: UsageStoreDeps) {
    this.db = db;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
    this.priceFor = deps.priceFor;
  }

  record(input: {
    sessionId: string;
    kind: UsageKind;
    model?: string | null;
    usage: LlmUsage;
  }): void {
    this.db
      .prepare(
        'INSERT INTO usage (id, session_id, kind, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        this.newId(),
        input.sessionId,
        input.kind,
        input.model ?? null,
        input.usage.inputTokens,
        input.usage.outputTokens,
        input.usage.cacheReadInputTokens ?? 0,
        input.usage.cacheCreationInputTokens ?? 0,
        this.now(),
      );
  }

  // Two TODAY-windowed rows (ADR-0024): this session today + all sessions today, both from
  // local-midnight → now. Read/aggregation only — no schema change; the all-time total is dropped.
  summary(sessionId: string): UsageSummary {
    const dayStart = startOfLocalDay(this.now());
    const allTodayRows = this.db
      .prepare('SELECT * FROM usage WHERE created_at >= ?')
      .all(dayStart) as UsageRow[];
    const sessionTodayRows = this.db
      .prepare('SELECT * FROM usage WHERE created_at >= ? AND session_id = ?')
      .all(dayStart, sessionId) as UsageRow[];
    return {
      sessionToday: this.totals(sessionTodayRows),
      allToday: this.totals(allTodayRows),
    };
  }

  // The conservative split: real token totals over all rows; cost summed over rows whose model has
  // a config price (input + output + cache at the read/write multipliers); rows with no price are
  // counted in `unpricedCalls` and excluded from cost — so the figure is never understated-as-exact.
  private totals(rows: UsageRow[]): UsageTotals {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let costUsd = 0;
    let unpricedCalls = 0;
    for (const row of rows) {
      inputTokens += row.input_tokens;
      outputTokens += row.output_tokens;
      cacheReadTokens += row.cache_read_tokens;
      cacheCreationTokens += row.cache_creation_tokens;
      const price = row.model !== null ? this.priceFor(row.model) : null;
      if (price === null) {
        unpricedCalls += 1;
        continue;
      }
      const inputUnits =
        row.input_tokens +
        row.cache_creation_tokens * CACHE_WRITE_MULT +
        row.cache_read_tokens * CACHE_READ_MULT;
      costUsd += (inputUnits / 1_000_000) * price.inputPerMTok;
      costUsd += (row.output_tokens / 1_000_000) * price.outputPerMTok;
    }
    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      costUsd,
      unpricedCalls,
    };
  }
}

// The start of the local day for `now` (epoch ms) — the "today" window boundary. Local, not UTC,
// so "today" matches the user's wall clock.
function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
