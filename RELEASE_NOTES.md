<!--
  The GitHub Release body, published by .github/workflows/release.yml. __VERSION__ is replaced with
  the package.json version at release time, so the download filenames below always match the build.
  Edit the prose here; do not hardcode a version number.
-->

A desktop note-taking app for meetings, with a Claude assistant built in.

## ⬇️ Which file do I download?

Pick one file for your computer. (Ignore the `.blockmap`, `latest.yml`, and `latest-mac.yml` files — those are used by the app's updater, not for downloading.)

### 🪟 Windows

- **Most people →** `MeetingSpace-Setup-__VERSION__.exe` — the installer. Double-click and follow the prompts.
- **No-install option →** `MeetingSpace-__VERSION__-win.zip` — unzip anywhere and run the app.

First launch shows a SmartScreen warning → **More info → Run anyway** (one time; the build is unsigned).

### 🍎 macOS

- **Apple Silicon Mac** (M1/M2/M3/M4 — most Macs from 2020 on) → `MeetingSpace-__VERSION__-arm64.dmg`
- **Intel Mac** (older models) → `MeetingSpace-__VERSION__-x64.dmg`

Not sure which you have? &nbsp;→ **About This Mac**: a Chip starting with "Apple" = arm64; a Processor that says "Intel" = x64. (The `-arm64.zip` / `-x64.zip` files are the same app without the disk-image wrapper.)

First launch: **right-click the app → Open** (one time, because the build is unsigned).

You'll need your own Anthropic API key for the Claude features (chat / white paper / minutes). Capture, search, and persistence work with no key. See the README for setup.

## ✨ What's new in __VERSION__

This release carries everything since the last full public build (1.3.1). (1.4.1 is the same code as 1.4.0, re-released with the complete Windows **and** macOS asset set — the 1.4.0 release shipped Windows-only.)

### Set AI-cost prices in the app — no more editing a file

MeetingSpace shows your Claude spend as *your token usage × a per-model price*. Tokens are always real (from Anthropic's response), but Anthropic's API doesn't return prices, so the price is a local number. New models (like **Claude Sonnet 5**) or a corporate gateway's negotiated rates may show **"cost unknown"** until you set a price — and now you set it right in **Settings**.

- **Set a price:** an unpriced model shows a red **"Cost tracking off — set price"** control with input/output $/MTok fields. Save and the cost appears immediately — no restart, no reinstall.
- **Edit and delete:** a saved price can be changed (reopens pre-filled, cancel reverts) or removed. A deleted model goes back to "cost unknown" and **stays that way across restarts** — it won't silently revert to a built-in rate.
- **New models are priced automatically:** shipped prices backfill into your existing settings on launch, while any price you set is preserved.
- **Claude Sonnet 5** is priced out of the box at its introductory rate; its standard rate takes effect after the introductory window, and you can always override it.
- Prices are stored **locally** — the app makes no extra network call for pricing; the only outbound request remains the Claude call you trigger. A link in Settings opens Anthropic's current-pricing page in your browser.

### Also rolled up (previously unpublished)

- **More reliable document generation (1.3.2):** fixes intermittent "structure validation" failures on valid white papers, hardens minutes generation against partial/cut-off responses, and makes the session usage counter accurate.
- **Cleaner Window menu (1.3.3):** the native **Window** menu no longer shows a dead "Zoom" item that did nothing on Windows. The working text zoom under **View ▸ Zoom In / Zoom Out / Actual Size** (and Ctrl +/−/0) is unchanged.
- **Security & dependency hardening (1.3.4):** the Markdown export now uses a real HTML parser internally, a denial-of-service issue in a build dependency (`js-yaml`, CVE-2026-53550) is patched, and CI runs with least-privilege tokens plus CodeQL scanning. None of these change how the app works day to day.

**Upgrade note:** installing over 1.3.x or the Windows-only 1.4.0 preserves all your data; shipped model prices merge into your settings on first launch, and anything you've configured wins.

Full details in CHANGELOG.md.
