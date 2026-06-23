import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AnthropicClientLike } from '../../electron/llm/anthropic-client';
import { createAnthropicClient } from '../../electron/llm/anthropic-client';
import { LlmServiceError } from '../../electron/llm/errors';
import {
  isAllowedGatewayUrl,
  isHttpNonLocalGatewayUrl,
  selectClientFactory,
} from '../../electron/llm/provider-config';
import type { ProviderConfig } from '@shared/types';

/*
 * M07.D — the provider seam (REVIEW-V11 F19). Two providers: anthropic (sk-ant- x-api-key)
 * and gateway (sk- bearer + baseURL — the corp credential routes to Bedrock BEHIND a
 * corporate gateway, but the client integration is pure gateway: no new dep, no SigV4).
 * The streamMessage interface is unchanged. RED pins:
 *   1. the gateway-URL guard (http/https accepted; an http NON-loopback host is flagged for a
 *      non-blocking renderer warning, not rejected — corp gateways often expose internal HTTP);
 *   2. the gateway transform carries the credential as authToken and EXPLICITLY suppresses
 *      the SDK's apiKey env fallback (apiKey: null) so the anthropic x-api-key header can
 *      never reach a gateway host — proven WITH a sentinel ANTHROPIC_API_KEY in the env
 *      (teeth: suppression, not env-absence);
 *   3. anthropic = passthrough (the base factory unchanged).
 */

// Minimal SSE the SDK accepts, so a gateway client actually issues a wire request we
// can inspect (mirrors tests/llm/anthropic-client.test.ts).
function sseEvent(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}
function happyStream(model: string): string {
  return [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'hi' },
    }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join('');
}

const MODEL = 'claude-sonnet-4-6';
const CORP_BEARER = 'sk-corp-bearer-NOT-an-anthropic-key-000';
const SENTINEL_ANTHROPIC_KEY = 'sk-ant-SENTINEL-must-never-reach-gateway-000';

describe('isAllowedGatewayUrl — opened to http/https, with an http-remote warning signal', () => {
  it('accepts https URLs', () => {
    expect(isAllowedGatewayUrl('https://corp.example/anthropic')).toBe(true);
  });

  it('accepts http URLs — loopback dev gateways AND internal corp endpoints (edge TLS)', () => {
    expect(isAllowedGatewayUrl('http://127.0.0.1:8080')).toBe(true);
    expect(isAllowedGatewayUrl('http://localhost:8080/v1')).toBe(true);
    expect(isAllowedGatewayUrl('http://gateway.corp.example')).toBe(true);
  });

  it('rejects a non-URL / non-http(s) scheme', () => {
    expect(isAllowedGatewayUrl('not-a-url')).toBe(false);
    expect(isAllowedGatewayUrl('ftp://corp.example')).toBe(false);
  });

  it('flags an http NON-loopback host for the renderer warning (https + http-loopback do not warn)', () => {
    expect(isHttpNonLocalGatewayUrl('http://gateway.corp.example')).toBe(true);
    expect(isHttpNonLocalGatewayUrl('https://corp.example')).toBe(false);
    expect(isHttpNonLocalGatewayUrl('http://127.0.0.1:8080')).toBe(false);
    expect(isHttpNonLocalGatewayUrl('http://localhost:8080')).toBe(false);
  });
});

