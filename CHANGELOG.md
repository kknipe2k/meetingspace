# Changelog — MeetingSpace

Notable changes, newest first.

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
