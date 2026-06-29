import { parse, serialize } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

import { fragmentViolation } from './assembly';

/*
 * The parse5-backed HTML normalizer (M08.A; ADR-0026). Main-process structural recovery
 * for model HTML that carries a document shell where a body-level fragment was expected.
 * It EXTRACTS the body's children and serializes them deterministically — it NEVER
 * sanitizes and NEVER emits a shell. The renderer DOMPurify + sandbox + CSP (ADR-0010)
 * remain the load-bearing security layer; this seam only feeds them a clean fragment
 * instead of hard-failing recoverable output. No model doctype/<html>/<head>/<style> is
 * ever adopted into the final document.
 *
 * COMPLETENESS ≠ a successful parse (load-bearing): parse5 deliberately repairs
 * malformed/truncated HTML, so a successful parse is NOT proof the model output was
 * complete. Callers MUST reject `stopReason === 'max_tokens'` BEFORE calling this (a
 * truncated response must hard-fail, never be repaired into apparent success); an empty
 * normalized body is rejected here; a fragment that still carries a shell is refused as
 * ambiguous rather than emitted.
 */

type P5Node = DefaultTreeAdapterMap['node'];
type P5Element = DefaultTreeAdapterMap['element'];
type P5ParentNode = DefaultTreeAdapterMap['parentNode'];
type P5Document = DefaultTreeAdapterMap['document'];

export type NormalizeReason = 'empty' | 'unparseable' | 'ambiguous';

export type NormalizeResult =
  | { readonly ok: true; readonly fragment: string }
  | { readonly ok: false; readonly reason: NormalizeReason };

function isElement(node: P5Node): node is P5Element {
  return 'tagName' in node;
}

function hasChildNodes(node: P5Node): node is P5ParentNode {
  return 'childNodes' in node;
}

