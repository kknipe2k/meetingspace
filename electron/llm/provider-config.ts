import type { ProviderConfig } from '@shared/types';

import type { AnthropicClientFactory, AnthropicClientLike } from './anthropic-client';
import { mapAnthropicError } from './errors';

/*
 * The provider seam (M07.D; REVIEW-V11 F19). The narrow `streamMessage` interface is the
 * seam — the services don't change. Two providers:
 *   - anthropic: the base factory unchanged (apiKey → x-api-key).
 *   - gateway:   the SDK pointed at a corporate base URL with the credential as a BEARER
 *                authToken and apiKey EXPLICITLY null'd, so the anthropic key header can
 *                never reach the gateway host (even with ANTHROPIC_API_KEY in the env).
 *
 * Native Amazon Bedrock is deliberately NOT a provider (the corp reaches Bedrock THROUGH
 * the gateway; an `sk-` bearer can't SigV4-sign — ADR-0019). The gateway wrapper also maps
 * a raw connection failure to the provider-conditional GATEWAY_UNREACHABLE so BOTH chat and
 * generation surface the right error WITHOUT touching either service's error path (the
 * generation §10 gen-core file stays cap-only). LlmServiceErrors (watchdog tiers, CANCELLED)
 * pass through unchanged.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// Accept any https:// or http:// gateway URL. Corporate Bedrock gateways commonly expose an internal
// HTTP endpoint (TLS terminates at the network edge); the security signal for non-local HTTP is a
// non-blocking renderer toast (isHttpNonLocalGatewayUrl), not a hard block.
export function isAllowedGatewayUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
    return true;
  }
  return false;
}

// Companion helper for the renderer's non-blocking HTTP warning: true for an http:// URL whose host
// is NOT loopback (the save still proceeds).
export function isHttpNonLocalGatewayUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && !LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

// Map the active provider + the per-call credential to the SDK client options (M06.D — single
// source for both selectClientFactory and the model-catalog lister). anthropic → the credential as
// x-api-key; gateway → the credential as a BEARER authToken with apiKey EXPLICITLY null so the
// anthropic key header (even from ANTHROPIC_API_KEY in the env) can never reach the gateway host.
export interface ProviderSdkOptions {
  readonly apiKey: string | null;
  readonly authToken?: string | null;
  readonly baseURL?: string;
}

export function providerSdkOptions(
  config: ProviderConfig,
  credential: string | null,
): ProviderSdkOptions {
  if (config.provider === 'anthropic') {
    return { apiKey: credential };
  }
  return { apiKey: null, authToken: credential ?? null, baseURL: config.baseURL };
}

// Build the per-provider client factory from the stored config. The service still reads the
// credential per call into `options.apiKey` (Hard Rule §10 — read per call); the SELECTOR is
// what re-routes it to the bearer + baseURL for the gateway and suppresses the apiKey.
export function selectClientFactory(
  config: ProviderConfig,
  baseFactory: AnthropicClientFactory,
): AnthropicClientFactory {
  if (config.provider === 'anthropic') {
    return baseFactory;
  }
  // gateway
  return (options) => {
    const { apiKey: credential, ...rest } = options;
    const client = baseFactory({
      ...rest,
      // Single-sourced suppression: apiKey null (no x-api-key to the gateway) + the bearer + baseURL.
      ...providerSdkOptions(config, credential ?? null),
    });
    const wrapped: AnthropicClientLike = {
      async streamMessage(request, onChunk) {
        try {
          return await client.streamMessage(request, onChunk);
        } catch (error) {
          // Provider-conditional mapping: a raw connection failure becomes
          // GATEWAY_UNREACHABLE; LlmServiceErrors (timeouts, CANCELLED) pass through.
          throw mapAnthropicError(error, 'gateway');
        }
      },
    };
    return wrapped;
  };
}
