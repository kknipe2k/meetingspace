# Security

MeetingSpace is a local-first, single-user desktop app. There's no server or account — the only outbound network call is the Claude API request you trigger with your own key. Your API key is encrypted by the OS keychain and never written to disk or logs in plaintext; content the model generates is sanitized and sandboxed.

## Reporting a vulnerability

Please report security issues **privately** — don't open a public report.

- **GitHub Security Advisories** (preferred): <https://github.com/kknipe2k/meetingspace/security/advisories/new>
- **Email:** ardenagentic+security@gmail.com

Include the affected version (commit or release), what the issue is, and how to reproduce it. This is a personal project shared as-is, so there's no formal response SLA — but reports are read and genuine issues will be looked at.
