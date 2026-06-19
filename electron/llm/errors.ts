import Anthropic from '@anthropic-ai/sdk';

import type { LlmErrorCode, LlmErrorPayload, ProviderId } from '@shared/types';

/*
 * The typed, KEY-FREE LLM error model (M03.B; Hard Rule §10). Every failure maps
 * to a stable code with a STATIC message — we never interpolate the key, a
 * request header, or a raw SDK error string into a surfaced message, so the key
 * can never ride out on an error path. `mapAnthropicError` classifies SDK errors
 * by their typed class / HTTP status; this module is main-process only (it imports
 * the SDK) and is never reachable from the renderer bundle.
 */
const MESSAGES: Record<LlmErrorCode, string> = {
  NO_KEY: 'No Anthropic API key is configured. Add one in Settings.',
  AUTH: 'Authentication failed — check your Anthropic API key in Settings.',
  RATE_LIMIT: 'Rate limited by the Anthropic API — please retry shortly.',
  OFFLINE: 'Could not reach the Anthropic API — check your network connection.',
  OVERLOADED: 'The Anthropic API is temporarily overloaded — please retry.',
  // M07.D: a connection failure on the gateway provider — distinct copy from OFFLINE so the
  // user knows it is the corporate gateway, not their general network, that is unreachable.
  GATEWAY_UNREACHABLE:
    'Could not reach the configured gateway — check the gateway URL and your network, then retry.',
  // M07.A: the three watchdog tiers carry distinct copy so the renderer can explain
  // what happened (dead connection vs wedged generation vs hit the time limit).
  TIMEOUT_IDLE: 'Lost the connection to Claude — no response was received. Please retry.',
  TIMEOUT_STALL: 'Claude stopped responding mid-answer — please retry.',
  TIMEOUT_CEILING:
    'The request hit its maximum time limit and was stopped — try again, or switch to a faster model.',
  // CANCELLED is a user action, not a failure — the copy reflects that (Stage B toasts it).
  CANCELLED: 'Request cancelled.',
  UNKNOWN: 'The request to Claude failed. Please try again.',
};

export class LlmServiceError extends Error {
  // `detail` (M07.C fix #4 — no blind UNKNOWN) is an optional STATIC message override
  // composed from fixed step+validation labels (e.g. "Styling the document failed —
  // stylesheet validation.") so the user learns WHICH pipeline step and WHICH
  // validation failed. It must never carry model output or anything dynamic — the
  // taxonomy stays static and key-free; the code set is unchanged.
  constructor(
    readonly code: LlmErrorCode,
    detail?: string,
  ) {
    super(detail ?? MESSAGES[code]);
    this.name = 'LlmServiceError';
  }

  toPayload(): LlmErrorPayload {
    return { code: this.code, message: this.message };
  }
}

export function mapAnthropicError(error: unknown, provider?: ProviderId): LlmServiceError {
  if (error instanceof LlmServiceError) {
    return error;
  }
  // APIConnectionTimeoutError EXTENDS APIConnectionError — test the timeout subclass
  // FIRST, or a streaming/connection timeout is misreported as OFFLINE/GATEWAY_UNREACHABLE.
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    // The SDK's connection-timeout class is the dead-connection (byte-idle) case (M07.A).
    return new LlmServiceError('TIMEOUT_IDLE');
  }
  if (error instanceof Anthropic.APIConnectionError) {
    // M07.D: a plain connection error means the GATEWAY is unreachable on the gateway
    // provider, vs the general network OFFLINE on direct anthropic.
    return new LlmServiceError(provider === 'gateway' ? 'GATEWAY_UNREACHABLE' : 'OFFLINE');
  }
  if (error instanceof Anthropic.APIError) {
    switch (error.status) {
      case 401:
      case 403:
        return new LlmServiceError('AUTH');
      case 429:
        return new LlmServiceError('RATE_LIMIT');
      case 529:
        return new LlmServiceError('OVERLOADED');
      default:
        return new LlmServiceError('UNKNOWN');
    }
  }
  return new LlmServiceError('UNKNOWN');
}
