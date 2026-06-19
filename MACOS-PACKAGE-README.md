# MeetingSpace — macOS Build, Validate & Uninstall

A complete, step-by-step guide to building MeetingSpace from source on a Mac, validating that it works, and fully removing it (app **and** its data). MeetingSpace is a local-first, single-user desktop note-taking app for meetings; it stores everything on **your** machine and only talks to the network when **you** use your own Anthropic API key.

> **Why build from source?** MeetingSpace ships as source, not as a pre-built download — and the app can't be cross-built for macOS from Windows (Electron limitation), so you produce the `.app` locally on your Mac with two commands. That keeps it free (no paid code-signing certificate) and means nothing runs on your machine that you didn't build yourself.
>
> **Unsigned build notice.** MeetingSpace is **not code-signed/notarized** (no paid certs), so macOS Gatekeeper will warn on first launch. The steps below include the one-time bypass. This is expected for an unsigned open-source build — nothing is wrong.

---

## 0. Prerequisites (one-time setup)

- **macOS 11 (Big Sur) or newer.**
- **Node.js 18 LTS or newer** — check with:
  - `node --version` → should print `v18.x` or higher.
  - If missing: install from <https://nodejs.org> (the LTS installer), or via Homebrew: `brew install node`.
- **Xcode Command Line Tools** (needed to compile the native SQLite module):
  - Run `xcode-select --install` and accept the dialog. If already installed, it'll say so.
  - Verify: `xcode-select -p` prints a path (e.g. `/Library/Developer/CommandLineTools`).
- **~1.5 GB free disk** (node_modules + the built app bundle).

---

## 1. Get the source & build the app

- **Get the source** — either:
  - **Download ZIP:** on the project's GitHub page, click the green **Code** button → **Download ZIP**, then double-click it in Finder to extract (e.g. to `~/meetingspace`). **Or**
  - **Clone:** `git clone <repository-url> ~/meetingspace`
- **Open Terminal in the project folder:**
  - `cd ~/meetingspace` (or wherever you extracted/cloned it — the folder containing `package.json`).
- **Install dependencies:**
  - `npm install`
  - This downloads packages and compiles the native SQLite module. Takes a few minutes the first time. A few `npm warn` lines are normal; a hard `npm error` is not.