describe('selectClientFactory — gateway transform', () => {
  let priorEnv: string | undefined;
  beforeEach(() => {
    priorEnv = process.env.ANTHROPIC_API_KEY;
    // TEETH: a sentinel key sits in the env. The SDK defaults apiKey to this when
    // unset — the gateway path MUST suppress it (apiKey: null), or both headers go
    // out and the anthropic key leaks to the gateway host.
    process.env.ANTHROPIC_API_KEY = SENTINEL_ANTHROPIC_KEY;
  });
  afterEach(() => {
    if (priorEnv === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = priorEnv;
    }
  });

  it('carries the credential as Bearer authToken and NEVER sends an x-api-key header to the gateway — even with a sentinel ANTHROPIC_API_KEY in the env', async () => {
    const captured: Array<{ url: string; headers: Headers }> = [];
    const fetch = (async (url: unknown, init?: { headers?: HeadersInit }) => {
      captured.push({ url: String(url), headers: new Headers(init?.headers) });
      return new Response(happyStream(MODEL), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as unknown as typeof globalThis.fetch;

    const config: ProviderConfig = {
      provider: 'gateway',
      baseURL: 'https://corp.example/anthropic',
    };
    const factory = selectClientFactory(config, createAnthropicClient);
    // The service reads the (corp bearer) credential into options.apiKey, as today —
    // the SELECTOR re-routes it to authToken + baseURL and suppresses apiKey for gateway.
    const client = factory({ apiKey: CORP_BEARER, fetch, maxRetries: 0 });

    await client.streamMessage(
      {
        model: MODEL,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        maxTokens: 16,
      },
      () => undefined,
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toContain('corp.example');
    expect(captured[0]?.headers.get('authorization')).toBe(`Bearer ${CORP_BEARER}`);
    // The dispositive invariant: NO anthropic key header rides to the gateway, and the
    // env sentinel is never what authenticates either.
    expect(captured[0]?.headers.get('x-api-key')).toBeNull();
    const rawHeaders = JSON.stringify([...captured[0]!.headers.entries()]);
    expect(rawHeaders).not.toContain(SENTINEL_ANTHROPIC_KEY);
  });
});

describe('selectClientFactory — gateway model-id normalization (dated Haiku)', () => {
  const config: ProviderConfig = { provider: 'gateway', baseURL: 'https://corp.example/anthropic' };

  // The model the SDK actually puts on the wire for a given requested model — the gateway only
  // recognizes exact ids, so the bare Haiku alias must be rewritten to the dated form it enforces.
  async function wireModelFor(requestedModel: string): Promise<string> {
    let sent = '';
    const fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      sent = (JSON.parse(String(init?.body ?? '{}')) as { model?: string }).model ?? '';
      return new Response(happyStream(sent || 'm'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as unknown as typeof globalThis.fetch;
    const client = selectClientFactory(
      config,
      createAnthropicClient,
    )({
      apiKey: CORP_BEARER,
      fetch,
      maxRetries: 0,
    });
    await client.streamMessage(
      {
        model: requestedModel,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        maxTokens: 16,
      },
      () => undefined,
    );
    return sent;
  }

  it('rewrites the bare Haiku alias to the dated id the gateway enforces', async () => {
    expect(await wireModelFor('claude-haiku-4-5')).toBe('claude-haiku-4-5-20251001');
  });

  it('passes a model with no alias entry (Sonnet) through unchanged', async () => {
    expect(await wireModelFor('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });
});

describe('selectClientFactory — anthropic passthrough', () => {
  it('anthropic returns the base factory unchanged (passthrough)', () => {
    const config: ProviderConfig = { provider: 'anthropic' };
    expect(selectClientFactory(config, createAnthropicClient)).toBe(createAnthropicClient);
  });
});

describe('selectClientFactory — gateway error surfacing', () => {
  const config: ProviderConfig = { provider: 'gateway', baseURL: 'https://corp.example' };
  const STREAM = {
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
    maxTokens: 16,
  };
  const fakeFactoryThrowing = (error: unknown) => (): AnthropicClientLike => ({
    streamMessage: () => Promise.reject(error),
  });

  it('maps a raw connection failure to GATEWAY_UNREACHABLE (provider-conditional surfacing)', async () => {
    const factory = selectClientFactory(
      config,
      fakeFactoryThrowing(new Anthropic.APIConnectionError({ message: 'down' })),
    );
    await expect(
      factory({ apiKey: 'sk-corp' }).streamMessage(STREAM, () => undefined),
    ).rejects.toMatchObject({ code: 'GATEWAY_UNREACHABLE' });
  });

  it('passes an already-typed LlmServiceError (e.g. CANCELLED) through unchanged', async () => {
    const factory = selectClientFactory(
      config,
      fakeFactoryThrowing(new LlmServiceError('CANCELLED')),
    );
    await expect(
      factory({ apiKey: 'sk-corp' }).streamMessage(STREAM, () => undefined),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
