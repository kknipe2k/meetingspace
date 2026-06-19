import { describe, expect, it } from 'vitest';

import type { LlmContentBlock } from '@shared/types';

import {
  createFakeGenerationClient,
  createFakeStreamingClient,
} from '../../electron/llm/fake-streaming-client';

/*
 * The e2e mocked-SDK seam (M03.C). main.ts swaps the real Anthropic client for this
 * canned-stream fake when MEETINGSPACE_FAKE_LLM=1 AND the build is unpackaged, so the
 * chat e2e exercises the real grounding + IPC path with NO live key/network and NO
 * SDK import. This unit test keeps the harness honest (it actually streams + resolves)
 * and the seam covered.
 */
describe('createFakeStreamingClient', () => {
  it('streams canned deltas in order then resolves with a stop reason', async () => {
    const client = createFakeStreamingClient();

    const chunks: string[] = [];
    const result = await client.streamMessage(
      { model: 'claude-haiku-4-5', maxTokens: 256, messages: [] },
      (delta) => chunks.push(delta),
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toMatch(/\S/);
    expect(result.stopReason).toBe('end_turn');
    expect(result.usage.outputTokens).toBeGreaterThanOrEqual(0);
  });

  it('does not import the Anthropic SDK (no key/network can ride this seam)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(
      resolve(__dirname, '../../electron/llm/fake-streaming-client.ts'),
      'utf8',
    );
    expect(source).not.toContain('@anthropic-ai/sdk');
  });
});

/*
 * The generation fake (M04.B). It is the e2e's load-bearing fixture for the
 * injected-script proof: Part 1 must echo the corpus (so a planted <script> in a
 * note flows into the FOCUS doc), and Part 2 must emit HTML that EMBEDS that text
 * AND its own script vectors (so the sanitizer + sandbox are actually exercised).
 * If the fake stopped doing either, the e2e proof would go vacuous — so it is pinned
 * here, not only behaviorally.
 */
function textBlock(text: string): LlmContentBlock {
  return { type: 'text', text };
}

describe('createFakeGenerationClient', () => {
  it('Part 1 (FOCUS prompt) echoes the corpus text so untrusted content flows downstream', async () => {
    const client = createFakeGenerationClient();
    const chunks: string[] = [];
    await client.streamMessage(
      {
        model: 'claude-opus-4-8',
        maxTokens: 256,
        system: 'FOCUS-SYSTEM-PROMPT',
        messages: [{ role: 'user', content: [textBlock('NOTE <script>x()</script>')] }],
      },
      (delta) => chunks.push(delta),
    );
    expect(chunks.join('')).toContain('NOTE <script>x()</script>');
  });

  it('Part 2 (white-paper prompt) emits HTML embedding the FOCUS text plus script vectors', async () => {
    const client = createFakeGenerationClient();
    const chunks: string[] = [];
    await client.streamMessage(
      {
        model: 'claude-opus-4-8',
        maxTokens: 256,
        // Contains "White Paper" — the signal the fake uses to switch to Part 2.
        system: 'Synthesize ... into a White Paper.',
        messages: [
          { role: 'user', content: [textBlock('FOCUS: planted <script>evil()</script>')] },
        ],
      },
      (delta) => chunks.push(delta),
    );
    const html = chunks.join('');
    expect(html).toMatch(/<script/i); // its own model-emitted vector
    expect(html).toContain('onerror'); // and an inline handler
    expect(html).toContain('planted <script>evil()</script>'); // reflected FOCUS text
    expect(html).toContain('White Paper'); // a recognizable heading the e2e polls for
  });
});
