import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createAnthropicClient,
  type AnthropicClientOptions,
} from '../../electron/llm/anthropic-client';
import { createGenerationService } from '../../electron/gen/generation-service';
import { createLlmService } from '../../electron/llm/llm-service';
import {
  CSS_PROMPT,
  FOCUS_PROMPT,
  PLAN_PROMPT,
  SEED_TEMPLATE_ID,
} from '../../electron/gen/prompt-templates';
import { DEFAULT_GENERATION_MODEL } from '@shared/models';
import type { Asset, GenDocument, GenTemplate, Note } from '@shared/types';

/*
 * F29 — the read-only-LLM invariant, LOCKED (REVIEW-V11). The LLM has no write/tool/
 * destructive path: the only SDK entry is messages.stream({ model, max_tokens, messages,
 * system? }). These tests pin that two ways, both mutation-verified at gate time:
 *   (a) BODY-SHAPE — drive the REAL client (capturing fetch) through BOTH the chat and
 *       generation service paths; every serialized request body's key set is exactly
 *       {max_tokens, messages, model, system}. The instant anyone adds `tools` /
 *       `tool_choice`, the set changes and this fails.
 *   (b) LITERAL-ABSENCE — a source guard (same shape as the env-seam class guard) that
 *       `tools` / `tool_choice` / `tool_use` never appears at an SDK call site in electron/.
 */
const KEY = 'sk-ant-api03-THIS-IS-A-FAKE-TEST-KEY-000';
const MODEL = DEFAULT_GENERATION_MODEL;
// The read-only capability keys plus the SDK's `stream: true` transport flag (added by
// messages.stream, not by us). The lock stays load-bearing: a `tools` / `tool_choice`
// added at any call site changes this set and fails the assertion.
const ALLOWED_BODY_KEYS = ['max_tokens', 'messages', 'model', 'stream', 'system'];

function sseEvent(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function happyStream(model: string, delta: string): string {
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
        usage: { input_tokens: 10, output_tokens: 0 },
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
      delta: { type: 'text_delta', text: delta },
    }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join('');
}

