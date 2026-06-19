// Extends Vitest's `expect` with the jest-dom matchers (toBeInTheDocument,
// toHaveClass, …) for the jsdom component suites. Safe to load under the Node
// suites too — it only augments `expect`, it does not require a DOM. React
// Testing Library auto-cleans between tests when Vitest globals are enabled.
import '@testing-library/jest-dom/vitest';

// jsdom does not implement Element.scrollIntoView; provide a no-op so auto-scroll effects
// (M06.A chat auto-scroll) run without throwing in the component suites. Tests that assert the
// auto-scroll spy on this and restore it.
if (typeof HTMLElement !== 'undefined') {
  HTMLElement.prototype.scrollIntoView = function scrollIntoViewStub(): void {};
}
