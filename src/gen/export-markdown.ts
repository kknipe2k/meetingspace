/*
 * The secondary plain-text export (M04.D, ADR-0009). Markdown is the lightweight,
 * screenshot-free companion to the self-contained HTML export — it reduces the
 * generated document to readable text so it pastes anywhere. Screenshots live only in
 * the HTML export (a markdown file can't carry them inline meaningfully).
 *
 * This is a deliberately small, dependency-free reducer: drop the non-content blocks
 * (<head>/<style>/<script>), map a few structural tags to markdown / line breaks, strip
 * the remaining tags, and decode the common entities. It is NOT a general HTML→markdown
 * engine — the generated docs are well-formed and structurally simple.
 */
const ENTITIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&nbsp;/gi, ' '],
  [/&amp;/gi, '&'],
  [/&lt;/gi, '<'],
  [/&gt;/gi, '>'],
  [/&quot;/gi, '"'],
  [/&#39;/gi, "'"],
];

export function buildMarkdown(doc: string): string {
  let text = doc
    // Non-content blocks first (so their innards never leak into the text).
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    // Headings → markdown.
    .replace(/<h1[^>]*>/gi, '\n# ')
    .replace(/<h2[^>]*>/gi, '\n## ')
    .replace(/<h3[^>]*>/gi, '\n### ')
    // Block ends → line breaks.
    .replace(/<\/(p|div|h[1-6]|li|section|tr|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Everything else: drop the tag, keep the text.
    .replace(/<[^>]+>/g, '');

  for (const [pattern, replacement] of ENTITIES) {
    text = text.replace(pattern, replacement);
  }

  // Trim each line and collapse runs of blank lines to a single one.
  return text
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
