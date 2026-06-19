# Security Policy

## Reporting a Vulnerability

**Do not file a public report** for security vulnerabilities. (Issues are disabled on this repository — and please don't open a public pull request describing a live vulnerability either.) Public disclosure before a fix is available puts users at risk.

Instead, use one of these private channels:

- **GitHub Security Advisories** (preferred): https://github.com/kknipe2k/meetingspace/security/advisories/new
- **Private email** to the maintainer contact: ardenagentic+security@gmail.com

Please include:

- Affected version (commit SHA or release tag)
- Description of the issue
- Steps to reproduce (or proof-of-concept, if safe to share)
- Impact assessment as you see it
- Any mitigating factors you're aware of
- Whether you'd like public credit (and how you'd like to be credited)

MeetingSpace is built from source per platform and shipped as-is; security fixes target the latest commit on `main` and the most recent release artifact. There are no back-ported patches for older builds.

## Response Timeline

This is a single-maintainer project. We aim for the following once a report is received:

| Severity (CVSS v3.1) | Acknowledgment | Initial assessment | Fix target |
|---|---|---|---|
| Critical (9.0–10.0) | within 24 hours | within 72 hours | within 14 days |
| High (7.0–8.9) | within 48 hours | within 7 days | within 30 days |
| Medium (4.0–6.9) | within 7 days | within 14 days | within 60 days |
| Low (0.1–3.9) | within 14 days | within 30 days | next release |

These are targets, not guarantees — a solo project misses SLOs sometimes, and we'll say so when it happens.

## Disclosure Policy

- **Embargo:** 90 days from initial report by default. Extends if the fix is genuinely complex; shortens if active exploitation is observed.
- **Coordinated disclosure:** the reporter and maintainer agree on a publication date once a fix is staged.
- **CVE:** requested via GitHub Security Advisories for any vulnerability that warrants one.
- **Credit:** the reporter is credited in the release notes and the published advisory unless they prefer anonymity.
- **Active exploitation:** if exploitation is observed in the wild, the embargo is dropped — we publish what we know immediately, with mitigation guidance.

## Scope

MeetingSpace is a **local-first, single-user desktop app**. There is no server, no account, and no cloud sync — the only outbound network calls are the Anthropic API requests you trigger with your own key. The security-relevant surface is the desktop client itself.

In scope:

- The packaged application and its dependencies as shipped in a release artifact.
- The Electron main ↔ renderer boundary: `contextIsolation`, `nodeIntegration: false`, the preload bridge, and the IPC handlers.
- API-key handling: the OS keychain integration (`safeStorage`) and the guarantee that the key stays in the main process (never in the renderer, logs, or source).
- The Anthropic API client and its streaming/SSE parsing (main process).
- Sanitization and isolation of LLM-generated / untrusted HTML: DOMPurify, the sandboxed `iframe`, and the Content-Security-Policy.
- The self-contained HTML export: its blocking CSP and remote-reference stripping (a shared export must not phone home).
- `better-sqlite3` local storage handling.

Out of scope:

- Vulnerabilities in Anthropic's API itself (report those to Anthropic).
- Self-inflicted issues from sharing your API key, or from installing an unsigned build from an untrusted source after the OS warning.
- Issues requiring physical access to an unlocked, logged-in device.
- The content you choose to capture (notes, screenshots, transcripts) — that is your local data; protecting the device and disk is the OS's job.

## Threat Model

The notes you capture and the HTML the model generates are **untrusted input**. The main risks and mitigations:

- **Malicious / prompt-injected content in generated HTML** — meeting content could steer the model into emitting hostile markup. Mitigated by sanitizing every generated document with DOMPurify and rendering it in an isolated `sandbox` iframe under a strict CSP.
- **API-key exfiltration** — the key is the crown jewel. Mitigated by keeping it encrypted in the OS keychain, confining all SDK calls to the main process, and never writing it to logs or disk in plaintext. (CI has a "key-never-plaintext" gate.)
- **A shared export phoning home** — the self-contained HTML export carries its own blocking CSP and strips remote references, so a file you send to someone can't beacon out.

We do **not** defend against secrets you paste into your own notes, a host OS that is already compromised, or builds obtained from somewhere other than this repository's releases.

## What's Safe to Share

When reporting, err on the side of less initially. We may follow up for exact reproduction steps once a private channel is established.

Do **not** include:

- Your Anthropic API key (or anyone else's).
- Real meeting content, screenshots, or personal data — sanitize or synthesize a minimal repro instead.

## After a Fix Lands

- The vulnerability is described in the release notes under "Security" with severity, affected versions, and the remediation version.
- A GitHub Security Advisory is published.
- A CVE (if assigned) is referenced from both.
- The reporter is notified before public disclosure.

## Maintainer contact

Security reports: **ardenagentic+security@gmail.com**, or — preferred — GitHub Security Advisories (link at the top of this file). Monitored by the project maintainer.
