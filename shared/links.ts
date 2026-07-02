/*
 * Canonical external links shared by both processes (M10.B ext#2, ADR-0027). A URL is NOT a price,
 * so importing this in a renderer component is guard-legal (unlike CHAT_MODELS/PRICING_AS_OF). The
 * pricing-docs link is the sole `shell.openExternal` target of the argument-less `app:open-pricing-docs`
 * channel — the renderer can display it, but only main opens it (the deny-all window-open policy
 * forbids window.open / target=_blank), and the handler ignores any renderer-supplied URL.
 *
 * Anthropic's live pricing page (per the claude-api reference live-sources).
 */
export const ANTHROPIC_PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing';
