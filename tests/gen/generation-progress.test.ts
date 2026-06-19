import { describe, expect, it } from 'vitest';

import type {
  AnthropicClientLike,
  StreamRequest,
  StreamResult,
} from '../../electron/llm/anthropic-client';
import type { CorpusAssetReader, CorpusNoteReader } from '../../electron/gen/corpus';
import {
  createGenerationService,
  type GenArtifactStore,
} from '../../electron/gen/generation-service';
import { DEFAULT_GENERATION_MODEL } from '@shared/models';
import type { GenDocument, GenProgress, GenTemplate, Note } from '@shared/types';

/*
 * Generation progress (M04.C two-phase → M07.C round-4 fixed 4-step). A FRESH
 * white-paper run walks focus 1/4 → plan 2/4 → css 3/4 → html 4/4 (the css-patch
 * remediation, when it fires, stays inside step 4 — no fifth step); the doc carries
 * NO JavaScript by design (the no-scripts security mandate), so NO emitted progress
 * label may imply a JS/scripting step — the labels live ON the events (authored
 * main-side), so the no-JS invariant is pinned over every label a run actually emits.
 */
const KEY = 'sk-ant-api03-FAKE-PROGRESS-KEY';

function note(content: string): Note {
  return { id: 'n1', sessionId: 's1', content, createdAt: 1, updatedAt: 1 };
}

const TEMPLATE = {
  id: 'default',
  name: 'Default',
  focusPrompt: 'FOCUS SYSTEM',
  whitepaperPrompt: 'MANDATE',
  planPrompt: 'PLAN-SYS',
  cssPrompt: 'CSS-SYS',
  htmlPrompt: 'HTML-SYS',
  isDefault: true,
} as GenTemplate;

const PLAN_JSON = JSON.stringify({
  sections: [{ title: 'Core', brief: 'The core themes.' }],
  narrative: 'One arc.',
  illustrations: [{ name: 'Grid', type: 'grid', classNames: ['panel'], structure: '2x2' }],
  palette: 'light',
  typography: 'serif',
});

// Stateful artifact store: getLatestArtifact returns the most recently saved doc of
// a kind, so generateWhitepaper's internal Part 1 -> pipeline handoff works end to end.
function statefulArtifacts(): GenArtifactStore {
  const saved: GenDocument[] = [];
  return {
    saveArtifact(input) {
      const doc: GenDocument = { id: `doc-${saved.length + 1}`, createdAt: 1, ...input };
      saved.push(doc);
      return doc;
    },
    getLatestArtifact(sessionId, kind) {
      for (let i = saved.length - 1; i >= 0; i -= 1) {
        const doc = saved[i];
        if (doc && doc.sessionId === sessionId && doc.kind === kind) {
          return doc;
        }
      }
      return null;
    },
  };
}

// Routes the pipeline calls by their composed system prompts (part marker leads).
function pipelineFake(): AnthropicClientLike {
  const result: StreamResult = {
    stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 2 },
    model: DEFAULT_GENERATION_MODEL,
  };
  return {
    streamMessage: (request: StreamRequest, onChunk) => {
      const sys = request.system ?? '';
      if (sys.startsWith('PLAN-SYS')) {
        onChunk(PLAN_JSON);
      } else if (sys.startsWith('CSS-SYS')) {
        onChunk(':root{--p:1}\n.panel{border:1px solid}');
      } else if (sys.startsWith('HTML-SYS')) {
        onChunk('<h2>Core</h2><div class="panel">Body.</div>');
      } else {
        onChunk('FOCUS doc');
      }
      return Promise.resolve(result);
    },
  };
}

const notes: CorpusNoteReader = { listNotes: () => [note('We shipped on Friday.')] };
const assets: CorpusAssetReader = { listAssets: () => [], readImage: () => null };

describe('generation progress (fixed 4-step pipeline)', () => {
  it('a FRESH white-paper run walks focus 1/4 → plan 2/4 → css 3/4 → html 4/4', async () => {
    const service = createGenerationService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory: pipelineFake,
      templates: { getTemplate: () => TEMPLATE },
      notes,
      assets,
      artifacts: statefulArtifacts(),
    });

    const steps: GenProgress[] = [];
    await service.generateWhitepaper(
      { sessionId: 's1' },
      { onChunk: () => undefined, onProgress: (p) => steps.push(p) },
    );

    expect(steps.map((p) => p.step)).toEqual(['focus', 'plan', 'css', 'html']);
    expect(steps.map((p) => p.index)).toEqual([1, 2, 3, 4]);
    expect(steps.every((p) => p.total === 4)).toBe(true);
  });

  it('never emits a "JS"/scripting label (the generated doc has no scripts)', async () => {
    const service = createGenerationService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory: pipelineFake,
      templates: { getTemplate: () => TEMPLATE },
      notes,
      assets,
      artifacts: statefulArtifacts(),
    });

    const steps: GenProgress[] = [];
    await service.generateWhitepaper(
      { sessionId: 's1' },
      { onChunk: () => undefined, onProgress: (p) => steps.push(p) },
    );
    await service.generateMinutes(
      { sessionId: 's1' },
      { onChunk: () => undefined, onProgress: (p) => steps.push(p) },
    );

    // Every step + label a run actually emits must be free of any JavaScript/
    // scripting wording. Adding a `js` step (the mutation) breaks this.
    expect(steps.length).toBeGreaterThanOrEqual(5);
    for (const p of steps) {
      expect(p.step).not.toMatch(/\bjs\b|javascript|script/i);
      expect(p.label).not.toMatch(/\bjs\b|javascript|script/i);
    }
  });
});