// A real-client factory whose fetch records every serialized request body. M07.C: the
// pipeline needs a VALID plan back from the PLAN call and a rule-bearing stylesheet
// from the CSS call (or the run fails before issuing the bodies this suite must
// inspect) — route by the serialized system prompt, exactly like the e2e fake does.
function recordingClientFactory(bodies: string[]) {
  return (options: AnthropicClientOptions) => {
    const fetch = (async (_url: unknown, init?: { body?: string }) => {
      let delta = 'White Paper';
      if (init?.body) {
        bodies.push(init.body);
        const parsed = JSON.parse(init.body) as { system?: Array<{ text?: string }> };
        // M08.A: the part now rides inside the composed system (mandate first, part
        // last), so match by `includes` rather than `startsWith`.
        const system = parsed.system?.[0]?.text ?? '';
        if (system.includes(PLAN_PROMPT)) {
          delta = JSON.stringify({
            sections: [{ title: 'Core', brief: 'The core themes.' }],
            narrative: 'One arc.',
            illustrations: [],
            palette: 'light',
            typography: 'serif',
          });
        } else if (system.includes(CSS_PROMPT)) {
          // The css part is VALIDATED (M07.C) — a rule-less response fails the run
          // before it would emit the bodies this suite inspects.
          delta = ':root { --t: 1; }';
        }
      }
      return new Response(happyStream(MODEL, delta), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as unknown as typeof globalThis.fetch;
    return createAnthropicClient({ ...options, fetch, maxRetries: 0 });
  };
}

function note(content: string): Note {
  return { id: 'n1', sessionId: 's1', content, createdAt: 1, updatedAt: 1 };
}

const TEMPLATE: GenTemplate = {
  id: SEED_TEMPLATE_ID,
  name: 'Default',
  focusPrompt: FOCUS_PROMPT,
  whitepaperPrompt: 'White Paper prompt',
  isDefault: true,
};

function statefulStore(): {
  saveArtifact: (input: Record<string, unknown>) => GenDocument;
  getLatestArtifact: (sessionId: string, kind: string) => GenDocument | null;
} {
  const saved: GenDocument[] = [];
  return {
    saveArtifact: (input) => {
      const doc = { id: `doc-${saved.length + 1}`, createdAt: 1, ...input } as GenDocument;
      saved.push(doc);
      return doc;
    },
    getLatestArtifact: (_sessionId, kind) =>
      [...saved].reverse().find((d) => d.kind === kind) ?? null,
  };
}

describe('F29 (a) — every SDK request body is read-only-shaped (chat + generation)', () => {
  it('chat: the request body keys are exactly {max_tokens, messages, model, system}', async () => {
    const bodies: string[] = [];
    const service = createLlmService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory: recordingClientFactory(bodies),
      notes: { listNotes: () => [note('We shipped on Friday.')] },
    });

    await service.streamChat(
      { sessionId: 's1', question: 'What did we decide?', model: MODEL },
      { onChunk: () => undefined },
    );

    expect(bodies.length).toBe(1);
    for (const body of bodies) {
      expect(Object.keys(JSON.parse(body)).sort()).toEqual(ALLOWED_BODY_KEYS);
    }
  });

  it('generation (focus → whitepaper → minutes): every request body is read-only-shaped', async () => {
    const bodies: string[] = [];
    const assetReader = {
      listAssets: () => [] as Asset[],
      readImage: () => ({ mediaType: 'image/png' as const, data: 'IMG' }),
    };
    const service = createGenerationService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory: recordingClientFactory(bodies),
      templates: { getTemplate: (id) => (id === SEED_TEMPLATE_ID ? TEMPLATE : null) },
      notes: { listNotes: () => [note('We shipped on Friday.')] },
      assets: assetReader,
      artifacts: statefulStore() as never,
    });

    await service.generateFocus({ sessionId: 's1' }, { onChunk: () => undefined });
    await service.generateWhitepaper({ sessionId: 's1' }, { onChunk: () => undefined });
    await service.generateMinutes({ sessionId: 's1' }, { onChunk: () => undefined });

    expect(bodies.length).toBeGreaterThanOrEqual(3);
    for (const body of bodies) {
      const keys = Object.keys(JSON.parse(body)).sort();
      expect(keys).toEqual(ALLOWED_BODY_KEYS);
      expect(keys).not.toContain('tools');
      expect(keys).not.toContain('tool_choice');
    }
  });
});

/* (b) The literal-absence class guard — mirrors tests/security/env-seams.test.ts. */
const ELECTRON_ROOT = resolve(__dirname, '../../electron');
const TOOL_LITERAL = /\btool_choice\b|\btool_use\b|\btools\b/;

// No SDK call site in electron/ may name a tool surface. Allowlist is intentionally
// empty — adding agentic tool use to this app is a deliberate decision, not a default.
const ALLOWLIST: ReadonlySet<string> = new Set<string>();

function tsSourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...tsSourcesUnder(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

function relKey(absPath: string): string {
  return relative(ELECTRON_ROOT, absPath).split(sep).join('/');
}

describe('F29 (b) — no tool/tool_choice literal at any SDK call site in electron/', () => {
  it('no electron/ source names a tool surface', () => {
    const offenders = tsSourcesUnder(ELECTRON_ROOT)
      .filter((file) => !ALLOWLIST.has(relKey(file)))
      .filter((file) => TOOL_LITERAL.test(readFileSync(file, 'utf8')))
      .map(relKey);

    expect(offenders).toEqual([]);
  });

  it('the matcher actually detects a tool literal (anti-vacuous self-check)', () => {
    expect(TOOL_LITERAL.test('messages.stream({ model, tools: [] })')).toBe(true);
    expect(TOOL_LITERAL.test('tool_choice: { type: "auto" }')).toBe(true);
    expect(TOOL_LITERAL.test('const model = "claude"')).toBe(false);
  });
});
