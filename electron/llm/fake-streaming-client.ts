import type {
  AnthropicClientLike,
  ChunkHandler,
  StreamRequest,
  StreamResult,
} from './anthropic-client';
import { CSS_PROMPT, HTML_PROMPT, PLAN_PROMPT } from '../gen/prompt-templates';

/*
 * The e2e mocked-SDK seam (M03.C). main.ts swaps the real Anthropic client for this
 * canned-stream fake ONLY when MEETINGSPACE_FAKE_LLM=1 AND the build is unpackaged
 * (see main.ts) — so the chat e2e exercises the real grounding + IPC path with NO
 * live key, NO network, and NO Anthropic SDK import. It deliberately does NOT import
 * the Anthropic SDK package (a unit test asserts the import literal is absent), so
 * even if the env flag were set in a shipped build it could neither read the user's
 * key nor reach the network — it can only emit canned text. The real key is never
 * wired into this path (main.ts injects a fake key reader alongside it).
 */
const CANNED_DELTAS = ['Based on your notes, ', 'here is what I found.'];

// Zero params (it ignores apiKey/fetch by design) — still assignable to
// AnthropicClientFactory, which the service calls with { apiKey }.
export function createFakeStreamingClient(): AnthropicClientLike {
  return {
    streamMessage(request: StreamRequest, onChunk: ChunkHandler): Promise<StreamResult> {
      for (const delta of CANNED_DELTAS) {
        onChunk(delta);
      }
      const result: StreamResult = {
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0 },
        // Echo the requested model so the chat shows which model answered (M03.D).
        model: request.model,
      };
      return Promise.resolve(result);
    },
  };
}

