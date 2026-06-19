import Anthropic from '@anthropic-ai/sdk';

import type { LlmErrorCode, LlmHeartbeat, LlmMessage, LlmUsage } from '@shared/types';

import { LlmServiceError } from './errors';

/*
 * The main-process Anthropic client wrapper (M03.B). The Anthropic SDK runs in the
 * MAIN process only (gotcha §3) — the SDK's browser escape-hatch flag is never set
 * (a literal-absence test guards it), and the import-boundary test
 * (tests/unit/renderer-no-sdk-import.test.ts) proves no renderer-reachable module
 * imports this. `fetch` is injectable so the streaming
 * path runs under tests with no live network; `maxRetries` lets tests disable the
 * SDK's 429/5xx backoff for deterministic error assertions.
 *
 * Messages are domain content-block arrays (text AND image) so the path is
 * multimodal-ready for M04 — the snake_case `media_type` the API expects is mapped
 * here so the SDK shape never leaks into the shared types.
 */
export interface StreamRequest {
  readonly model: string;
  readonly messages: LlmMessage[];
  readonly system?: string;
  readonly maxTokens: number;
}

export interface StreamResult {
  readonly stopReason: string | null;
  readonly usage: LlmUsage;
  /** The model the API actually answered with (from the final message). */
  readonly model: string;
}

export type ChunkHandler = (delta: string) => void;

export interface AnthropicClientLike {
  streamMessage(request: StreamRequest, onChunk: ChunkHandler): Promise<StreamResult>;
}

export interface AnthropicClientOptions {
  /**
   * The direct-anthropic API key (x-api-key). M07.D: pass `null` to EXPLICITLY suppress
   * the SDK's `ANTHROPIC_API_KEY` env-var fallback — the gateway path does exactly this so
   * a stray env key can never ride out as an x-api-key header to the gateway host.
   */
  readonly apiKey?: string | null | undefined;
  /**
   * M07.D gateway auth (Authorization: Bearer). When set, `apiKey` is passed `null` so the
   * SDK sends ONLY the bearer — never the anthropic key header — to the gateway.
   */
  readonly authToken?: string | null | undefined;
  /** M07.D gateway base URL (the corporate proxy endpoint). */
  readonly baseURL?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxRetries?: number;
  /** Byte-idle budget: abort if NO raw bytes (incl. SSE pings) arrive in this window — a dead connection. */
  readonly byteIdleMs?: number;
  /** Text-idle budget: abort if pings keep flowing but NO text delta arrives in this window — wedged. */
  readonly textIdleMs?: number;
  /** Total wall-clock ceiling over the whole call (backstop; covers the bounded retries). */
  readonly ceilingMs?: number;
  /**
   * External cancel (M07.A; F11). When this signal aborts, the in-flight stream is torn
   * down via the SAME stream.abort() the watchdog uses, surfacing a typed CANCELLED. A
   * signal already aborted at entry throws CANCELLED before the SDK call — zero spend.
   */
  readonly signal?: AbortSignal;
  /** Throttled progress callback off the byte tap (F21); omit for no heartbeats (zero overhead). */
  readonly onHeartbeat?: (heartbeat: LlmHeartbeat) => void;
  /** Heartbeat throttle window; defaults to DEFAULT_HEARTBEAT_MS. */
  readonly heartbeatMs?: number;
}

export type AnthropicClientFactory = (options: AnthropicClientOptions) => AnthropicClientLike;

// The SDK retries 429/5xx with exponential backoff; cap it so a persistent
// rate-limit/overload surfaces a clear error instead of looping (gotcha "cap
// retries"). Bounded total attempts = 1 + DEFAULT_MAX_RETRIES. Tests inject 0 for
// deterministic single-shot error assertions. Kept tight so per-attempt retries can
// never stack past the wall-clock ceiling below.
export const DEFAULT_MAX_RETRIES = 2;

// The ping-aware THREE-TIER streaming watchdog (D-01). The SDK has no clean mid-stream
// timeout (verified against @anthropic-ai/sdk 0.100.1) AND it DROPS SSE pings — so the
// earlier text-delta stall false-aborted long generations (Opus thinks 60-120s between
// text deltas while ~15-30s pings flow). We instead tap the RAW fetch response body and
// run three tiers, each `stream.abort()`-ing into a DISTINCT typed code (M07.A, key-free):
// TIMEOUT_IDLE / TIMEOUT_STALL / TIMEOUT_CEILING — and the same abort path is reused for
// the user's external cancel (CANCELLED) via an injected AbortSignal:
//  - BYTE-IDLE: reset on every raw byte chunk (incl. pings) — fires only when the
//    connection produces NOTHING at all (genuinely dead). Generous default.
//  - TEXT-IDLE: reset on every text delta — fires when pings keep flowing but no text
//    is produced (a wedged generation). Larger than byte-idle.
//  - CEILING: a TOTAL wall-clock cap over the whole call (connect + bounded retries +
//    streaming) — the backstop, never reset. Large enough for a multi-minute white paper.
// Tunable per call for deterministic tests; chat passes a tighter ceiling (llm-service).
export const DEFAULT_BYTE_IDLE_MS = 120_000;
export const DEFAULT_TEXT_IDLE_MS = 300_000;
// M07.A: generation can run many minutes (Opus thinks 12-15 min on a long white paper),
// so the wall-clock backstop rises 600s -> 1200s. Chat keeps its own tighter 120s
// ceiling (set in llm-service); byte/text-idle are unchanged.
export const DEFAULT_CEILING_MS = 1_200_000;

