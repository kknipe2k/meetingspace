# Security Audit — MeetingSpace (consolidated record + retrospective)

> **Single canonical security-audit record.** Consolidates every post-v1 audit pass (2026-06-07 → 2026-06-08), each finding's status, the dependency/currency posture, the coverage limits, and a retrospective on the audit arc. Supersedes the per-run report files (the dated `AUDIT-FINDINGS-*.md` snapshots were folded in here and removed). Prior versions remain in git history.
>
> **Nature of this record:** static human-grade review by inspection + live `npm audit` + live web currency checks. **No SAST, no dynamic/DAST, no fuzzing.** It is **one input** to the dedicated independent review `docs/gap-analysis.md` (M05) lists as owed before public distribution — it does **not** discharge it.

---

## Update — 2026-06-17 independent review (amends the headline below)

A fresh-context **independent** audit (per `CODEBASE-AUDIT.md`, deliberately run without reading prior retrospectives or this record) was performed before open-sourcing. It **found one 🔴 the M05 passes below missed**, correcting the "0 🔴 across every pass" headline:

- **🔴 S2-001 — zip-slip in backup restore — CLOSED** (`fix/s2-001-backup-zip-slip`, commit `9ffc017`). `applyBackup` wrote each restored asset to `join(stagedAssets, ...relativePath.split('/'))` straight from an untrusted `.msbackup`, with **no confinement** — unlike every other disk write in the codebase (which goes through `confinedAssetPath`). A crafted `../`/absolute `relativePath` escaped staging → arbitrary attacker-byte file write on restore-confirm (RCE-adjacent). **Fix:** new `confinedStagingPath` primitive (rejects empty/absolute + `.`/`..` segments + a `resolve`/`relative` backstop for Windows `\` separators), applied at every staged write, throwing during **staging** (phase 1, pre-swap) so the rollback-safety property holds. RED-first, mutation-proved.
- **In-scope 🟡s also closed:** renderer-supplied model now allowlisted main-side (`isKnownModel`, defaults the forged id); generated body-content no longer logged to `main.log`; deny-by-default `setPermissionRequestHandler`; in-app `stripRemoteRefs` (app-owned, no longer relying solely on srcdoc CSP inheritance).
- **Secret scan:** `gitleaks` over full history → **0 leaks**; no `.env`/key files ever committed; no private-key blocks.
- **Lesson:** the M05 passes verified backup *rollback-safety* but not *path-confinement* on the restore write — a primitive's threat surface has more than one dimension. The independent fresh-context run is what caught it.

**Distribution posture:** the project ships as **open-source source** (build-from-source), not a stranger-facing packaged binary — so the owed *dynamic / third-party / signing* gates are scoped to "only if a packaged binary release is ever cut," not blocking the source release. The static + independent inspection above plus the clean secret scan are the security floor for the source release.

---

## Headline

- **0 🔴 across every pass.** No critical/high in the shipped product.
- The two crown-jewel surfaces are closed, defense-in-depth, and re-verified independently each pass:
  - **API key** — `safeStorage`-encrypted, main-only `getKeyForMain()`, no IPC channel, per-call read, key-free typed errors, no plaintext fallback. No leak path found.
  - **Untrusted LLM HTML** — in-app: DOMPurify + empty-`sandbox=""` iframe + inherited `script-src 'self'` CSP; on export: a blocking CSP `<meta>` + remote-ref strip. Both contexts closed.
- All SQL parameterized; FTS5 tokenized to literals; every disk path through one tested confinement primitive; IPC validated at the boundary; **no `dangerouslySetInnerHTML` / `eval` / `child_process` anywhere**.
- **Shipped deps current (web-verified 2026-06-08):** Electron 41.7.1 (latest 41.x, fully patched, one major behind 42.x); DOMPurify 3.4.8 (clean; 2026 CVEs top out at ≤3.3.1).

Every 🟡 ever raised is now **resolved or a documented/accepted decision.** What remains is a 🟢 hygiene backlog + the owed *dynamic* review.

---

## Run log

| # | Date | Depth / focus | Result | Net new vs prior |
|---|---|---|---|---|
| 1 | 2026-06-07 | standard / both | 0🔴 1🟡 5🟢 | S6-001 + the original 🟢 set |
| — | 2026-06-07 | post-pass follow-up | +1🟡 | S4-010 (export beacon) |
| 2 | 2026-06-08 | deep / both | 0🔴 1🟡 7🟢 | CFG-001 (env seam); re-verified the S6 fixes |
| 3 | 2026-06-08 | deep / both (CFG branch) | 0🔴 1🟡 6🟢 | DEP-001 (= already ADR-0005/TD-006); discharged the Electron/DOMPurify currency caveat |

**Reading of the arc:** passes 1–2 found *real* issues and they were fixed. Pass 3's "new 🟡" (DEP-001) is a re-derivation of an already-Accepted decision (see below), and its 🟢s are the same carry-forwards. The static audit has reached diminishing returns — see the Retrospective.

---

## Findings — RESOLVED 🟡

### S6-001 — No navigation / window-open lockdown — **RESOLVED** (PR #7)
The preload exposed the privileged `window.api` bridge to the top frame with no `setWindowOpenHandler(deny)` / `will-navigate` guard. No live vector existed (untrusted HTML caged in `sandbox=""`, notes are escaped React text, CSP `default-src 'self'`), but it was the standard Electron seatbelt.
**Fix:** `denyWindowOpen` + `shouldBlockNavigation` (pure seam in `electron/window-guards.ts`), wired in `main.ts`. Unit-tested; `tests/security/csp-layer.test.ts` extended.

### S4-001 — CSP hardening (`object-src` / `base-uri`) — **RESOLVED** (PR #7)
Added `object-src 'none'; base-uri 'self'` to the app CSP. `frame-ancestors` deliberately **omitted** — ignored in a `<meta>` CSP (emits a console warning; it's an HTTP-header directive, moot for a `file://` app). *(Lesson: this exact over-reach broke 6 e2e on the first attempt and was caught + reverted.)*

### G1-001 — `note:update` / `updateSync` byte cap — **RESOLVED** (PR #7)
Both now route through `asBoundedContent` (the same `MAX_NOTE_BYTES` cap `addWithContent` already had). A missing input cap on a write path.

### S4-010 — Self-contained export could phone home — **RESOLVED** (PR #9, FIX-S4-010 / M05.F)
The exported HTML carried no CSP and DOMPurify passes remote refs (`<img src>`, CSS `url()`, `@import`), so a prompt-injected remote ref in untrusted meeting content would beacon when the shared file is opened in a browser (in-app was already safe). **Fix (export-only, two layers):** a blocking CSP `<meta>` injected into the exported `<head>` (`default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:`) + an export-path `stripRemoteRefs`. Shared `sanitize-html.ts` left byte-stable. `tests/gen/export-html.test.ts` (both mutations); IRL-verified in Chrome (DevTools Network → no remote request).

### CFG-001 (+ the ELECTRON_RENDERER_URL instance) — env-seam class — **RESOLVED** (PR #10, FIX-CFG-001 / M05.G)
`MEETINGSPACE_USER_DATA` (redirected DB/key/blobs) and the audit-missed, higher-impact `ELECTRON_RENDERER_URL` (loaded a remote origin into the privileged window; the S6-001 nav guard doesn't cover the *initial* load) were honored in **packaged** builds, unlike the codebase's gated pattern. **Fix closes the class, not the instance:** all dev/test env reads route through one `!app.isPackaged`-gated accessor (`electron/dev-env.ts:devEnv`), and a guard test (`tests/security/env-seams.test.ts` — recursive scan + allowlist-of-one + anti-vacuous self-check) asserts zero raw `process.env` reads in `electron/` outside it. **The next ungated seam fails CI instead of shipping** (mutation-proven). All e2e run `app.isPackaged=false`, so their isolation is unbroken; unit tests force `isPackaged` to prove the packaged path ignores every override.

---

## Findings — KNOWN / ACCEPTED (not new work)

### DEP-001 — Dev-toolchain `npm audit` advisories — **ALREADY ADR-0005 + TD-006**
A full `npm audit` (without `--omit=dev`) reports criticals/moderates in **dev tooling only** (`vitest-ui` arbitrary-file-read/exec, `esbuild`/`vite` dev-server, `eslint` ReDoS). **This is a documented, deliberate decision, not a gap:**
- **ADR-0005 (Accepted, M02.A)** scopes the audit hard-gate to `--omit=dev` because every advisory is a `devDependency` not bundled into the shipped app; the prod surface (`react`, `better-sqlite3`) audits clean.
- **TD-002 / TD-006** already track the exact `vite`/`vitest`/`esbuild`/`eslint` chain, with the remediation plan (a coordinated semver-major bump — its own stage + ADR) and the ADR-0005 "revisit `--omit=dev`" trigger.
- **Impact:** bounded to an active dev-server/CI session; nothing reaches an end user of the packaged app.
- **Only actionable crumb:** add a *non-blocking* full-audit CI step beside the blocking prod gate (visibility into dev advisories over time). Cheap; fold into TD-006's toolchain bump. **Not a 🟡; no fix doc.**

---

## Findings — OPEN 🟢 (hygiene backlog; none ship-blocking)

Confirmed across passes, all low-impact / defense-in-depth. Tracked here and (where applicable) in `docs/tech-debt.md` (TD-011).

| ID | Item | Note |
|---|---|---|
| S3-001 | `model` string type-checked but not allowlisted main-side | bound to `shared/models.ts` catalog (TD-011) |
| G7-001 | Markdown export regex-strips the *unsanitized* doc | output is inert plain text — asymmetry only (TD-011) |
| G2-001 | Broad `catch {}` in degrade-to-default readers | observability; emit a key-free trace (TD-011) |
| — | `will-redirect` not guarded (parity with `will-navigate`) | defense-in-depth; mirror the S6-001 guard |
| — | No deny-all `setPermissionRequestHandler` | the app needs no web permissions; deny all |
| — | `gitleaks-action` pinned to a mutable tag, not a SHA | supply-chain hardening for CI |
| — | **Unsigned v1 binaries** | **the one 🟢 that matters for *public* distribution** — sign/notarize before strangers run it (ADR-0015 / TD) |

---

## Dependency & currency posture

- **Shipped (prod) deps:** `npm audit --omit=dev --audit-level=high` → **0**. Surface = `react`, `react-dom`, `better-sqlite3`, `@anthropic-ai/sdk`, DOMPurify.
- **Electron 41.7.1** — latest 41.x (2026-05-26), fully patched, one major behind 42.x (supported line). *(web-verified — releases.electronjs.org)*
- **DOMPurify 3.4.8** — clean; 2026 advisories top out at ≤3.3.1. *(web-verified — Snyk)*
- **Dev toolchain** — see DEP-001 (ADR-0005 / TD-006); advisories are dev-only, tracked, scoped out of the hard gate by design.

---

## Coverage caveat (what this record does and does NOT cover)

- **Method:** static review by inspection + live `npm audit` + live web currency checks. Tracked-tree only (git-history secret scan delegated to CI's `gitleaks`).
- **Covered:** key-handling path, IPC boundary validation, SQL/FTS injection surface, path confinement, the untrusted-HTML render+export controls, the env-seam class, dependency posture, dep currency.
- **NOT covered:** SAST, **dynamic / DAST**, fuzzing, runtime race-testing, a packaged-binary pen-test, git-history secret scan (CI covers that).
- **Confidence:** the resolved 🟡s are mutation-/test-verified; the 🟢s are confirmed-but-low-impact. This record does **not** discharge the owed dedicated independent review — it is one input.

---

## Retrospective — the audit arc

**What worked.** The static passes earned their keep early: three real issues surfaced and were fixed with tests + mutation checks — S6-001 (nav lockdown), S4-010 (export beacon), CFG-001 (env-seam class). The CFG-001 fix went further than the finding and installed a **CI guard that closes the whole class**, so that category can't recur — the single most valuable output of the whole exercise. One first-attempt over-reach (`frame-ancestors` in a `<meta>` CSP) was caught by the e2e and reverted, which is the process working, not failing.

**What the repetition revealed.** By pass 3 the audit was re-deriving the known backlog rather than finding new ground: DEP-001 restated an Accepted ADR (0005) + tracked tech-debt (TD-006), and the 🟢 set was the same carry-forwards. Each fresh-context pass independently rediscovers documented decisions because it (correctly, for bias-control) doesn't read the prior record — but the cost is churn that *reads* like new findings. The one genuinely new value in pass 3 was non-finding: confirming dep currency via live web checks.

**The lesson.** A fresh-context static audit converges fast and then flattens. The signal that it's done isn't "0 findings" — it's "the new 🟡 is a decision you already made." We hit that. **Stop re-running the static pass.**

**What's actually left** (unchanged, and not another static sweep):
- **Personal / internal-at-work use:** done. 0🔴 every pass, real findings fixed, the recurring class CI-guarded, shipped deps current.
- **Public distribution:** the *dynamic* layer (DAST / fuzzing / runtime) + **signing the binaries** — neither of which inspection can produce. That, plus the owed macOS `.zip` boot smoke, is the real remaining work before strangers run it.

---

## Sign-off

- **Status:** 0🔴; all 🟡 resolved or documented-accepted; 🟢 hygiene backlog open; shipped deps current.
- **Passes:** 2026-06-07 (standard) · 2026-06-08 (deep ×2). Static review; dynamic review owed.
- **Author:** independent fresh-context audit sessions, consolidated by the orchestrator (2026-06-08).
