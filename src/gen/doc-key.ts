/*
 * A stable identity key for a generated document's HTML (M06.E iframe-paint blocker).
 * GeneratedDocView uses it as the SandboxedHtmlFrame's React `key`, so the iframe REMOUNTS
 * only when the document content actually changes (switching artifacts / a regenerate) and
 * NEVER on an unrelated re-render — a fresh element guarantees a clean srcDoc load and
 * sidesteps the "new srcDoc never re-committed to the live element" race (nexu-io/open-design
 * #1946). It must be: cheap (runs in a memo), stable for identical content, and distinct for
 * different content. Length is mixed in so a hash collision still differs by size.
 */
export function docIdentityKey(html: string): string {
  // djb2 — a small, fast, well-distributed string hash. `| 0` keeps it in 32-bit int range.
  let hash = 5381;
  for (let i = 0; i < html.length; i += 1) {
    hash = ((hash << 5) + hash + html.charCodeAt(i)) | 0;
  }
  return `${html.length}:${hash >>> 0}`;
}
