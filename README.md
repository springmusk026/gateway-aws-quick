# quick-gateway

[![CI](https://github.com/springmusk026/gateway-aws-quick/actions/workflows/ci.yml/badge.svg)](https://github.com/springmusk026/gateway-aws-quick/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Cloudflare Workers](https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-f38020)

An OpenAI- and Anthropic-compatible API gateway for Amazon Quick, running as a single Cloudflare Worker
with a built-in admin dashboard.

> [!WARNING]
> **Educational project. Unofficial, and not affiliated with Amazon, AWS, OpenAI, Anthropic or Cloudflare.**
> Using Amazon Quick through a third-party gateway very likely violates the AWS terms of service and can get
> your account suspended. Use it only with your own account, for personal learning, at your own risk, and never
> share the gateway or your logins. Read the full **[NOTICE](NOTICE.md)** before using this code.

## Contents

- [What it is](#what-it-is)
- [Features](#features)
- [How it works](#how-it-works)
- [Endpoints](#endpoints)
- [Setup](#setup)
- [Adding Quick accounts](#adding-quick-accounts)
- [Using the API](#using-the-api)
- [Notes and limits](#notes-and-limits)
- [Development and testing](#development-and-testing)
- [Project layout](#project-layout)
- [Credits and license](#credits-and-license)

## What it is

quick-gateway is a learning project. It shows how to put a standard LLM API in front of a chat service that only
speaks its own WebSocket protocol, on Cloudflare's edge runtime:

- translating OpenAI Chat Completions and Anthropic Messages requests into one internal format and back,
- streaming responses as Server-Sent Events from an upstream WebSocket,
- encrypting third-party tokens at rest in Workers KV,
- OAuth sign-in with PKCE through a loopback redirect,
- a small React admin UI served from the same Worker.

## Features

- **Two API dialects:** OpenAI `/v1/chat/completions` and Anthropic `/v1/messages`, streaming and non-streaming.
- **Tool calling** through a text convention, parsed back into native `tool_calls` / `tool_use` blocks.
- **Multiple accounts:** requests go to the least recently used enabled account. If an account fails before any
  output is sent, the next one is tried.
- **API keys** (`qgk_…`) created in the dashboard, stored only as SHA-256 hashes, shown once.
- **Admin dashboard:** overview, accounts (test, enable/disable, usage counters), API keys, a chat playground,
  and copy-paste connection snippets. Works on phones.
- **Single deploy:** one Worker serves the API and the static UI; KV is the only storage.

Stack: Vite + React + Tailwind (shadcn-style components) for the UI, Hono for the API, Cloudflare Workers + KV.

## How it works

```
 OpenAI / Anthropic client
          │  HTTPS, API key (qgk_…)
          ▼
 ┌─────────────────────────── Cloudflare Worker ───────────────────────────┐
 │  Hono routes ─► auth (key hash lookup) ─► translate.ts (normalize)      │
 │                                             │                           │
 │  accounts.ts: pick least-recently-used ◄────┘   KV: encrypted tokens,   │
 │  account, refresh token if needed               key hashes, usage       │
 │                    │                                                    │
 │  quick.ts: one WebSocket per turn ─► AWS event-stream frames ─► SSE    │
 └────────────────────┼────────────────────────────────────────────────────┘
                      ▼
                Amazon Quick chat
```

Each request becomes a new Quick thread; the conversation history is sent along with it.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/chat/completions` | OpenAI Chat Completions (streaming and non-streaming, tools by text convention) |
| POST | `/v1/messages` | Anthropic Messages API (streaming and non-streaming) |
| GET | `/v1/models` | Lists `quick-fast`, `quick-balanced`, `quick-smart`, `quick-advanced` |
| GET | `/api/health` | Shows whether the secrets are set |

Model names containing `advanced`, `smart` or `opus`, `fast`, `haiku` or `mini` map to the matching Quick tier.
Anything else uses `balanced`.

## Setup

Requirements: a Cloudflare account, Node.js 22.12+ (see `.nvmrc`).

1. **Install dependencies**

   ```bash
   npm ci
   ```

2. **Create the KV namespace**, then paste the printed id into `wrangler.jsonc` in place of
   `REPLACE_WITH_KV_NAMESPACE_ID`:

   ```bash
   npx wrangler kv namespace create STORE
   ```

3. **Set the secrets.** They stay in Cloudflare, never in the repo.

   ```bash
   npx wrangler secret put ADMIN_PASSWORD
   ```

   ```bash
   npx wrangler secret put ENCRYPTION_KEY
   ```

   `ENCRYPTION_KEY` should be a long random string (for example the output of `openssl rand -base64 48`).
   It encrypts stored logins and signs admin sessions.

4. **Deploy.** This builds the UI and runs `wrangler deploy`.

   ```bash
   npm run deploy
   ```

5. Open `https://<your-worker>.workers.dev`, sign in with `ADMIN_PASSWORD`, then add an account (below)
   and create an API key on the **API keys** tab.

## Adding Quick accounts

**Recommended: the OAuth helper.** Run it on the same device as your browser, because Amazon only redirects the
sign-in back to a loopback address (`127.0.0.1`), which the Worker cannot receive.

1. Create a `.secrets` file in the project folder (gitignored, see `.secrets.example`) with
   `GATEWAY_URL=https://<your-worker>` and `ADMIN_PASSWORD=...`, or export them as environment variables.
2. Start the helper and sign in to Amazon Quick in the browser it opens (drop `--open` to just print the link):

   ```bash
   npm run login -- --open
   ```

3. Amazon redirects to `http://127.0.0.1:<port>`. The helper exchanges the code, checks the account, and saves the
   login to your gateway. Tokens and the password are never printed. Each link works for one run, and the helper
   stops after 10 minutes (`--timeout-min` changes that). Sign-in links expire quickly; if the browser shows an
   expired page, run the helper again.
4. Press **Test** on the account in the dashboard.

**Fallback: import a file.** Log in with [magpie-aws-quick](https://github.com/httpdone/magpie-aws-quick) on your own
computer as its README describes. It writes an `oauth-sessions.json` file; import it on the **Accounts** tab (a plain
array or a single session also works). Importing an account whose email is already listed updates it.

Disable an account to take it out of rotation without deleting it. **Delete** removes its stored login from KV.

## Using the API

Use the key from the **API keys** tab. It is accepted as `Authorization: Bearer <key>` or `x-api-key: <key>`.
The **Connect** tab in the dashboard generates these snippets with your URL filled in.

**curl (OpenAI format)**

```bash
curl https://<your-worker>/v1/chat/completions \
  -H "Authorization: Bearer $QG_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"quick-balanced","messages":[{"role":"user","content":"Hello"}]}'
```

**OpenAI SDK (Python)**

```python
from openai import OpenAI

client = OpenAI(base_url="https://<your-worker>/v1", api_key="qgk_...")
reply = client.chat.completions.create(
    model="quick-balanced",
    messages=[{"role": "user", "content": "Hello"}],
)
print(reply.choices[0].message.content)
```

**Anthropic SDK (Python)**

```python
from anthropic import Anthropic

client = Anthropic(base_url="https://<your-worker>", api_key="qgk_...")
reply = client.messages.create(
    model="quick-smart",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}],
)
print(reply.content[0].text)
```

Optional: send an `x-quick-effort` header (`off`, `low`, `medium`, `high`, `max`) to set the reasoning effort.

## Notes and limits

- **Secrets:** Quick tokens are encrypted in KV with `ENCRYPTION_KEY`. Changing that key makes stored logins
  unreadable (import them again) and signs out the admin page.
- **Token rotation:** a refresh can return a new refresh token, which is saved. KV is eventually consistent, so two
  requests refreshing the same account at the same moment could conflict. If an account starts failing, press
  **Test** or import it again.
- **Each request is a new Quick thread.** History is re-sent on every request, capped at about 56 KB; the oldest
  turns are dropped first. If the current message alone is too large, its beginning is cut and a note says so.
- **Tools:** tool definitions are passed to Quick as text, and `<tool_call>` blocks are parsed back out of the
  reply. When a request includes tools, the reply is buffered rather than streamed live.
- **Not supported:** images, and sampling parameters such as `temperature` (ignored). The Quick time zone is UTC.
- **Errors** are returned as OpenAI- or Anthropic-shaped JSON. Network failures give a short generic message;
  token-refresh failures include the short reason AWS returns. Full details go to the Worker logs (`wrangler tail`).

## Development and testing

Local development:

```bash
cp .dev.vars.example .dev.vars
```

Fill in the two values, then run the Worker and the UI in two terminals:

```bash
npm run worker:dev
```

```bash
npm run dev
```

The Vite dev server proxies `/api` and `/v1` to the Worker on port 8787. `wrangler dev` needs a glibc-based system
(it does not run on Alpine/musl).

| Command | What it does |
| --- | --- |
| `npm run check` | Everything below, the same as CI |
| `npm run typecheck` | TypeScript for both the UI and the Worker |
| `npm run build` | Builds the UI into `dist/` |
| `npm test` | OAuth helper tests + Worker smoke tests |
| `npm run test:oauth` | 5 checks of the OAuth helper with a simulated browser and fake Amazon endpoints |
| `npm run test:smoke` | Bundles the Worker (`wrangler deploy --dry-run`) and runs ~50 checks against it with an in-memory KV: auth, account import and secret handling, API keys, OpenAI/Anthropic error shapes, unreachable upstream |

None of the automated tests contact Amazon. To regenerate `worker-configuration.d.ts`, use
`npx wrangler types --include-runtime=false` (plain `wrangler types` can hang in some sandboxes).

The chat path has also been tested by hand against Amazon Quick: OpenAI and Anthropic routes (streaming and not),
the dashboard Playground, and the per-account usage counters.

## Project layout

```
src/worker/   Hono Worker: index.ts (routes), auth.ts, accounts.ts, quick.ts (WebSocket client),
              translate.ts, gateway.ts, openai.ts, anthropic.ts, crypto.ts, env.ts
src/web/      Admin UI: App.tsx (tabs), OverviewPanel, AccountsPanel, KeysPanel, PlaygroundPanel,
              ConnectPanel, LoginForm, lib/ (api, admin helpers), components/
scripts/      oauth-login.mjs (sign in and save the login), oauth-login.test.mjs, smoke-test.mjs
.github/      CI workflow, issue and pull request templates
wrangler.jsonc, vite.config.ts, tsconfig.app.json, tsconfig.worker.json
```

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Please report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).

## Credits and license

- Based on [httpdone/magpie-aws-quick](https://github.com/httpdone/magpie-aws-quick) (MIT). The Quick chat WebSocket
  protocol and token refresh logic are ported from it.
- Released under the [MIT License](LICENSE). See also [NOTICE.md](NOTICE.md) for the educational-use notice and
  disclaimer; it does not change the license terms.
