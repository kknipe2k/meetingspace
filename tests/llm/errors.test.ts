import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import { LlmServiceError, mapAnthropicError } from '../../electron/llm/errors';

/*
 * M04.C cycle 2 — the TIMEOUT branch of the typed, KEY-FREE error model. A streaming
 * timeout surfaces as the SDK's APIConnectionTimeoutError, which EXTENDS
 * APIConnectionError — so mapAnthropicError must test the timeout subclass FIRST, or a
 * timeout is misreported as OFFLINE. The message stays static and key-free like the
 * rest of the taxonomy (Hard Rule §10), and distinct from OFFLINE so the UI can phrase
 * a timeout-specific Retry affordance.
 */
describe('mapAnthropicError — timeout', () => {
  it('maps an SDK streaming/connection timeout (APIConnectionTimeoutError) to TIMEOUT_IDLE, not OFFLINE', () => {
    // M07.A: the SDK's connection-timeout class is the dead-connection (byte-idle) case.
    const mapped = mapAnthropicError(
      new Anthropic.APIConnectionTimeoutError({ message: 'Request timed out.' }),
    );
    expect(mapped).toBeInstanceOf(LlmServiceError);
    expect(mapped.code).toBe('TIMEOUT_IDLE');
  });

  it('a plain connection error still maps to OFFLINE (the subclass check did not over-match)', () => {
    const mapped = mapAnthropicError(
      new Anthropic.APIConnectionError({ message: 'connection failed' }),
    );
    expect(mapped.code).toBe('OFFLINE');
  });

  it('each tier code + CANCELLED carries a static, key-free, DISTINCT message', () => {
    // M07.A: the single TIMEOUT split into three tiers + a user CANCELLED; the renderer
    // copy differs per code, so the messages must be non-empty, key-free, and distinct.
    const codes = ['TIMEOUT_IDLE', 'TIMEOUT_STALL', 'TIMEOUT_CEILING', 'CANCELLED'] as const;
    const messages = codes.map((code) => new LlmServiceError(code).message);
    for (const message of messages) {
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toMatch(/sk-ant/);
    }
    expect(new Set(messages).size).toBe(codes.length); // all distinct
  });

  it('accepts an optional STATIC detail message override (M07.C fix #4 — no blind UNKNOWN), keeping the code', () => {
    // The pipeline's step failures compose copy from STATIC step+validation labels —
    // never model output, never the key — so the user learns WHICH step and WHICH
    // validation failed instead of the generic UNKNOWN copy. No new taxonomy code.
    const detailed = new LlmServiceError(
      'UNKNOWN',
      'Styling the document failed — stylesheet validation.',
    );
    expect(detailed.code).toBe('UNKNOWN');
    expect(detailed.message).toBe('Styling the document failed — stylesheet validation.');
    expect(detailed.toPayload()).toEqual({
      code: 'UNKNOWN',
      message: 'Styling the document failed — stylesheet validation.',
    });
    // Without a detail the static per-code message is unchanged.
    expect(new LlmServiceError('UNKNOWN').message).toBe(
      'The request to Claude failed. Please try again.',
    );
  });
});
