// Extends Vitest's `expect` with the jest-dom matchers (toBeInTheDocument,
// toHaveClass, …) for the jsdom component suites. Safe to load under the Node
// suites too — it only augments `expect`, it does not require a DOM. React
// Testing Library auto-cleans between tests when Vitest globals are enabled.
import '@testing-library/jest-dom/vitest';

// Pin the test timezone to UTC so any date/locale-dependent output (the "today"-windowed
// usage counter, date grouping, number/cost formatting) is deterministic regardless of the
// developer machine or CI runner — removing a latent flake class. setupFiles execute before
// the test modules load, so this lands before any Date is constructed in a suite.
process.env.TZ = 'UTC';

// jsdom does not implement Element.scrollIntoView; provide a no-op so auto-scroll effects
// (M06.A chat auto-scroll) run without throwing in the component suites. Tests that assert the
// auto-scroll spy on this and restore it.
if (typeof HTMLElement !== 'undefined') {
  HTMLElement.prototype.scrollIntoView = function scrollIntoViewStub(): void {};
}
