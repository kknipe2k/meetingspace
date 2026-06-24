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

- **Truthful gateway model tests:** the Settings ▸ Gateway models diagnostic now tests each model the same way chat does (a real streaming request), so it catches when a corporate gateway silently **substitutes** a model — e.g. you pick Opus but it serves Sonnet. The old lightweight "ping" slipped past that redirect and wrongly showed substituted models as available.
- **Substituted models drop out of the pickers:** a model the gateway proves it swaps no longer appears in the chat or white-paper dropdowns, so you can't pick a model the gateway won't actually use. Models that pass stay selectable.
- **Test all + clearer results:** a new **Test all** button checks every advertised model at once; available models show green, substituted or unavailable ones show red and name what was actually served. The diagnostic now covers up to 200 models (was 25).
- Includes everything from 1.2.x: corporate AWS Bedrock **gateway** support (via your company proxy), HTTPS-by-default, **Test connection**, and the gateway **model list**.

Full details in CHANGELOG.md.
