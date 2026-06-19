# Contributing

Thanks for considering a contribution. MeetingSpace is **shared as-is and lightly maintained** — there's no guaranteed review cadence, but if you'd like to build on it, contributions are welcome.

## How this project is run

- **Issues are disabled.** There's no public bug tracker — this is a personal project published for others to use and fork, not a supported product.
- **Contributions come in via pull request.** Fork the repo, make your change on a branch, and open a PR. Discussion happens in the PR.
- **Security problems go through a private channel** — see [`SECURITY.md`](SECURITY.md). Don't open a public report for anything security-sensitive.

If you're just trying it out and want to extend it for yourself, you don't need any of this — fork it and go. The rest of this document is for changes you'd like to send back.

## Development setup

MeetingSpace is **Windows-first, macOS-portable**. Electron apps are built from source per platform.

Prerequisites:

- **Node.js 18 LTS or newer** (CI pins 20).
- **Windows:** Visual Studio Build Tools (C++ workload) for the native SQLite module.
- **macOS:** Xcode Command Line Tools — `xcode-select --install`.

```bash
git clone https://github.com/kknipe2k/meetingspace.git
cd meetingspace
npm install            # installs deps + builds the native better-sqlite3 module

npm run dev            # hot-reloading dev build (auto-rebuilds the native module for Electron)
```

> Native-module note: `better-sqlite3` is kept at the **Node** ABI at rest so the Node-based test suite passes, and is rebuilt to **Electron's** ABI on `predev`/`prestart`. If unit tests fail with an ABI / `NODE_MODULE_VERSION` mismatch, run `node scripts/ensure-node-abi.cjs` (it's wired into `pretest`). You won't normally touch this.

## Quality gates

CI mirrors the local gate set — a PR that fails any of these won't be merged until it's green:

```bash
npm run typecheck            # TS across renderer + main
npm run lint                 # eslint, zero warnings
npm run format:check         # prettier
npm run build                # electron-vite build
npm test                     # unit + component (vitest)
npm run test:security        # key-never-plaintext + CSP / env-seam checks
npm run coverage             # workspace coverage — must stay >= 80%
npm run coverage:primitives  # safety primitives — must stay >= 95%
npm run audit                # npm audit on production deps (high+)
npm run e2e                  # Playwright-on-Electron + visual regression
```

`npm run format` auto-formats. CI also runs a **gitleaks** secret scan — don't commit real keys, even in tests (use an obvious fake like `sk-ant-...FAKE`).

Coverage: **>= 80% on the workspace, >= 95% on the safety primitives** (the HTML sanitizer, CSP enforcement, and API-key handling). Drops below these block merge.

## Commit messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): summary in imperative present tense

optional body explaining what and why (not how — the code shows how).
```

Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`. Scopes follow the code areas: `electron`, `renderer`, `ipc`, `llm`, `gen`, `storage`, `security`, `build`.

## Sign-off (DCO)

Every commit must be signed off:

```bash
git commit -s -m "fix(gen): strip remote refs from exported HTML"
```

The `-s` adds a `Signed-off-by: Your Name <your-email>` line, which is your assertion of the [Developer Certificate of Origin](https://developercertificate.org/). We use the DCO instead of a CLA to keep contribution friction low while maintaining IP hygiene. **PRs without a sign-off can't be merged.**

If you forgot, amend the last commit with `git commit --amend -s` (or `git rebase --signoff HEAD~N` for several).

## Review & merge

- One maintainer approval, then squash-merge. Linear history; no force-pushes to `main`.
- Keep PRs focused — one logical change per PR is far easier to review than a grab-bag.
- CI must be green.

## House rules

A few hard lines, inherited from how the app is built:

- **No telemetry, analytics, or "phone home" code.** MeetingSpace is local-only by design — this is non-negotiable.
- **The API key never leaves the main process** and is never written to disk or logs in plaintext. Changes that touch key handling get extra scrutiny.
- **Untrusted HTML stays sanitized and sandboxed.** Don't loosen the DOMPurify config, the iframe `sandbox`, or the CSP without a very good reason and a test that proves it's still safe.
- **Disclose AI assistance.** This project was itself built with substantial AI help, so AI-assisted contributions are fine — just say so in the PR. Undisclosed ones aren't.

## Code of Conduct

This project follows the [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) for the reporting flow; conduct concerns go privately to `ardenagentic+conduct@gmail.com`.

## License

By contributing, you agree your contribution is licensed under the project's [MIT License](LICENSE). Your DCO sign-off is your assertion of that.

Thanks again.
