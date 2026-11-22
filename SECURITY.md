# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's
[private vulnerability reporting](https://github.com/springmusk026/gateway-aws-quick/security/advisories/new)
instead, with steps to reproduce and the affected version or commit.

You can expect an acknowledgement within a few days. This is a hobby/educational project,
so there is no bug bounty.

## Scope

In scope: the Worker (`src/worker`), the admin UI (`src/web`) and the scripts in `scripts/`.
For example: auth bypass on the admin API, API key leaks, stored Quick tokens being exposed,
XSS in the dashboard, or weaknesses in how secrets are encrypted.

Out of scope: problems in Amazon Quick, Cloudflare, or third-party dependencies themselves
(report those upstream), and issues that require an attacker to already know your
`ADMIN_PASSWORD` or `ENCRYPTION_KEY`.

## Keeping your deployment safe

- Use a long, random `ADMIN_PASSWORD` and `ENCRYPTION_KEY`, set with `wrangler secret put`.
  Never commit `.dev.vars`, `.secrets` or `oauth-sessions.json` (all are gitignored).
- API keys (`qgk_…`) are shown once and stored only as SHA-256 hashes. Delete keys you no longer use.
- Quick tokens are encrypted at rest in KV. Rotating `ENCRYPTION_KEY` invalidates them, so import
  your accounts again afterwards.
- Do not expose your gateway URL publicly or share it with others. See [NOTICE.md](NOTICE.md).
