# MeetingSpace on Windows — Install, Validate & Uninstall

How to get MeetingSpace running on **Windows 10 or 11**, confirm it works, and fully remove it (app **and** data) if you ever want to. MeetingSpace is a local-first, single-user app — it stores everything on **your** machine and only reaches the network when **you** use your own Anthropic API key.

> **Unsigned build.** MeetingSpace isn't code-signed (no paid certificates), so Windows **SmartScreen** may warn the first time you run it. That's expected for a free unsigned app — the one-time bypass is below, and nothing is wrong.

There are two ways to get it. **Most people want Option A.**

---

## Option A — Download a prebuilt build (easiest)

1. Go to the [**Releases**](https://github.com/kknipe2k/meetingspace/releases) page and open the latest release.
2. Download **one** of:
   - **`MeetingSpace Setup <version>.exe`** — the installer (adds it to your Start Menu). Recommended.
   - **the portable `.zip`** — no install; unzip anywhere and run `MeetingSpace.exe` from the folder.
3. **First launch — get past SmartScreen** (one time):
   - Run the installer (or `MeetingSpace.exe`).
   - If you see **"Windows protected your PC,"** click **"More info,"** then **"Run anyway."**
   - After this one-time approval it opens like any other app.

> No release posted yet? Use **Option B** below — it's a couple of commands.

---

## Option B — Build it from source

### Prerequisites (one-time)

- **Node.js 18 LTS or newer** — check in PowerShell: `node --version` (should print `v18.x` or higher). If missing, install the **LTS** build from <https://nodejs.org> (defaults are fine).
- **Git** (only if you'll clone rather than download a ZIP): <https://git-scm.com/download/win>.
- **Build tools — usually NOT needed.** The one native module (SQLite) installs a prebuilt binary on most machines. **Only if** `npm install` fails with a `node-gyp` / `MSB` / C++ error, install the **Visual Studio Build Tools** (the *"Desktop development with C++"* workload) from <https://visualstudio.microsoft.com/visual-studio-build-tools/>, reopen your terminal, and retry.
- **~1.5 GB free disk.**

### Get the source & run

1. **Get the source** — on the GitHub page click the green **Code** button → **Download ZIP** and extract it (e.g. to `C:\Users\<you>\meetingspace`), **or** `git clone https://github.com/kknipe2k/meetingspace.git`.
2. **Open a terminal in that folder** (the one containing `package.json`). Tip: in File Explorer, type `powershell` in the address bar and press Enter — it opens already in the right place.
3. **Install dependencies:** `npm install` (takes a few minutes the first time; a few `npm warn` lines are normal, a hard `npm error` is not).
4. **Run it** — easiest is dev mode, no packaging:
   - `npm run dev`

### Build an installer (optional)

If you want the actual `.exe` installer instead of running in dev:

```
npm run package:win
```

This writes, under **`release\`**: `MeetingSpace Setup <version>.exe` (the installer) and `release\win-unpacked\MeetingSpace.exe` (a no-install copy you can run directly).

> **If `package:win` fails with a symlink / "privilege not held" / `EPERM` error:** building the NSIS installer needs permission to create symbolic links. Either **turn on Windows Developer Mode** (Settings → *Privacy & security* → *For developers* → *Developer Mode* on), **or** run the terminal **as Administrator**, then retry. If you only want to *run* the app you don't need the installer at all — use `npm run dev`, or run `release\win-unpacked\MeetingSpace.exe` directly.

---

## Validate — the smoke test (≈3 minutes)

Confirm the core flow works end-to-end:

- **Boot:** the window opens and renders the main UI (sidebar + canvas). No crash, no blank window.
- **Capture:** create a **space**, add a **typed note** (it autosaves), and add a **screenshot** — drag an image in, paste one (**Ctrl+V**), or use in-app capture. It appears inline; click to expand, click again to close.
- **Claude (needs your Anthropic API key):** open **Settings**, paste your key (`sk-ant-…`; stored encrypted by Windows). **Chat** a question about your notes → a streamed answer appears. **Generate** a white paper or minutes → a formatted document renders (a full white paper can take **10+ minutes** — that's expected, let it run). **Export** to HTML → it opens self-contained in a browser with no network requests.
- **Persistence:** **quit** the app, **reopen** it — your space, notes, screenshots, and generated docs are all still there.

✅ **Pass** = every step works, especially boot + persistence.

---

## Where your data lives

MeetingSpace keeps **all** state in your user profile, not in the app folder:

- **App data:** `%APPDATA%\MeetingSpace\` (paste that into the File Explorer address bar to open it; full path `C:\Users\<you>\AppData\Roaming\MeetingSpace\`). Holds the database, your screenshots, the **encrypted** API-key blob, preferences, and templates.
- **API-key encryption:** the key that decrypts the stored API-key blob is managed by the Windows per-user Data Protection API (DPAPI) — there's no separate item to find. Deleting the app data folder is enough.

---

## Uninstall — remove the app and all its data

1. **Quit the app.** (If something complains it's busy, end any `MeetingSpace.exe` / `electron.exe` in Task Manager.)
2. **Remove the app:**
   - Installer build: **Settings → Apps → Installed apps → MeetingSpace → Uninstall.**
   - Portable / no-install: just delete the unpacked folder.
3. **Delete the app data** (removes notes, screenshots, the encrypted key, settings): paste `%APPDATA%\MeetingSpace` into File Explorer, go up one level, and delete the **MeetingSpace** folder. PowerShell equivalent: `Remove-Item -Recurse -Force "$env:APPDATA\MeetingSpace"`.
4. **Delete the source/build folder** (if you built from source) to reclaim the ~1.5 GB.

After this, nothing remains — no app, no notes, no key, no data.

---

## Troubleshooting

- **"Windows protected your PC" on launch** → expected (unsigned). **More info → Run anyway.**
- **`package:win` fails with a symlink / privilege / `EPERM` error** → enable Developer Mode or run the terminal as Administrator (see the build note above), or just use `npm run dev` / `win-unpacked`.
- **`npm install` fails with a `node-gyp` / C++ / `MSB####` error** → install the Visual Studio Build Tools ("Desktop development with C++"), reopen the terminal, retry.
- **App opens but Claude features error** → check the API key in Settings is valid and has credit; chat/generation need network + a working key.
- **Start fresh without uninstalling** → delete `%APPDATA%\MeetingSpace\`; the app recreates it empty on next launch.
