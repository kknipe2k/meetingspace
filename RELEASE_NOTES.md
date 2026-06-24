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

- **Build-attribution placement:** the Claude build attribution no longer appears in the in-app About dialog or the first-run screen.
- Includes everything from 1.3.0: truthful gateway model tests (a real streaming probe that catches when the gateway silently **substitutes** a model), substituted models hidden from the chat and white-paper pickers, the **Test all** button, and the wider 200-model diagnostic.

Full details in CHANGELOG.md.
