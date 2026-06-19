# Changelog — MeetingSpace

All notable changes to this project are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/); the project is pre-1.0, so the surface may change between milestones.

## [1.1.0] — 2026-06-17

Desktop maturity + distribution. Second and final v1.1 milestone.

### Added
- Native per-platform menu, right-click context menu, window-state + zoom persistence, dark mode, find / new-session shortcuts.
- Storage meter + nudge, bulk delete with undo-toast, retention controls.
- Image performance (lazy thumbnails), **failure-safe backup/restore** (stage → atomic swap → rollback), PDF export.
- Conversation persistence, a passive per-session/today usage counter, a dynamic model catalog with config-driven pricing.
- First-run onboarding, About panel + key-redacting log viewer, custom app icon.
- Provider switch (Anthropic direct + gateway), real cancel that aborts the stream, generation watchdog (from M07).

### Security
- Independent pre-open-source audit (`CODEBASE-AUDIT.md`); found and **closed a zip-slip in backup restore** (S2-001, `confinedStagingPath`) plus four hardening 🟡s. Full-history secret scan clean. See `AUDIT-FINDINGS.md`.

### Notes
- Migrations v6 (`byte_size`), v7/v8 (`chat_messages` + `usage`) — additive, cascade-preserving. No new third-party dependency.

## [1.0.0] — 2026-06-07

First release (Windows). Capture surface + Claude integration + document generation.

### Added
- Three-zone app shell; named sessions persisting across close→reopen (M01).
- Live capture: typed notes, screenshots (drag-drop, paste, upload, in-app capture), transcripts (M02).
- Claude integration with an encrypted (`safeStorage`) API key, main-process-only SDK, grounded in-app chat (M03).
- Document generation (white paper / minutes / raw notes) + cross-session FTS5 search; self-contained sandboxed HTML export (M04).
- Durability hardening, cross-platform packaging, MIT license (M05).