function findFirstElement(node: P5Node, tagName: string): P5Element | null {
  if (isElement(node) && node.tagName === tagName) {
    return node;
  }
  if (hasChildNodes(node)) {
    for (const child of node.childNodes) {
      const found = findFirstElement(child, tagName);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

// Discard <style> nodes anywhere in the subtree — model CSS the app never adopts (the
// css pipeline step owns the single stylesheet). Mutates in place before serialization.
function stripStyleNodes(parent: P5ParentNode): void {
  parent.childNodes = parent.childNodes.filter((child) => {
    if (isElement(child) && child.tagName === 'style') {
      return false;
    }
    if (hasChildNodes(child)) {
      stripStyleNodes(child);
    }
    return true;
  });
}

/**
 * Extract the body-level fragment from a model document. Returns the serialized body
 * children with model doctype/<html>/<head>/<style> discarded, or a typed reason for
 * the caller to hard-fail (empty / unparseable / ambiguous). NEVER sanitizes, NEVER
 * emits a shell. The fragment then flows through the existing assembly + renderer
 * sanitizer unchanged.
 */
export function normalizeBodyFragment(html: string): NormalizeResult {
  let body: P5Element | null;
  try {
    const document = parse(html);
    body = findFirstElement(document, 'body');
  } catch {
    /* v8 ignore next -- parse5.parse() does not throw on string input; defensive only (gates.md M08 baseline) */
    return { ok: false, reason: 'unparseable' };
  }
  if (body === null) {
    return { ok: false, reason: 'unparseable' };
  }

  stripStyleNodes(body);
  const fragment = serialize(body).trim();
  if (fragment.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  // Defense-in-depth: the extracted fragment must itself be shell-free. parse5 hoists
  // duplicate/misplaced shells into one body, so this should not trip in practice — if
  // it does, the structure is ambiguous and we refuse rather than emit a shell-bearing
  // "fragment". The renderer sanitizer remains the security control regardless.
  if (fragmentViolation(fragment) !== null) {
    return { ok: false, reason: 'ambiguous' };
  }
  return { ok: true, fragment };
}

/*
 * M08.B — the MINUTES normalization mode (ADR-0026). Minutes are a SINGLE self-contained
 * <html> document (unlike the white paper's body-level fragment), so this seam KEEPS one
 * document shell and at most one head stylesheet rather than extracting a body fragment —
 * and it is deliberately NOT routed through fragmentViolation (a full <html> minutes doc
 * is valid, not a shell violation). parse5 hoists duplicate/misplaced <html>/<head>/<body>
 * into a single tree (that IS the "one shell" normalization). It strips categorically-
 * prohibited constructs structurally (all scripts/handlers/iframes/forms/links/@import — the
 * contract bans them outright, so no per-URL safety judgment is made here; URL-level safety
 * stays with the renderer DOMPurify + sandbox + CSP, ADR-0010). Completeness is judged
 * independently of a successful parse (parse5 repairs): the caller rejects max_tokens BEFORE
 * calling this; an empty normalized body is rejected here; a prohibited construct that
 * SURVIVED the structural strip (e.g. smuggled inside <template> content, which parse5 keeps
 * out of the child tree) is refused as ambiguous rather than persisted.
 */

export type MinutesNormalizeReason = 'empty' | 'unparseable' | 'ambiguous';

export type MinutesNormalizeResult =
  | { readonly ok: true; readonly document: string }
  | { readonly ok: false; readonly reason: MinutesNormalizeReason };

// Whole-response markdown fence around a complete HTML document (mirrors chunk-plan's FENCE).
const ENCLOSING_FENCE = /^\s*```[a-z]*\s*\n?([\s\S]*?)\n?\s*```\s*$/i;

// Categorically-prohibited ELEMENTS — the minutes contract bans them outright, so they are
// removed structurally (not judged). <style> is handled separately (keep at most one head one).
const PROHIBITED_TAGS: ReadonlySet<string> = new Set([
  'script',
  'iframe',
  'form',
  'object',
  'embed',
  'link',
]);

// Post-normalization re-scan: a prohibited element that survived the child-tree strip (only
// reachable via <template> content, which parse5 holds in a separate fragment) means the
// structure is ambiguous — refuse rather than emit it. Tag-boundary matched so element names
// that merely begin with a prohibited name are not flagged.
const SURVIVING_PROHIBITED = /<(script|iframe|form|object|embed|link)(?=[\s/>])/i;

function stripEventHandlerAttrs(el: P5Element): void {
  if (Array.isArray(el.attrs)) {
    el.attrs = el.attrs.filter((attr) => !/^on/i.test(attr.name));
  }
}

// Drop @import rules from a kept <style> block's text (no external stylesheets — ADR-0013).
// A <style> element always carries a childNodes array (its CSS text node), so no guard.
function stripStyleImports(styleEl: P5Element): void {
  for (const child of styleEl.childNodes) {
    if ('value' in child && typeof child.value === 'string') {
      child.value = child.value.replace(/@import[^;]*;?/gi, '');
    }
  }
}

export function normalizeMinutesDocument(html: string): MinutesNormalizeResult {
  const unfenced = (() => {
    const match = ENCLOSING_FENCE.exec(html.trim());
    return match?.[1] ?? html;
  })();

  let document: P5Document;
  try {
    document = parse(unfenced);
  } catch {
    /* v8 ignore next -- parse5.parse() does not throw on string input; defensive only (gates.md M08 baseline) */
    return { ok: false, reason: 'unparseable' };
  }

  const body = findFirstElement(document, 'body');
  if (body === null) {
    // No <body> to normalize (e.g. a frameset document) — refuse rather than emit anything.
    return { ok: false, reason: 'unparseable' };
  }

  // Keep at most ONE stylesheet, and only one that lives in <head>; strip prohibited
  // elements and inline event-handler attributes structurally through the whole tree.
  let keptHeadStyle = false;
  const clean = (node: P5ParentNode, inHead: boolean): void => {
    node.childNodes = node.childNodes.filter((child) => {
      if (isElement(child)) {
        if (PROHIBITED_TAGS.has(child.tagName)) {
          return false;
        }
        if (child.tagName === 'style') {
          if (inHead && !keptHeadStyle) {
            keptHeadStyle = true;
            stripStyleImports(child);
          } else {
            return false; // a second head style, or any style outside <head>
          }
        }
        stripEventHandlerAttrs(child);
      }
      if (hasChildNodes(child)) {
        clean(child, inHead || (isElement(child) && child.tagName === 'head'));
      }
      return true;
    });
  };
  clean(document, false);

  // Meaningful body content is required AFTER the strip — a body of only prohibited/
  // discarded nodes (or whitespace) is empty, never persisted (completeness ≠ a parse).
  if (serialize(body).trim().length === 0) {
    return { ok: false, reason: 'empty' };
  }

  // Emit exactly one app-normalized doctype + the single (merged) document shell. Drop any
  // model doctype / stray top-level nodes so the serialized output carries one clean shell.
  document.childNodes = document.childNodes.filter((node) => isElement(node));
  const out = `<!doctype html>${serialize(document)}`;

  // A prohibited element that survived the structural strip (template-smuggled) means we
  // cannot emit safely — refuse as ambiguous (the renderer sanitizer would also strip it,
  // but main-side we never persist a script/iframe-bearing document).
  if (SURVIVING_PROHIBITED.test(out)) {
    return { ok: false, reason: 'ambiguous' };
  }

  return { ok: true, document: out };
}