// Heartbeat throttle: emit at most one progress event per this window while bytes flow.
export const DEFAULT_HEARTBEAT_MS = 15_000;

function toApiContent(block: LlmMessage['content'][number]): Anthropic.ContentBlockParam {
  if (block.type === 'image') {
    return {
      type: 'image',
      source: { type: 'base64', media_type: block.source.mediaType, data: block.source.data },
    } as Anthropic.ImageBlockParam;
  }
  // M07.C: the domain `cache` flag maps to the SDK's cache_control content-block
  // property (the shared chunked prefix — FOCUS+outline — is identical across the N+1
  // section/css calls, so they read it at ~0.1x). A content-block property only: the
  // request body's TOP-LEVEL key set is unchanged, so the F29 read-only lock holds
  // (re-proved in tests/llm/anthropic-client-cache.test.ts). The domain flag itself
  // never reaches the wire.
  return {
    type: 'text',
    text: block.text,
    ...(block.cache ? { cache_control: { type: 'ephemeral' as const } } : {}),
  };
}

function toApiMessages(messages: LlmMessage[]): Anthropic.MessageParam[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map(toApiContent),
  }));
}

export function createAnthropicClient(options: AnthropicClientOptions): AnthropicClientLike {
  // The current in-flight stream's raw-byte observer, set by streamMessage and invoked by
  // the fetch tap on every raw chunk with that chunk's byte length. It resets byte-idle
  // and feeds the heartbeat throttle. One in-flight stream per client (services build a
  // client per call), so a single ref is sufficient.
  let onRawByte: ((bytes: number) => void) | null = null;

  // Tap the fetch response body so we observe RAW bytes (incl. the SSE pings the SDK
  // drops). `tee()` splits the stream: one branch is handed to the SDK UNTOUCHED; the
  // other is drained here, pinging the byte-idle timer per chunk. We always drain our
  // branch (no backpressure), and it ends when the source closes OR errors — the latter
  // is how `stream.abort()` tears this down, so no reader/timer leaks.
  const baseFetch = options.fetch ?? globalThis.fetch;
  type FetchArgs = Parameters<typeof globalThis.fetch>;
  const tappedFetch = (async (input: FetchArgs[0], init?: FetchArgs[1]): Promise<Response> => {
    const response = await baseFetch(input, init);
    const observer = onRawByte;
    if (!observer || !response.body) {
      return response;
    }
    const [toSdk, toObserver] = response.body.tee();
    void (async () => {
      const reader = toObserver.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          observer(value?.byteLength ?? 0);
        }
      } catch {
        /* aborted / errored — the request was torn down; stop observing */
      } finally {
        reader.releaseLock();
      }
    })();
    return new Response(toSdk, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof globalThis.fetch;

  // M07.D: the client FORWARDS apiKey as given — the gateway suppression is single-sourced in
  // selectClientFactory, which passes `apiKey: null` to suppress the SDK's ANTHROPIC_API_KEY env
  // fallback (so the anthropic key header is NEVER sent to a gateway host even if the env var is
  // set). authToken/baseURL are passed only when provided, so the direct-anthropic path's
  // request shape is byte-identical to before.
  const client = new Anthropic({
    apiKey: options.apiKey,
    ...(options.authToken != null ? { authToken: options.authToken } : {}),
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    fetch: tappedFetch,
  });

  return {
    async streamMessage(request, onChunk) {
      // Prompt-cache the (stable) system/grounding prefix — ~0.1x on cache reads
      // once Stage C assembles a real grounding prefix worth caching.
      const system = request.system
        ? [
            {
              type: 'text' as const,
              text: request.system,
              cache_control: { type: 'ephemeral' as const },
            },
          ]
        : undefined;

      // External cancel that arrived BEFORE we start spends nothing — bail before the SDK
      // call (and before arming anything) so no request goes out (M07.A; F11).
      if (options.signal?.aborted) {
        throw new LlmServiceError('CANCELLED');
      }

      const byteIdleMs = options.byteIdleMs ?? DEFAULT_BYTE_IDLE_MS;
      const textIdleMs = options.textIdleMs ?? DEFAULT_TEXT_IDLE_MS;
      const ceilingMs = options.ceilingMs ?? DEFAULT_CEILING_MS;
      const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

      // We abort the stream ourselves (not the API) when a tier trips OR the caller cancels,
      // so the resulting APIUserAbortError is translated to the typed code that fired —
      // distinct TIMEOUT_* tiers (F21) or CANCELLED (F11) — rather than surfaced raw. The
      // FIRST cause wins (a later tier can't relabel a cancel, and vice versa).
      let abortCode: LlmErrorCode | null = null;
      // A const holder so `abortWith` (and the timers) can reference the stream before it's
      // assigned — onRawByte MUST be set before the request starts (below), or the fetch
      // tap captures a null observer and byte-idle is never reset.
      const handle: { stream?: ReturnType<typeof client.messages.stream> } = {};
      const abortWith = (code: LlmErrorCode): void => {
        if (abortCode === null) {
          abortCode = code;
        }
        handle.stream?.abort();
      };
      let byteTimer: ReturnType<typeof setTimeout> | undefined;
      let textTimer: ReturnType<typeof setTimeout> | undefined;
      const armByteIdle = (): void => {
        if (byteTimer !== undefined) {
          clearTimeout(byteTimer);
        }
        byteTimer = setTimeout(() => abortWith('TIMEOUT_IDLE'), byteIdleMs);
      };
      const armTextIdle = (): void => {
        if (textTimer !== undefined) {
          clearTimeout(textTimer);
        }
        textTimer = setTimeout(() => abortWith('TIMEOUT_STALL'), textIdleMs);
      };
      // The ceiling is a single timer over the whole call — NOT reset.
      const ceilingTimer = setTimeout(() => abortWith('TIMEOUT_CEILING'), ceilingMs);

      // The user's external cancel (F11): the SAME stream.abort() path, fired externally.
      const onExternalAbort = (): void => abortWith('CANCELLED');
      options.signal?.addEventListener('abort', onExternalAbort);

      const clearTimers = (): void => {
        if (byteTimer !== undefined) {
          clearTimeout(byteTimer);
        }
        if (textTimer !== undefined) {
          clearTimeout(textTimer);
        }
        clearTimeout(ceilingTimer);
      };

      // Heartbeat throttle off the byte tap (F21): count raw bytes, emit at most one event
      // per heartbeatMs while bytes flow. Date.now() is fine here — production wall-clock,
      // and tests drive it with tiny real budgets (the established tier-suite pattern).
      const startedAt = Date.now();
      let beatBytes = 0;
      let lastBeatAt = startedAt;
      const onByte = (bytes: number): void => {
        armByteIdle(); // a raw chunk (incl. a ping) — the connection is alive
        const { onHeartbeat } = options;
        if (onHeartbeat) {
          beatBytes += bytes;
          const now = Date.now();
          if (now - lastBeatAt >= heartbeatMs) {
            lastBeatAt = now;
            onHeartbeat({ elapsedMs: now - startedAt, bytes: beatBytes });
          }
        }
      };

      // The fetch tap resets BYTE-IDLE + feeds heartbeats on every raw chunk (incl. pings);
      // text deltas reset TEXT-IDLE below. Set before the request starts so first bytes count.
      onRawByte = onByte;
      handle.stream = client.messages.stream({
        model: request.model,
        max_tokens: request.maxTokens,
        messages: toApiMessages(request.messages),
        ...(system ? { system } : {}),
      });
      const stream = handle.stream;

      let final: Anthropic.Message;
      try {
        armByteIdle();
        armTextIdle();
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            armTextIdle(); // text arrived — reset the wedged-generation watchdog
            onChunk(event.delta.text);
          }
        }
        final = await stream.finalMessage();
      } catch (error) {
        if (abortCode !== null) {
          throw new LlmServiceError(abortCode);
        }
        throw error; // a real SDK/network failure — mapped by the calling service
      } finally {
        clearTimers();
        options.signal?.removeEventListener('abort', onExternalAbort);
        onRawByte = null; // stop the tap from observing past this stream
      }
      // exactOptionalPropertyTypes: omit the cache fields rather than assign
      // undefined when the API didn't report them.
      const usage: LlmUsage = {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
        ...(final.usage.cache_read_input_tokens != null
          ? { cacheReadInputTokens: final.usage.cache_read_input_tokens }
          : {}),
        ...(final.usage.cache_creation_input_tokens != null
          ? { cacheCreationInputTokens: final.usage.cache_creation_input_tokens }
          : {}),
      };
      return { stopReason: final.stop_reason, usage, model: final.model };
    },
  };
}
