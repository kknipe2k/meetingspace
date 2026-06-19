MeetingSpace
============

A Windows-first (macOS-portable) desktop note-taking app for meetings, with a
built-in Claude assistant.

Capture typed notes, screenshots (drag-drop, clipboard paste, file upload, or
in-app screen capture), and transcripts during a meeting. Everything autosaves
locally and stays fully searchable. On demand, the built-in Claude layer (using
your own Anthropic API key) can generate a detailed white paper, structured
meeting minutes with screenshots, or simply keep your raw notes.

Getting started
---------------

1. Launch MeetingSpace. On first run, a short welcome screen lets you paste your
   Anthropic API key (optional — you can add it later in Settings) and seeds a
   sample space so the app isn't empty.
2. Create a space from the sidebar and start dropping in notes, screenshots, and
   transcripts.
3. Use the assistant panel to chat about a space or generate a document.

Your data
---------

Everything is stored locally on this device. Your API key is encrypted at rest
by your operating system (Windows Credential Vault / macOS Keychain) and never
leaves your machine in plain text. Use Settings -> Back up all data to save a
portable copy.

Updates
-------

This release does not auto-update. To update, download the latest installer or
DMG and reinstall; your local data is preserved.

Logs
----

If something goes wrong, open Help -> Open Logs Folder and include main.log when
reporting the issue. Key-shaped tokens are redacted from the log.

Unsigned build
--------------

These builds are not yet code-signed. On macOS, first launch may need
right-click -> Open. On Windows, SmartScreen may warn on first run.

AI assistance
-------------

MeetingSpace is built with Claude Code under the Build Framework methodology;
all work is human-reviewed before merge.
