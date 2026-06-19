# Changelog — MeetingSpace

Notable changes, newest first.

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
