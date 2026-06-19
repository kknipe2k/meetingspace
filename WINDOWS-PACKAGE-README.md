# MeetingSpace — Windows Build, Validate & Uninstall

A complete, step-by-step guide to building MeetingSpace from source on **Windows**, validating that it works, and fully removing it (app **and** its data). MeetingSpace is a local-first, single-user desktop note-taking app for meetings; it stores everything on **your** machine and only talks to the network when **you** use your own Anthropic API key.

> **Why build from source?** MeetingSpace ships as source, not as a pre-built download — you produce the app locally with a couple of commands. That keeps it free (no paid code-signing certificate) and means nothing runs on your machine that you didn't build yourself.
>
> **Unsigned build notice.** MeetingSpace is **not code-signed** (no paid certs), so Windows **SmartScreen** may warn the first time you run the installer. The steps below include the one-time bypass. This is expected for an unsigned open-source build — nothing is wrong.

---

## 0. Prerequisites (one-time setup)

- **Windows 10 or 11.**
- **Node.js 18 LTS or newer** — check in a terminal (PowerShell or Command Prompt):
  - `node --version` → should print `v18.x` or higher.
  - If missing: install the **LTS** build from <https://nodejs.org> (default options are fine).
- **Git** (only if you'll `git clone` rather than download a ZIP): <https://git-scm.com/download/win>.
- **Build tools — usually NOT needed.** MeetingSpace's one native module (SQLite) installs from a pre-built binary on most machines. **Only if** `npm install` or the build step fails with a `node-gyp` / `MSB` / C++ compile error, install the **Visual Studio Build Tools** (the *"Desktop development with C++"* workload) from <https://visualstudio.microsoft.com/visual-studio-build-tools/>, reopen your terminal, and retry.
- **~1.5 GB free disk** (node_modules + the built app).

---

## 1. Get the source & build the app

- **Get the source** — either:
  - **Download ZIP:** on the project's GitHub page, click the green **Code** button → **Download ZIP**, then right-click the downloaded file → **Extract All…** to a folder with space, e.g. `C:\Users\<you>\meetingspace`. **Or**
  - **Clone:** `git clone <repository-url> meetingspace`
- **Open a terminal in the project folder** (the folder that contains `package.json`):
  - In File Explorer, open the `meetingspace` folder, type `powershell` in the address bar, and press Enter — that opens PowerShell already in the right place.
- **Install dependencies:**
  - `npm install`
  - This downloads packages and prepares the native SQLite module. Takes a few minutes the first time. A few `npm warn` lines are normal; a hard `npm error` is not (see Troubleshooting).
- **Build the Windows app:**
  - `npm run package:win`
  - electron-builder produces, under **`release\`**:
    - `MeetingSpace Setup <version>.exe` — the installer (the normal way to run it), **and**
    - `release\win-unpacked\MeetingSpace.exe` — a no-install copy you can run directly.

---

## 2. First launch — get past SmartScreen (unsigned app)

Because the build is unsigned, Windows may block it the first time. Do this **once**:

- **Run the installer:** double-click `release\MeetingSpace Setup <version>.exe`.
- If you see **"Windows protected your PC"** (the SmartScreen dialog):
  - Click **"More info"**, then the **"Run anyway"** button that appears.
- The installer puts MeetingSpace in your Start Menu and launches it. After this one-time approval it opens like any app.
- **No-install alternative:** instead of the installer, just run `release\win-unpacked\MeetingSpace.exe` directly. **Developer alternative:** from the project folder, `npm run dev` launches the app without packaging at all.

---

## 3. Validate — the smoke test (≈3 minutes)

Confirm the core flow works end-to-end. Tick each box:

- **Boot smoke:**
  - The app window opens and renders the main UI (sidebar + canvas). No crash, no blank window.
- **Create + capture:**
  - Create a new **space/session** (give it a name).
  - Add a **typed note** — type some text; it should autosave (no save button needed).
  - Add a **screenshot** — drag an image file onto the canvas, or paste one (**Ctrl+V**), or use the in-app capture. It should appear inline; click it to expand (lightbox), click again to close.
- **Claude features (needs your own Anthropic API key):**
  - Open **Settings** and paste your Anthropic API key (`sk-ant-…`). It's stored encrypted by Windows (Data Protection API) — never in plaintext.
  - **Chat:** ask a question grounded in your notes; a streamed answer should appear.
  - **Generate:** run a **white paper** (or **minutes**) from the session; a formatted document should render.
  - **Export:** export the document to HTML; open the file in a browser — it should be fully self-contained (images render offline) and make **no** network requests.
- **Persistence (the key durability check):**
  - **Quit** the app completely.
  - **Reopen** it.
  - Your space, notes, screenshots, and generated docs should **all still be there**.

✅ **Pass** = every box ticked, especially boot + persistence.
🚩 **Report** = any crash, blank window, lost data after reopen, or a feature that silently does nothing.

---

## 4. Where your data lives (so uninstall is complete)

MeetingSpace keeps **all** state in your user profile, not inside the app folder:

- **App data folder:** `%APPDATA%\MeetingSpace\`
  - paste `%APPDATA%\MeetingSpace` into the File Explorer address bar to open it. Full path is `C:\Users\<you>\AppData\Roaming\MeetingSpace\`.
  - holds the SQLite database, your screenshots/assets, the **encrypted** API-key blob, preferences, and generation templates.
- **API-key encryption:** on Windows the key that decrypts the stored API-key blob is managed by the OS **per-user Data Protection API (DPAPI)** — there's no separate keychain item to find or delete. Removing the app data folder above is sufficient.

---

## 5. Uninstall — remove the app and all its data

Do these in order for a complete removal:

- **Quit the app** — make sure it isn't running. (If a rebuild/uninstall complains the app is busy, end any `MeetingSpace.exe` / `electron.exe` in Task Manager.)
- **Uninstall the app:**
  - If you used the installer: **Settings → Apps → Installed apps → MeetingSpace → Uninstall** (runs the bundled uninstaller).
  - If you ran the no-install copy: just delete the `release\win-unpacked\` folder.
- **Delete the app data folder** (this removes notes, screenshots, the encrypted key blob, settings):
  - In File Explorer, paste `%APPDATA%\MeetingSpace` into the address bar, press Enter, go up one level, and delete the **MeetingSpace** folder.
  - Terminal equivalent (PowerShell): `Remove-Item -Recurse -Force "$env:APPDATA\MeetingSpace"`
- **Delete the build folder + source** (frees the ~1.5 GB): delete the `meetingspace` folder you extracted/cloned.

After these steps, nothing from MeetingSpace remains — no app, no notes, no key, no data. (The DPAPI encryption key is OS-managed per user and harmless on its own — it can't decrypt anything once the encrypted blob is gone.)

---

## Troubleshooting quick reference

- **"Windows protected your PC" on launch.** → expected (unsigned). Click **More info → Run anyway** (§2).
- **`npm install` or `npm run package:win` fails with a `node-gyp` / C++ / `MSB####` error.** → install the **Visual Studio Build Tools** ("Desktop development with C++"), reopen the terminal, and retry (§0).
- **Rebuild/uninstall fails with `EBUSY` / `EPERM` on `better_sqlite3.node`.** → a leftover app process is holding the file. Close MeetingSpace, then in PowerShell: `taskkill /F /IM electron.exe; taskkill /F /IM MeetingSpace.exe`, and retry.
- **App opens but Claude features error.** → check the Anthropic API key in Settings is valid and has credit; chat/generation need network + a working key.
- **Want to start fresh without uninstalling the app.** → delete `%APPDATA%\MeetingSpace\` (§4); the app recreates it empty on next launch.
