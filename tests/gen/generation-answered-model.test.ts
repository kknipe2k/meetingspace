import { describe, expect, it, vi } from 'vitest';

import type { AnthropicClientLike } from '../../electron/llm/anthropic-client';
import type { CorpusAssetReader, CorpusNoteReader } from '../../electron/gen/corpus';
import {
  createGenerationService,
  type GenArtifactStore,
  type GenTemplateReader,
} from '../../electron/gen/generation-service';
import type { Asset, GenDocument, GenTemplate, Note } from '@shared/types';

/*
 * The generated-doc badge + usage row reflect the model the API ACTUALLY ANSWERED WITH
 * (result.model), NOT the requested/selected id — matching chat (llm-service records result.model).
 * This is what makes a corporate gateway's model SUBSTITUTION visible: the user picks a known model
 * (here 'claude-opus-4-8', which passes main-side validation and IS sent), the gateway serves
 * something else ('gateway-claude-3-5-sonnet'), and the persisted artifact (the badge source) plus
 * the usage record carry what the gateway returned — never the dropdown selection.
 *
 * Mutation check: persist the requested `model` instead of `result.model` and every assertion below
 * flips to the requested id — i.e. the badge would silently mask the substitution.
 */
const KEY = 'sk-ant-api03-THIS-IS-A-FAKE-TEST-KEY-000';

// The user's selection — a KNOWN catalog model, so it passes validation and is the id we SEND…
const REQUESTED = 'claude-opus-4-8';
// …and what the gateway actually answers AS (an id the app's catalog doesn't know — the raw shape).
const GATEWAY_ACTUAL = 'gateway-claude-3-5-sonnet';

// One template carrying every prompt part, with short distinct markers so the scripted client can
// route each pipeline call by its (composed) system prompt.
const TEMPLATE = {
  id: 'tmpl',
  name: 'T',
  focusPrompt: 'FOCUS-SYS',
  whitepaperPrompt: 'MANDATE',
  planPrompt: 'PLAN-SYS',
  cssPrompt: 'CSS-SYS',
  htmlPrompt: 'HTML-SYS',
  minutesPrompt: 'MINUTES-SYS',
  isDefault: false,
} as GenTemplate;

// Plan/css/body authored to AGREE (plan classes ⊆ css; body classes ⊆ css) so the whitepaper
// pipeline reaches the final persist without a styling retry/patch.
const PLAN_JSON = JSON.stringify({
  sections: [{ title: 'Introduction', brief: 'Set the stage' }],
  narrative: 'Open with stakes, close with action.',
  illustrations: [
    {
      name: 'Pattern Ladder',
      type: 'ladder',
      classNames: ['callout', 'ladder', 'rung'],
      structure: '4 rungs',
    },
  ],
  palette: 'light',
  typography: 'serif',
});
const GOOD_CSS =
  ':root{--x:1}\n.ladder{display:grid}\n.rung{border:1px solid}\n.callout{border-left:4px solid}';
const BODY = [
  '<h2>Introduction</h2>',
  '<div class="callout">Key point</div>',
  '<div class="ladder"><span class="rung">P1</span></div>',
  '<p>Done.</p>',
].join('');

function note(content: string): Note {
  return { id: 'n1', sessionId: 's1', content, createdAt: 1, updatedAt: 1 };
}
const notes: CorpusNoteReader = { listNotes: () => [note('We shipped on Friday.')] };
const assets: CorpusAssetReader = { listAssets: () => [] as Asset[], readImage: () => null };
const templates: GenTemplateReader = {
  getTemplate: (id) => (id === TEMPLATE.id ? TEMPLATE : null),
};

function statefulStore(seed: GenDocument[] = []): GenArtifactStore & { saved: GenDocument[] } {
  const saved = [...seed];
  return {
    saved,
    saveArtifact(input): GenDocument {
      const doc = {
        id: `doc-${saved.length + 1}`,
        createdAt: saved.length + 1,
        ...input,
      } as GenDocument;
      saved.push(doc);
      return doc;
    },
    getLatestArtifact: (_s, kind) => [...saved].reverse().find((d) => d.kind === kind) ?? null,
  };
}

