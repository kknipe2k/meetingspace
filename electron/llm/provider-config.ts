import type { ProviderConfig } from '@shared/types';

import type {
  AnthropicClientFactory,
  AnthropicClientLike,
  StreamRequest,
} from './anthropic-client';
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

// Gateway base URLs must be HTTPS — a bearer token rides to this host, so plain-HTTP to a
// NON-loopback host is refused by default (the token would be observable on the wire). HTTP is
// always allowed for loopback (local agents / proxy sidecars / dev), and for a non-loopback host
// ONLY when the operator sets the explicit escape hatch MEETINGSPACE_ALLOW_INSECURE_GATEWAY_HTTP=1
// — a deliberate opt-in for a corporate internal plain-HTTP gateway behind a trusted network
// boundary (the token may be observable on that path). This reads the REAL process.env (NOT the
// !app.isPackaged-gated devEnv) because the override must work in the SHIPPED app; the read is
// allowlisted in tests/security/env-seams.test.ts as a conscious, always-on production override.
export function isAllowedGatewayUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') {
    return true;
  }
  if (parsed.protocol === 'http:') {
    if (LOOPBACK_HOSTS.has(parsed.hostname)) {
      return true;
    }
    return process.env.MEETINGSPACE_ALLOW_INSECURE_GATEWAY_HTTP === '1';
  }
  return false;
}

// Companion helper for the renderer's insecure-HTTP messaging: true for an http:// URL whose host
// is NOT loopback — the case that is refused unless the insecure-HTTP override is set.
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

// The corporate Bedrock gateway maps each incoming `model` to a fixed Bedrock model/inference-profile
// and recognizes ONLY the exact ids in that map. For Haiku the gateway enforces the DATED snapshot;
// the app's canonical bare alias `claude-haiku-4-5` (accepted by direct Anthropic, and the id the
// curated fallback catalog uses when the gateway exposes no /v1/models) is NOT in the gateway's map,
// so it's rejected. Normalize the bare alias to the dated form the gateway enforces (the same id the
// connectivity ping uses) at the gateway egress, so EVERY gateway call — chat default, explicit pick,
// or generation — sends an id the gateway recognizes. Sonnet's `claude-sonnet-4-6` is accepted as-is
// (no entry). When the gateway DOES expose /v1/models and the picker already carries the dated id,
// this is a harmless no-op (the dated id isn't a key).
const GATEWAY_MODEL_ALIASES: Readonly<Record<string, string>> = {
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
};

function toGatewayModelRequest(request: StreamRequest): StreamRequest {
  const mapped = GATEWAY_MODEL_ALIASES[request.model];
  return mapped ? { ...request, model: mapped } : request;
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
          return await client.streamMessage(toGatewayModelRequest(request), onChunk);
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