- **Build the macOS app:**
  - `npm run package:mac`
  - electron-builder produces the app under **`release/`**. Depending on your chip you'll get one of:
    - Apple Silicon (M1/M2/M3): `release/mac-arm64/MeetingSpace.app`
    - Intel: `release/mac/MeetingSpace.app`
  - A `.zip` of the app is also written in `release/` (that's the distributable artifact).
  - **If the build errors on `xcode-select` / native compile:** re-run `xcode-select --install`, let it finish, then `npm run package:mac` again.

---

## 2. First launch — get past Gatekeeper (unsigned app)

Because the build is unsigned, macOS blocks it the first time. Do this **once**:

- **Locate the app:** in Finder, open the `release/mac-arm64/` (or `release/mac/`) folder; you'll see **MeetingSpace.app**.
- **Right-click (or Control-click) the app → choose “Open.”**
- A dialog warns it's from an unidentified developer → click **“Open”** again.
  - If there's no “Open” button, go to **System Settings → Privacy & Security**, scroll to the message about MeetingSpace, and click **“Open Anyway,”** then reopen the app.
- **Terminal alternative** (if Gatekeeper is stubborn): clear the quarantine flag, then open normally:
  - `xattr -dr com.apple.quarantine "release/mac-arm64/MeetingSpace.app"`
  - `open "release/mac-arm64/MeetingSpace.app"`
- After this one-time approval, it launches like any app (double-click).

---

## 3. Validate — the smoke test (≈3 minutes)

Confirm the core flow works end-to-end. Tick each box:

- **Boot smoke:**
  - The app window opens and renders the main UI (sidebar + canvas). No crash, no blank window.
- **Create + capture:**
  - Create a new **space/session** (give it a name).
  - Add a **typed note** — type some text; it should autosave (no save button needed).
  - Add a **screenshot** — drag an image file onto the canvas, or paste one (⌘V), or use the in-app capture. It should appear inline; click it to expand (lightbox), click again to close.
- **Claude features (needs your own Anthropic API key):**
  - Open **Settings** and paste your Anthropic API key (`sk-ant-…`). It's stored encrypted in the macOS Keychain — never in plaintext.
  - **Chat:** ask a question grounded in your notes; a streamed answer should appear.
  - **Generate:** run a **white paper** (or **minutes**) from the session; a formatted document should render.
  - **Export:** export the document to HTML; open the file in a browser — it should be fully self-contained (images render offline) and make **no** network requests.
- **Persistence (the key durability check):**
  - **Quit** the app completely (⌘Q).
  - **Reopen** it.
  - Your space, notes, screenshots, and generated docs should **all still be there**.
- **Clean console (optional, for testers):**
  - The packaged app should run without error dialogs. If you see a crash or an error toast, note what you did and capture a screenshot.

✅ **Pass** = every box ticked, especially boot + persistence.
🚩 **Report** = any crash, blank window, lost data after reopen, or a feature that silently does nothing.

---

## 4. Where your data lives (so uninstall is complete)

MeetingSpace keeps **all** state in your user Library, not inside the app bundle:

- **App data folder:** `~/Library/Application Support/MeetingSpace/`
  - the SQLite database, your screenshots/assets, the **encrypted** API-key blob, preferences, and generation templates.
- **Keychain item:** the key that *decrypts* the stored API-key blob lives in your **login Keychain** (created by Electron `safeStorage`).
- **Caches / logs (if present):** `~/Library/Caches/MeetingSpace/`, `~/Library/Logs/MeetingSpace/`, and macOS-managed `~/Library/Saved Application State/`.

---

## 5. Uninstall — remove the app and all its data

Do these in order for a complete removal:

- **Quit the app** (⌘Q) — make sure it isn't running.
- **Delete the app bundle:**
  - Drag **MeetingSpace.app** to the Trash (from `release/…` or wherever you moved it, e.g. `/Applications`).
- **Delete the app data folder** (this removes notes, screenshots, the encrypted key blob, settings):
  - Finder: in the menu bar choose **Go → Go to Folder…**, paste `~/Library/Application Support/MeetingSpace`, press Return, then move that **MeetingSpace** folder to the Trash.
  - Terminal equivalent: `rm -rf ~/Library/Application\ Support/MeetingSpace`
- **Remove the Keychain entry** (the API-key decryption key):
  - Open **Keychain Access** (Spotlight → “Keychain Access”).
  - Search for **MeetingSpace** (if nothing, search **Electron** or **Chromium** “Safe Storage”).
  - Right-click the matching “… Safe Storage” / MeetingSpace item → **Delete**.
- **Remove caches/logs (optional, for a spotless uninstall):**
  - `rm -rf ~/Library/Caches/MeetingSpace ~/Library/Logs/MeetingSpace`
  - `rm -rf ~/Library/Saved\ Application\ State/*MeetingSpace*` (the saved-state name includes the bundle id)
- **Delete the build folder + this package** (frees the ~1.5 GB):
  - Trash the unzipped `~/meetingspace` source folder and the `meetingspace-macos.zip`.
- **Empty the Trash** to finalize.

After these steps, nothing from MeetingSpace remains — no app, no notes, no key, no caches.

---

## Troubleshooting quick reference

- **“MeetingSpace can’t be opened because it is from an unidentified developer.”** → expected (unsigned). Use §2 (right-click → Open, or `xattr -dr com.apple.quarantine`).
- **`npm install` fails compiling sqlite / `node-gyp`.** → install/repair Xcode CLT (`xcode-select --install`), then retry.
- **`npm run package:mac` says nothing to do / wrong arch.** → ensure you're on a Mac (this target can't run on Windows/Linux); the artifact matches your chip (arm64 vs intel).
- **App opens but Claude features error.** → check the Anthropic API key in Settings is valid and has credit; chat/generation need network + a working key.
- **Want to start fresh without uninstalling the app.** → just delete `~/Library/Application Support/MeetingSpace/` (§4); the app recreates it empty on next launch.