// Answers with GATEWAY_ACTUAL regardless of the requested model (the substitution), routing each
// step by its (composed) system prompt.
function gatewayClient(): AnthropicClientLike {
  return {
    streamMessage(request, onChunk) {
      const sys = request.system ?? '';
      const reply = (text: string) => {
        onChunk(text);
        return Promise.resolve({
          stopReason: 'end_turn' as const,
          usage: { inputTokens: 1, outputTokens: 2 },
          model: GATEWAY_ACTUAL,
        });
      };
      if (sys.includes('FOCUS-SYS')) return reply('FOCUS DOC');
      if (sys.includes('PLAN-SYS')) return reply(PLAN_JSON);
      if (sys.includes('CSS-SYS')) return reply(GOOD_CSS);
      if (sys.includes('HTML-SYS')) return reply(BODY);
      if (sys.includes('MINUTES-SYS')) return reply('<h1>Minutes</h1>');
      return Promise.reject(new Error(`unexpected system: ${sys.slice(0, 24)}`));
    },
  };
}

function service(artifacts: GenArtifactStore, usage: { record: ReturnType<typeof vi.fn> }) {
  return createGenerationService({
    keyStore: { getKeyForMain: () => KEY },
    clientFactory: () => gatewayClient(),
    templates,
    notes,
    assets,
    artifacts,
    usage,
  });
}

describe('generated-doc model comes from the API output, not the dropdown selection', () => {
  it('focus: persists + records the answered model, not the requested one', async () => {
    const artifacts = statefulStore();
    const usage = { record: vi.fn() };
    await service(artifacts, usage).generateFocus(
      { sessionId: 's1', templateId: TEMPLATE.id, model: REQUESTED },
      { onChunk: () => undefined },
    );

    const focus = artifacts.saved.find((d) => d.kind === 'focus');
    expect(focus?.model).toBe(GATEWAY_ACTUAL);
    expect(focus?.model).not.toBe(REQUESTED);
    expect(usage.record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'focus', model: GATEWAY_ACTUAL }),
    );
  });

  it('minutes: persists + records the answered model, not the requested one', async () => {
    const artifacts = statefulStore();
    const usage = { record: vi.fn() };
    await service(artifacts, usage).generateMinutes(
      { sessionId: 's1', templateId: TEMPLATE.id, model: REQUESTED },
      { onChunk: () => undefined },
    );

    const minutes = artifacts.saved.find((d) => d.kind === 'minutes');
    expect(minutes?.model).toBe(GATEWAY_ACTUAL);
    expect(minutes?.model).not.toBe(REQUESTED);
    expect(usage.record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'minutes', model: GATEWAY_ACTUAL }),
    );
  });

  it('whitepaper: persists + records the answered model across the pipeline', async () => {
    // Seed a FOCUS doc so the pipeline runs plan → css → html directly (no Part-1 call).
    const seed: GenDocument = {
      id: 'f1',
      sessionId: 's1',
      kind: 'focus',
      content: 'FOCUS',
      templateId: TEMPLATE.id,
      createdAt: 1,
    };
    const artifacts = statefulStore([seed]);
    const usage = { record: vi.fn() };
    await service(artifacts, usage).generateWhitepaper(
      { sessionId: 's1', templateId: TEMPLATE.id, model: REQUESTED },
      { onChunk: () => undefined },
    );

    const whitepaper = artifacts.saved.find((d) => d.kind === 'whitepaper');
    expect(whitepaper?.model).toBe(GATEWAY_ACTUAL);
    expect(whitepaper?.model).not.toBe(REQUESTED);
    expect(usage.record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'whitepaper', model: GATEWAY_ACTUAL }),
    );
  });
});
