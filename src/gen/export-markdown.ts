/*
 * The secondary plain-text export (M04.D, ADR-0009). Markdown is the lightweight,
 * screenshot-free companion to the self-contained HTML export — it reduces the
 * generated document to readable text so it pastes anywhere. Screenshots live only in
 * the HTML export (a markdown file can't carry them inline meaningfully).
 *
 * This is a deliberately small reducer: drop the non-content subtrees
 * (<head>/<style>/<script>), map a few structural tags to markdown / line breaks, and
 * keep the text. It walks a real parse5 tree rather than rewriting HTML with regexes —
 * regex tag-stripping is unreliable (an unclosed <script> or a duplicate <head> slips a
 * pattern; CodeQL flags it as "bad HTML filtering"), whereas the parser puts each tag's
 * body inside its element so dropping the subtree drops the content with it. parse5 is
 * already a dependency (ADR-0026). The output is written to a plain-text .md file, not an
 * HTML sink — the renderer DOMPurify + sandbox + CSP (ADR-0010) remain the security layer.
 */
import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

type P5Node = DefaultTreeAdapterMap['node'];
type P5Element = DefaultTreeAdapterMap['element'];
type P5ParentNode = DefaultTreeAdapterMap['parentNode'];

// Subtrees whose text is never content: head metadata, CSS, and scripts. Dropped whole.
const SKIP_SUBTREE: ReadonlySet<string> = new Set(['head', 'style', 'script']);

// Headings open with their markdown prefix; the closing tag adds the line break (BLOCK_END).
const HEADING_PREFIX: Readonly<Record<string, string>> = {
  h1: '\n# ',
  h2: '\n## ',
  h3: '\n### ',
};

// Tags that end a text block → a newline after their children.
const BLOCK_END: ReadonlySet<string> = new Set([
  'p',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'section',
  'tr',
  'article',
]);

// &nbsp; decodes (via parse5) to U+00A0; we normalize it back to a plain space. Built from
// a char code so the source stays ASCII (no literal non-breaking space to trip linting).
const NBSP = new RegExp(String.fromCharCode(0xa0), 'g');

function isElement(node: P5Node): node is P5Element {
  return 'tagName' in node;
}

function hasChildNodes(node: P5Node): node is P5ParentNode {
  return 'childNodes' in node;
}

// parse5 text nodes are already entity-decoded (e.g. &amp; → &), so no manual decode table.
function textValue(node: P5Node): string | null {
  return node.nodeName === '#text' && 'value' in node ? (node.value as string) : null;
}

function walk(node: P5Node, out: string[]): void {
  const text = textValue(node);
  if (text !== null) {
    out.push(text);
    return;
  }

  if (isElement(node)) {
    if (SKIP_SUBTREE.has(node.tagName)) {
      return; // drop the whole subtree — its text never reaches the output
    }
    const prefix = HEADING_PREFIX[node.tagName];
    if (prefix !== undefined) {
      out.push(prefix);
    }
    if (node.tagName === 'br') {
      out.push('\n');
    }
  }

  if (hasChildNodes(node)) {
    for (const child of node.childNodes) {
      walk(child, out);
    }
  }

  if (isElement(node) && BLOCK_END.has(node.tagName)) {
    out.push('\n');
  }
}

export function buildMarkdown(doc: string): string {
  const out: string[] = [];
  walk(parse(doc), out);

  return (
    out
      .join('')
      .replace(NBSP, ' ')
      // Trim each line and collapse runs of blank lines to a single one.
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}
