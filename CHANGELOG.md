# Changelog — MeetingSpace

Notable changes, newest first.

## 1.3.3 — 2026-06-29

- **Cleaner Window menu:** the native **Window** menu no longer shows a dead "Zoom" item (a macOS-style control that did nothing on Windows). Minimize and Close remain; on macOS the menu keeps Minimize and Bring All to Front. The working text zoom under **View ▸ Zoom In / Zoom Out / Actual Size** (and Ctrl +/−/0) is unchanged.

## 1.3.2 — 2026-06-29

- **White paper generation is more reliable:** a document-structure check was wrongly rejecting valid white papers that used a page `<header>` (it mistook it for a document `<head>`), causing intermittent "structure validation" failures. The check is fixed, and a white paper that comes back as a full HTML page (instead of a body fragment) is now recovered automatically instead of failing.
- **Editing the minutes prompt no longer triggers false errors:** the minutes generator now has a fixed output contract that your prompt edits can't accidentally break, rejects a response that was cut off at the length limit (instead of saving a partial document), and cleans up the returned HTML before saving.
- **Accurate usage counter:** the session/today usage counter now refreshes even when the generation window is closed, can't be thrown off by out-of-order updates, and counts every Claude call a generation makes — fixing cases where it under-reported real spend.

## 1.3.1 — 2026-06-24

- **Build-attribution placement:** edited the placement of the Claude build attribution — it no longer appears in the in-app About dialog or the first-run onboarding screen (it remains in the project README).

## 1.3.0 — 2026-06-24

- **Truthful gateway model tests:** the Settings ▸ Gateway models diagnostic now probes each model the same way chat does (a real streaming request), so it detects when a corporate governance layer silently **substitutes** a model — e.g. you select Opus but the gateway serves Sonnet. The previous lightweight non-streaming "ping" slipped past that redirect and wrongly reported substituted models as available.
- **Substituted models are hidden from the pickers:** once a test proves the gateway serves a different model than you asked for, that model no longer appears in the chat or white-paper dropdowns, so you can't accidentally pick a model the gateway won't actually use. Models that pass — and untested or temporarily-unreachable ones — stay visible.
- **Test all + clearer results:** a new **Test all** button checks every advertised model in one pass; verified-available models show a green card, while substituted or unavailable ones show red and name what the gateway actually served. A first-run nudge reminds you to test a freshly loaded model list.
- **Wider model lists:** the diagnostic now covers up to 200 advertised models (was 25), for gateways that expose the full Bedrock catalog.

## 1.2.2 — 2026-06-23

- **Gateway security:** gateway base URLs now require HTTPS by default. Plain HTTP is accepted only for localhost, or via an explicit advanced override (`MEETINGSPACE_ALLOW_INSECURE_GATEWAY_HTTP=1`) for an internal corporate HTTP gateway behind a trusted network — so the bearer token is never sent over cleartext by default.
- **Supply chain:** CI and release GitHub Actions are pinned to commit SHAs, with Dependabot keeping them current.

## 1.2.1 — 2026-06-23

- **Corporate gateway:** connect through a corporate AWS Bedrock gateway that sits behind your company's HTTP proxy. Claude calls now follow the OS system proxy (including PAC/WPAD auto-config), with enterprise proxy authentication and the OS certificate store handled for you. An optional explicit proxy URL is available for unusual setups (normally leave it blank).
- **Test connection:** a one-click connectivity check in Settings confirms the gateway is reachable before you start a chat or a generation.
- **Gateway model list:** the model picker shows exactly the models your gateway serves (auto-discovered), and chat now sends the precise model id the gateway requires — fixing chat on Haiku through the gateway.

## 1.2.0 — 2026-06-20

- **Editable minutes prompt:** the minutes generator now has its own editable prompt, alongside the white paper — adjust its structure and tone per template.
- **Redesigned prompt editor:** save changes in place, create copies from the default, rename, delete, and an explicit **Close** button. Unsaved edits are now guarded — closing the editor, or starting a generation, prompts you to **Save & close**, **Discard & close**, or **Keep editing** (a generation waits until you choose).
- **Clearer generated documents:** a chip on each generated document names the template that produced it (and the progress toast names it too).
- **Cancelling is safe:** cancelling a regeneration restores the previously generated document and its template, instead of leaving a half-applied state.
- **Editor usability:** the generation window scrolls as one piece, so a long prompt never hides the document below it; selecting text inside the window no longer closes it by accident.

## 1.1.0 — 2026-06-17

- **Desktop polish:** native menus, right-click context menu, dark mode, window-state and zoom persistence, find, and keyboard shortcuts.
- **Storage tools:** a storage meter, bulk delete with undo, and retention controls.
- **Backup & restore:** save all your data to a single portable file and restore it later (failure-safe — your existing data is never left half-overwritten).
- **Export:** generated documents now also export to **PDF** (in addition to self-contained HTML).
- **Chat & generation:** your chat history is now saved per space; a passive usage counter shows session/today activity; the model list updates automatically; generation can be cancelled mid-stream and has a watchdog for stalls.
- **Providers:** use a direct Anthropic key, or point at an Anthropic-compatible gateway/proxy.
- **Getting started:** first-run onboarding, an About panel, and a log viewer that redacts key-shaped tokens.
- **Image performance:** lazy-loaded thumbnails for screenshot-heavy spaces.
- **Security:** an independent pre-release audit found and fixed a path-traversal issue in backup restore, plus several hardening improvements. Full-history secret scan clean.

## 1.0.0 — 2026-06-07

First release (Windows).

- Named spaces that persist across close and reopen.
- Live capture: typed notes, screenshots (drag-drop, paste, upload, in-app capture), and transcripts.
- Claude integration with an encrypted API key (used only in the background process) and in-app chat grounded in your notes.
- Document generation — white paper, minutes, or raw notes — plus cross-session search and self-contained HTML export.
