# MeetingSpace on macOS — Install, Validate & Uninstall

How to get MeetingSpace running on a **Mac (macOS 11 Big Sur or newer)**, confirm it works, and fully remove it (app **and** data) if you ever want to. MeetingSpace is a local-first, single-user app — it stores everything on **your** machine and only reaches the network when **you** use your own Anthropic API key.

> **Unsigned build.** MeetingSpace isn't code-signed or notarized (no paid certificates), so macOS **Gatekeeper** warns on first launch. That's expected for a free unsigned app — the one-time bypass is below, and nothing is wrong.

There are two ways to get it. **Most people want Option A.**

---

## Option A — Download a prebuilt build (easiest)

1. Go to the [**Releases**](https://github.com/kknipe2k/meetingspace/releases) page and open the latest release.
2. Download the file matching your Mac's chip (the `.dmg` is the usual choice; a `.zip` is also provided):
   - **Apple Silicon** (M1/M2/M3/M4): the **arm64** `.dmg` or `.zip`.
   - **Intel**: the **x64** `.dmg` or `.zip`.
   - Not sure?  → Apple menu → *About This Mac*. "Apple M…" = Apple Silicon; "Intel" = Intel.
3. **Install:** open the `.dmg` and drag **MeetingSpace** to **Applications** (or just unzip and move the app where you like).
4. **First launch — get past Gatekeeper** (one time):
   - **Right-click (or Control-click) the app → choose "Open."**
   - In the dialog, click **"Open"** again.
   - If there's no "Open" button: **System Settings → Privacy & Security**, scroll to the message about MeetingSpace, click **"Open Anyway,"** then reopen it.
   - After this one-time approval, it launches normally (double-click).

> No release posted yet? Use **Option B** below.

---

## Option B — Build it from source

Building on a Mac is the **only** way to produce a macOS `.app` — it can't be cross-built from Windows.

### Prerequisites (one-time)

- **Node.js 18 LTS or newer** — `node --version` should print `v18.x`+. Install from <https://nodejs.org> (LTS) or `brew install node`.
- **Xcode Command Line Tools** (to compile the native SQLite module): run `xcode-select --install` and accept the dialog. Verify with `xcode-select -p`.
- **~1.5 GB free disk.**

### Get the source & run

1. **Get the source** — **Download ZIP** from the GitHub **Code** button and extract (e.g. to `~/meetingspace`), **or** `git clone https://github.com/kknipe2k/meetingspace.git ~/meetingspace`.
2. **Open Terminal in that folder:** `cd ~/meetingspace` (the folder containing `package.json`).
3. **Install dependencies:** `npm install` (compiles the native SQLite module; a few minutes the first time).
4. **Run it** — easiest is dev mode:
   - `npm run dev`

### Build an app bundle (optional)

```
npm run package:mac
```

electron-builder writes the app under **`release/`** — `release/mac-arm64/MeetingSpace.app` (Apple Silicon) or `release/mac/MeetingSpace.app` (Intel), plus a `.zip`. If it errors on the native compile, re-run `xcode-select --install`, let it finish, and try again. To open a build you made yourself, use the same right-click → **Open** step as Option A, or clear the quarantine flag: `xattr -dr com.apple.quarantine "release/mac-arm64/MeetingSpace.app"`.

---

## Validate — the smoke test (≈3 minutes)

Confirm the core flow works end-to-end:

- **Boot:** the window opens and renders the main UI (sidebar + canvas). No crash, no blank window.
- **Capture:** create a **space**, add a **typed note** (it autosaves), and add a **screenshot** — drag an image in, paste one (**⌘V**), or use in-app capture. It appears inline; click to expand, click again to close.
- **Claude (needs your Anthropic API key):** open **Settings**, paste your key (`sk-ant-…`; stored encrypted in the macOS Keychain). **Chat** a question about your notes → a streamed answer appears. **Generate** a white paper or minutes → a formatted document renders (a full white paper can take **10+ minutes** — that's expected, let it run). **Export** to HTML → it opens self-contained in a browser with no network requests.
- **Persistence:** **quit** the app (⌘Q), **reopen** it — your space, notes, screenshots, and generated docs are all still there.

✅ **Pass** = every step works, especially boot + persistence.

---

## Where your data lives

MeetingSpace keeps **all** state in your user Library, not in the app bundle:

- **App data:** `~/Library/Application Support/MeetingSpace/` — the database, your screenshots, the **encrypted** API-key blob, preferences, and templates.
- **Keychain item:** the key that *decrypts* the stored API-key blob lives in your **login Keychain** (created by Electron `safeStorage`).
- **Caches / logs (if present):** `~/Library/Caches/MeetingSpace/`, `~/Library/Logs/MeetingSpace/`, and macOS-managed `~/Library/Saved Application State/`.

---

## Uninstall — remove the app and all its data

1. **Quit the app** (⌘Q).
2. **Delete the app bundle** — drag **MeetingSpace.app** to the Trash (from `/Applications` or wherever you put it).
3. **Delete the app data** (removes notes, screenshots, the encrypted key, settings): Finder → **Go → Go to Folder…**, paste `~/Library/Application Support/MeetingSpace`, and move that folder to the Trash. Terminal: `rm -rf ~/Library/Application\ Support/MeetingSpace`.
4. **Remove the Keychain entry** (the API-key decryption key): open **Keychain Access**, search **MeetingSpace** (or **Electron** / **"Safe Storage"**), right-click the match → **Delete**.
5. **(Optional) caches/logs:** `rm -rf ~/Library/Caches/MeetingSpace ~/Library/Logs/MeetingSpace` and `rm -rf ~/Library/Saved\ Application\ State/*MeetingSpace*`.
6. **Delete the source/build folder** (if you built from source) and any downloaded `.dmg` / `.zip`, then **empty the Trash**.

After this, nothing remains — no app, no notes, no key, no caches.

---

## Troubleshooting

- **"MeetingSpace can't be opened because it is from an unidentified developer"** → expected (unsigned). Use right-click → **Open**, or `xattr -dr com.apple.quarantine "<path to MeetingSpace.app>"`.
- **`npm install` fails compiling sqlite / `node-gyp`** → install/repair the Xcode Command Line Tools (`xcode-select --install`), then retry.
- **`npm run package:mac` says nothing to do / wrong arch** → make sure you're on a Mac (this can't build on Windows/Linux); the artifact matches your chip (arm64 vs Intel).
- **App opens but Claude features error** → check the API key in Settings is valid and has credit; chat/generation need network + a working key.
- **Start fresh without uninstalling** → delete `~/Library/Application Support/MeetingSpace/`; the app recreates it empty on next launch.