// Concatenate the text blocks of the user turn — for the gen fake to reflect the
// corpus (Part 1) / the FOCUS doc (Part 2) back into its canned output.
function userText(request: StreamRequest): string {
  return request.messages
    .flatMap((message) => message.content)
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/*
 * The e2e mocked-SDK seam for DOCUMENT GENERATION (M04.B). Same gating as chat
 * (MEETINGSPACE_FAKE_LLM=1 AND unpackaged — see main.ts): no live key, no network,
 * no Anthropic SDK import. It distinguishes the two prompt parts by the system
 * prompt (Part 2's white-paper prompt contains "White Paper"):
 *   - Part 1 (FOCUS): echoes the corpus text so a planted <script> in a note flows
 *     into the persisted FOCUS doc, then on into Part 2 — exercising the real
 *     untrusted-content path end to end.
 *   - Part 2 (white paper): emits a self-contained HTML document that EMBEDS that
 *     FOCUS text AND its own <script>/onerror handlers — exactly the hostile output
 *     the sanitizer must strip and the sandbox must neutralize. The e2e proves none
 *     of it executes.
 */
// M07.C fix #4 e2e seam: `failMode: 'css'` makes the CSS route return rule-less prose,
// so the run fails typed with "Styling the document failed — stylesheet validation."
// — letting the e2e pin BOTH failure surfaces (the modal's role="alert" block when
// open; the app-level error toast when closed) with no live key. Gated exactly like
// the delay: main reads the env via the gated accessor, unpackaged builds only.
export function createFakeGenerationClient(delayMs = 0, failMode = ''): AnthropicClientLike {
  // M07.B e2e seam: `delayMs` optionally holds each stream open so a live-run window is
  // observable (the synchronous fake would otherwise settle before Playwright could look).
  // main.ts reads the gated env and passes it; 0 keeps the deterministic synchronous
  // behavior every other test relies on. The env read stays in main (Electron context).
  const finish = async (result: StreamResult): Promise<StreamResult> => {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return result;
  };
  return {
    streamMessage(request: StreamRequest, onChunk: ChunkHandler): Promise<StreamResult> {
      const done: StreamResult = {
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0 },
        model: request.model,
      };
      const system = request.system ?? '';

      // M07.C round-4 pipeline calls — routed by the FACTORY part prompts. M08.A flips
      // the composition to `<document_mandate>…</document_mandate>\n\n
      // <non_negotiable_output_contract>\n<part>…`, so the part rides INSIDE the system
      // and we match by `includes` (not startsWith). Checked FIRST so the pipeline routes
      // win before the single-call minutes/whitepaper fallbacks below.
      if (system.includes(PLAN_PROMPT)) {
        onChunk(
          JSON.stringify({
            sections: [
              { title: 'Core Elements', brief: 'The session’s core concepts.' },
              { title: 'Tactical Roadmap', brief: 'The actionable next steps.' },
            ],
            narrative: 'Open with the core concepts, close with the roadmap.',
            illustrations: [
              {
                name: 'Core Callout',
                type: 'callout',
                classNames: ['callout', 'focus-source'],
                structure: 'an accent-bordered key insight',
              },
            ],
            palette: 'light surface, indigo accent',
            typography: 'serif body, sans headings',
          }),
        );
        return finish(done);
      }
      if (system.includes(CSS_PROMPT)) {
        if (failMode === 'css') {
          // Rule-less prose — fails extractCss validation on both attempts.
          onChunk('I am unable to produce a stylesheet for this document right now.');
          return finish(done);
        }
        // Deliberately FENCED (the real-run model behavior behind the M07.C IRL fail)
        // so the e2e proves the pipeline unwraps it AND the computed-style assertion
        // proves the theme is EFFECTIVE in the rendered frame. Defines every plan
        // class (subset guard #1 passes on the happy path).
        onChunk(
          '```css\n:root{--accent:#5e6ad2;}\n.callout{border-left:4px solid var(--accent);padding:.5rem;}\n.focus-source{white-space:pre-wrap;}\n```',
        );
        return finish(done);
      }
      if (system.includes(HTML_PROMPT)) {
        // The complete BODY (no shell, no css) that EMBEDS the FOCUS context AND
        // hostile script/onerror vectors — the sanitize + sandbox layers must keep
        // the stitched document inert end to end (the e2e asserts no GEN_XSS). Uses
        // ONLY the stylesheet's classes (subset guard #2 passes on the happy path).
        const context = userText(request);
        onChunk(
          [
            '<h2>Chunked Section</h2>',
            '<script>window.parent.postMessage("GEN_XSS","*")</script>',
            '<div class="callout">Illustration: Core Elements</div>',
            `<pre class="focus-source">${context}</pre>`,
            '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" onerror="window.parent.postMessage(\'GEN_XSS\',\'*\')" alt="diagram" />',
          ].join(''),
        );
        return finish(done);
      }

      // Minutes (M04.C): a self-contained HTML minutes doc — also carries a hostile
      // <script>/onerror so the sandbox + sanitize path is exercised for minutes too.
      const isMinutes = request.system?.includes('Meeting Minutes') ?? false;
      if (isMinutes) {
        const corpus = userText(request);
        const html = [
          '<!doctype html><html lang="en"><head><meta charset="utf-8" />',
          '<style>:root{--accent:#5e6ad2;}table{border-collapse:collapse;}td{border:1px solid #ddd;padding:.3rem;}</style>',
          '<script>window.parent.postMessage("GEN_XSS","*")</script>',
          '</head><body>',
          '<h1>Meeting Minutes</h1>',
          '<h2>Decisions</h2>',
          `<pre class="minutes-source">${corpus}</pre>`,
          "<h2>Action Items</h2><table><tr><td>—</td><td onerror=\"window.parent.postMessage('GEN_XSS','*')\">Follow up</td></tr></table>",
          '</body></html>',
        ].join('');
        onChunk(html);
        return finish({
          stopReason: 'end_turn',
          usage: { inputTokens: 0, outputTokens: 0 },
          model: request.model,
        });
      }

      const isWhitepaper = request.system?.includes('White Paper') ?? false;
      if (isWhitepaper) {
        const focus = userText(request);
        const html = [
          '<!doctype html><html lang="en"><head><meta charset="utf-8" />',
          '<style>:root{--accent:#5e6ad2;}.callout{border-left:4px solid var(--accent);padding:.5rem;}</style>',
          '<script>window.parent.postMessage("GEN_XSS","*")</script>',
          '</head><body>',
          '<h1>Strategy White Paper</h1>',
          '<section class="callout">Illustration 1: Core Elements</section>',
          `<pre class="focus-source">${focus}</pre>`,
          // A 1x1 data-URI image carrying an onerror XSS vector. The sanitizer
          // strips the handler; the self-contained src means no broken-resource
          // load (no console noise) whether the data: src survives or is dropped.
          '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" onerror="window.parent.postMessage(\'GEN_XSS\',\'*\')" alt="diagram" />',
          '</body></html>',
        ].join('');
        onChunk(html);
      } else {
        onChunk('FOCUS document\n\n');
        onChunk(userText(request));
      }
      return finish({
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0 },
        model: request.model,
      });
    },
  };
}
