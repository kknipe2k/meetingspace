import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  AnthropicClientLike,
  StreamRequest,
  StreamResult,
} from '../../electron/llm/anthropic-client';
import {
  createGenerationService,
  type GenArtifactStore,
} from '../../electron/gen/generation-service';
import {
  CSS_PROMPT,
  DEFAULT_TEMPLATE,
  HTML_PROMPT,
  MINUTES_PROMPT,
  PLAN_PROMPT,
} from '../../electron/gen/prompt-templates';
import { TemplateStore } from '../../electron/gen/template-store';
import { DEFAULT_GENERATION_MODEL } from '@shared/models';
import type { GenDocument, GenTemplate } from '@shared/types';

/*
 * M07.C round 4 — the template model extends to the pipeline prompt parts (plan /
 * css / html) WITHOUT breaking v1 user forks (phase-doc trap: the compat test stays
 * ahead of every restructuring). A v1 fork JSON file carries only {focusPrompt,
 * whitepaperPrompt}: it must still load, and a pipeline run over it must (a) fall
 * back to the FACTORY parts for plan/css/html and (b) keep honoring the fork's
 * whitepaperPrompt as the document mandate — the user's customization still shapes
 * the output, it is not silently orphaned.
 */
const KEY = 'sk-ant-api03-THIS-IS-A-FAKE-TEST-KEY-000';

const V1_FORK = {
  id: 'fork-v1',
  name: 'My v1 fork',
  focusPrompt: 'FORK-FOCUS',
  whitepaperPrompt: 'FORK-MANDATE',
  isDefault: false,
};

const PLAN_1 = JSON.stringify({
  sections: [{ title: 'Only', brief: 'b' }],
  narrative: 'arc',
  illustrations: [],
  palette: 'light',
  typography: 'serif',
});

const DONE: StreamResult = {
  stopReason: 'end_turn',
  usage: { inputTokens: 1, outputTokens: 2 },
  model: DEFAULT_GENERATION_MODEL,
};

function statefulStore(seed: GenDocument[] = []): GenArtifactStore & { saved: GenDocument[] } {
  const saved = [...seed];
  return {
    saved,
    saveArtifact(input): GenDocument {
      const doc = { id: `doc-${saved.length + 1}`, createdAt: 1, ...input } as GenDocument;
      saved.push(doc);
      return doc;
    },
    getLatestArtifact: (_sessionId, kind) =>
      [...saved].reverse().find((d) => d.kind === kind) ?? null,
  };
}

const FOCUS_SEED: GenDocument = {
  id: 'f1',
  sessionId: 's1',
  kind: 'focus',
  content: 'FOCUS DOC',
  templateId: 'fork-v1',
  createdAt: 1,
};

// Routes by the FACTORY part prompts — the fork has no parts of its own, so the
// service must compose the factory plan/css/html prompts around the fork.
function factoryRoutedClient(): { client: AnthropicClientLike; seen: StreamRequest[] } {
  const seen: StreamRequest[] = [];
  const client: AnthropicClientLike = {
    streamMessage(request, onChunk) {
      seen.push(request);
      const sys = request.system ?? '';
      if (sys.startsWith(PLAN_PROMPT)) {
        onChunk(PLAN_1);
      } else if (sys.startsWith(CSS_PROMPT)) {
        onChunk(':root{--f:1}');
      } else if (sys.startsWith(HTML_PROMPT)) {
        onChunk('<h2>Only</h2><p>Body.</p>');
      } else {
        return Promise.reject(new Error(`unexpected system: ${sys.slice(0, 40)}`));
      }
      return Promise.resolve(DONE);
    },
  };
  return { client, seen };
}

const tempDirs: string[] = [];

