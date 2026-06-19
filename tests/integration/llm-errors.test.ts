import { describe, expect, it } from 'vitest';

import { DEFAULT_MAX_RETRIES, createAnthropicClient } from '../../electron/llm/anthropic-client';
import { LlmServiceError } from '../../electron/llm/errors';
import { createLlmService, type LlmService } from '../../electron/llm/llm-service';
import type { LlmChatRequest } from '@shared/types';

/*
 * M03.D error-taxonomy integration gate (docs/gates.md "Integration tests"), run
 * by `npm run test:integration`. Drives the REAL Anthropic SDK through the LLM
 * service with an INJECTED fetch — no live network, no real key — and asserts the
 * FULL typed taxonomy is mapped key-free (401/403→AUTH, 429→RATE_LIMIT,
 * 529→OVERLOADED, network→OFFLINE, 500→UNKNOWN, no-key→NO_KEY), and that the
 * SDK's 429/5xx retry is CAPPED (bounded by DEFAULT_MAX_RETRIES, never infinite —
 * gotcha "cap retries"). The key-free assertion is the mutation target: a leaked
 * key in any error message must turn this red.
 */
const FAKE_KEY = 'sk-ant-secret-LEAK-CANARY-7f3a';

const REQUEST: LlmChatRequest = {
  sessionId: 's1',
  question: 'Summarize the notes.',
  model: 'claude-haiku-4-5',
};

function serviceWith(
  fetchImpl: typeof globalThis.fetch,
  opts: { maxRetries?: number; key?: string | null } = {},
): LlmService {
  return createLlmService({
    keyStore: { getKeyForMain: () => (opts.key === undefined ? FAKE_KEY : opts.key) },
    clientFactory: ({ apiKey }) =>
      createAnthropicClient({
        apiKey,
        fetch: fetchImpl,
        ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
      }),
    // Content-bearing session so grounding is non-empty and the SDK path runs
    // (the empty-session short-circuit is unit-covered in llm-service.test.ts).
    notes: {
      listNotes: () => [
        {
          id: 'n1',
          sessionId: REQUEST.sessionId,
          content: 'We shipped.',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    },
  });
}

function jsonErrorFetch(
  status: number,
  errorType: string,
  extraHeaders: Record<string, string> = {},
): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify({ type: 'error', error: { type: errorType, message: FAKE_KEY } }), {
      status,
      headers: { 'content-type': 'application/json', ...extraHeaders },
    })) as unknown as typeof globalThis.fetch;
}

async function catchError(service: LlmService): Promise<unknown> {
  return service
    .streamChat(REQUEST, { onChunk: () => undefined })
    .then(() => null)
    .catch((e: unknown) => e);
}

describe('LLM error taxonomy over the real SDK (mocked endpoint)', () => {
  const cases: Array<[string, number, string, LlmServiceError['code']]> = [
    ['401 → AUTH', 401, 'authentication_error', 'AUTH'],
    ['403 → AUTH', 403, 'permission_error', 'AUTH'],
    ['429 → RATE_LIMIT', 429, 'rate_limit_error', 'RATE_LIMIT'],
    ['529 → OVERLOADED', 529, 'overloaded_error', 'OVERLOADED'],
    ['500 → UNKNOWN', 500, 'api_error', 'UNKNOWN'],
  ];

  for (const [name, status, errorType, code] of cases) {
    it(`maps ${name} (no retry)`, async () => {
      const service = serviceWith(jsonErrorFetch(status, errorType), { maxRetries: 0 });
      const error = await catchError(service);
      expect(error).toBeInstanceOf(LlmServiceError);
      expect((error as LlmServiceError).code).toBe(code);
    });
  }

  it('maps a network failure to OFFLINE', async () => {
    const throwingFetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    const error = await catchError(serviceWith(throwingFetch, { maxRetries: 0 }));
    expect((error as LlmServiceError).code).toBe('OFFLINE');
  });

  it('returns NO_KEY without ever calling the SDK when no key is configured', async () => {
    let called = false;
    const fetchSpy = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const error = await catchError(serviceWith(fetchSpy, { key: null }));
    expect((error as LlmServiceError).code).toBe('NO_KEY');
    expect(called).toBe(false);
  });

  it('never leaks the API key into any mapped error (message or serialized form)', async () => {
    for (const [, status, errorType] of cases) {
      const error = (await catchError(
        serviceWith(jsonErrorFetch(status, errorType), { maxRetries: 0 }),
      )) as LlmServiceError;
      expect(error.message).not.toContain(FAKE_KEY);
      expect(JSON.stringify(error.toPayload())).not.toContain(FAKE_KEY);
      expect(JSON.stringify(error)).not.toContain(FAKE_KEY);
    }
  });

  it('caps 429 retries at DEFAULT_MAX_RETRIES (bounded, never infinite)', async () => {
    let calls = 0;
    const countingFetch = (async (url: unknown, init?: unknown) => {
      calls += 1;
      // retry-after: 0 keeps the SDK backoff immediate so the test stays fast.
      return (
        jsonErrorFetch(429, 'rate_limit_error', { 'retry-after': '0' }) as (
          u: unknown,
          i?: unknown,
        ) => Promise<Response>
      )(url, init);
    }) as unknown as typeof globalThis.fetch;

    // No maxRetries override → the client uses DEFAULT_MAX_RETRIES.
    const error = await catchError(serviceWith(countingFetch));
    expect((error as LlmServiceError).code).toBe('RATE_LIMIT');
    expect(calls).toBe(1 + DEFAULT_MAX_RETRIES);
  });
});
