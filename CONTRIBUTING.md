# Contributing

Thanks for your interest. This is an educational project, so small, focused improvements are
welcome: bug fixes, tests, docs, and UI polish. Please read [NOTICE.md](NOTICE.md) first.
Contributions that aim at abuse (for example evading rate limits, detection or account
restrictions, or turning this into a shared/resold service) will not be accepted.

## Development

Requirements: Node.js 22.12 or newer (see `.nvmrc`) and a glibc-based system for `wrangler dev`.

```bash
npm ci
cp .dev.vars.example .dev.vars   # fill in local values
npm run worker:dev               # Worker on :8787
npm run dev                      # UI on Vite, /api and /v1 proxied to :8787
```

## Before opening a pull request

Run the full check. It is the same one CI runs:

```bash
npm run check
```

That runs the TypeScript checks, builds the UI, runs the OAuth helper tests and the smoke tests
against a bundled Worker (in-memory KV, no network calls to AWS).

Guidelines:

- Keep changes focused; one topic per pull request.
- Add or update a check in `scripts/smoke-test.mjs` when you change Worker behaviour.
- Never commit real tokens, passwords, session files or KV ids. Use obvious placeholders.
- Follow the existing style (2-space indent, no semicolons, single quotes).