function forkFileWith(content: unknown): TemplateStore {
  const dir = mkdtempSync(join(tmpdir(), 'ms-tmpl-'));
  tempDirs.push(dir);
  const file = join(dir, 'templates.json');
  writeFileSync(file, JSON.stringify(content), 'utf8');
  return new TemplateStore(file, () => 'new-id');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('factory prompt parts', () => {
  it('ships plan/css/html factory prompts on the virtual seed', () => {
    expect(typeof PLAN_PROMPT).toBe('string');
    expect(typeof CSS_PROMPT).toBe('string');
    expect(typeof HTML_PROMPT).toBe('string');
    // The plan part demands strict JSON; the html part is the body-only mandate
    // (necessary, not sufficient; the validator + sanitize layers enforce).
    expect(PLAN_PROMPT).toMatch(/json/i);
    expect(HTML_PROMPT).toMatch(/body/i);
    // IRL fix #3 — size discipline restored (calibration: v1 docs 42–50 KB, the first
    // round-4 real runs 96–101 KB with a 41 KB stylesheet truncating at the ceiling):
    // the css part regains the v1 "under 400 lines" bound; the plan steers 4–6
    // sections (the cap-10 backstop stays).
    expect(CSS_PROMPT).toMatch(/under 400 lines/i);
    expect(PLAN_PROMPT).toMatch(/typically 4(–|-)6/i);
    expect(DEFAULT_TEMPLATE.planPrompt).toBe(PLAN_PROMPT);
    expect(DEFAULT_TEMPLATE.cssPrompt).toBe(CSS_PROMPT);
    expect(DEFAULT_TEMPLATE.htmlPrompt).toBe(HTML_PROMPT);
    expect(DEFAULT_TEMPLATE.minutesPrompt).toBe(MINUTES_PROMPT);
  });
});

describe('v1 fork compat (TemplateStore)', () => {
  it('loads a v1-shape fork file unchanged (no new-part fields required)', () => {
    const store = forkFileWith([V1_FORK]);
    expect(store.getTemplate('fork-v1')).toMatchObject({
      id: 'fork-v1',
      focusPrompt: 'FORK-FOCUS',
      whitepaperPrompt: 'FORK-MANDATE',
    });
  });

  it('loads a fork that DOES carry the new optional parts', () => {
    const store = forkFileWith([
      {
        ...V1_FORK,
        id: 'fork-v2',
        planPrompt: 'P2',
        cssPrompt: 'C2',
        htmlPrompt: 'H2',
        minutesPrompt: 'M2',
      },
    ]);
    expect(store.getTemplate('fork-v2')).toMatchObject({
      planPrompt: 'P2',
      cssPrompt: 'C2',
      htmlPrompt: 'H2',
      minutesPrompt: 'M2',
    });
  });
});

describe('v1 fork compat (pipeline run)', () => {
  it('a pipeline run over a v1 fork uses the FACTORY parts and keeps the fork mandate in play', async () => {
    const { client, seen } = factoryRoutedClient();
    const artifacts = statefulStore([FOCUS_SEED]);
    const service = createGenerationService({
      keyStore: { getKeyForMain: () => KEY },
      clientFactory: () => client,
      templates: { getTemplate: (id) => (id === 'fork-v1' ? (V1_FORK as GenTemplate) : null) },
      notes: { listNotes: () => [] },
      assets: { listAssets: () => [], readImage: () => ({ mediaType: 'image/png', data: 'I' }) },
      artifacts,
    });

    await service.generateWhitepaper(
      { sessionId: 's1', templateId: 'fork-v1' },
      { onChunk: () => undefined },
    );

    // The run completed over factory parts (plan + css + html = 3 calls)...
    expect(seen).toHaveLength(3);
    // ...and every pipeline call still carries the FORK's whitepaperPrompt as the
    // document mandate — the v1 customization is not orphaned.
    for (const r of seen) {
      expect(r.system).toContain('FORK-MANDATE');
    }
    expect(artifacts.saved.some((d) => d.kind === 'whitepaper')).toBe(true);
  });
});
