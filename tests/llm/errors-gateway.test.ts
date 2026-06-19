import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import { LlmServiceError, mapAnthropicError } from '../../electron/llm/errors';

/*
 * M07.D — GATEWAY_UNREACHABLE (REVIEW-V11 F19 / D.3 item 4). A connection failure means
 * something different on the gateway path ("your corporate gateway is unreachable") than
 * on the direct anthropic path ("you're offline"), so mapAnthropicError takes the ACTIVE
 * PROVIDER and maps a plain connection error PROVIDER-CONDITIONALLY. It is a taxonomy
 * EXTENSION (same key-free model, like M07.A's TIMEOUT_* split) — no new error model. The
 * timeout subclass still wins regardless of provider.
 */
describe('mapAnthropicError — provider-conditional GATEWAY_UNREACHABLE', () => {
  it('a plain connection error on the GATEWAY provider maps to GATEWAY_UNREACHABLE', () => {
    const mapped = mapAnthropicError(
      new Anthropic.APIConnectionError({ message: 'connection failed' }),
      'gateway',
    );
    expect(mapped).toBeInstanceOf(LlmServiceError);
    expect(mapped.code).toBe('GATEWAY_UNREACHABLE');
  });

  it('a plain connection error on anthropic (or no provider) still maps to OFFLINE', () => {
    expect(
      mapAnthropicError(new Anthropic.APIConnectionError({ message: 'x' }), 'anthropic').code,
    ).toBe('OFFLINE');
    expect(mapAnthropicError(new Anthropic.APIConnectionError({ message: 'x' })).code).toBe(
      'OFFLINE',
    );
  });

  it('a streaming TIMEOUT still wins over the provider distinction', () => {
    const mapped = mapAnthropicError(
      new Anthropic.APIConnectionTimeoutError({ message: 'timed out' }),
      'gateway',
    );
    expect(mapped.code).toBe('TIMEOUT_IDLE');
  });

  it('GATEWAY_UNREACHABLE carries a static, key-free message distinct from AUTH and OFFLINE', () => {
    const gateway = new LlmServiceError('GATEWAY_UNREACHABLE').message;
    expect(gateway.length).toBeGreaterThan(0);
    expect(gateway).not.toMatch(/sk-/);
    expect(gateway).not.toBe(new LlmServiceError('AUTH').message);
    expect(gateway).not.toBe(new LlmServiceError('OFFLINE').message);
  });
});
