# quick-gateway

An OpenAI- and Anthropic-compatible API gateway for Amazon Quick, running as one Cloudflare Worker.

- **Stack:** Vite + React + shadcn-style components (admin UI), Hono (API), Cloudflare Workers with static assets, KV for storage.
- **Multi-account:** import several Quick logins. Requests go to the least recently used enabled account. If an account fails before it sends any output, the next one is tried.
- **Auth:** an admin page protected by a password (`ADMIN_PASSWORD`). Your API clients use keys you create on that page (`qgk_…`, stored only as SHA-256 hashes).
- **Based on:** [httpdone/magpie-aws-quick](https://github.com/httpdone/magpie-aws-quick) (MIT). The Quick chat WebSocket protocol and token refresh logic are ported from it.

> **Read this first.** The magpie README says this approach is personal use only, with your own account, and that it very likely violates AWS terms of service. Use it at your own risk. Do not share the gateway or your Quick logins with anyone else.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/chat/completions` | OpenAI Chat Completions (streaming and non-streaming, tools by text convention) |
| POST | `/v1/messages` | Anthropic Messages API (streaming and non-streaming) |
| GET | `/v1/models` | Lists `quick-fast`, `quick-balanced`, `quick-smart`, `quick-advanced` |
| GET | `/api/health` | Shows whether the secrets are set |

Client base URLs:

- OpenAI SDK: `https://<your-worker>/v1` (use an API key from the admin page)
- Anthropic SDK: `https://<your-worker>` (use the same key as the API key)

Model names containing `advanced`, `smart` or `opus`, `fast`, `haiku` or `mini` map to the matching Quick tier. Anything else uses `balanced`.

## Setup

1. **Install:** `npm install`
2. **Create the KV namespace** and paste its id into `wrangler.jsonc` (replace `REPLACE_WITH_KV_NAMESPACE_ID`):
   `npx wrangler kv namespace create STORE`
3. **Set the secrets** (they stay in Cloudflare, not in the repo):
   - `npx wrangler secret put ADMIN_PASSWORD`
   - `npx wrangler secret put ENCRYPTION_KEY` (a long random string; it encrypts stored logins and signs admin sessions)
4. **Deploy:** `npm run deploy` (builds the UI, then runs `wrangler deploy`)

Local development: copy `.dev.vars.example` to `.dev.vars` and fill in the two values. Then run `npm run dev` for the UI with the API proxied to port 8787, and `npm run worker:dev` for the Worker. `.dev.vars` is gitignored.

## Adding Quick accounts

**Recommended: sign in with the OAuth helper.** Run it on the same device as your browser (your computer or the phone's Linux shell), because Amazon only redirects the sign-in back to a loopback address (`127.0.0.1`), which the Worker cannot receive.

1. Create a `.secrets` file in the project folder (gitignored) with `GATEWAY_URL=https://<your-worker>` and `ADMIN_PASSWORD=...`, or export them as environment variables.
2. Run `node scripts/oauth-login.mjs --open` (or without `--open` and copy the printed link). Open the link and sign in to Amazon Quick.
3. Amazon redirects to `http://127.0.0.1:<port>`. The helper exchanges the code, checks the account, and saves the login to your gateway. Tokens and the password are never printed. Each link works for one run, and the helper stops after 10 minutes (`--timeout-min` changes that).
4. Press **Test** on the account in the admin page, then create an API key on the Keys tab. The key is shown once. Copy it.

**Fallback: import a file.** On your own computer, log in with magpie as its README describes. It writes an `oauth-sessions.json` file. Import that file on the Accounts tab (a plain array or a single session also works). Importing an account whose email is already listed updates that account.

Disable an account to take it out of rotation without deleting it. Delete removes its stored login from KV.

## Notes and limits

- **Secrets:** Quick tokens are encrypted in KV with `ENCRYPTION_KEY`. Changing that key makes stored logins unreadable (import them again) and signs out the admin page.
- **Token rotation:** A refresh can return a new refresh token, which is saved. KV is eventually consistent and tokens can rotate, so two requests refreshing the same account at the same moment could conflict. If an account starts failing, press **Test** or import it again.
- **Each request is a new Quick thread.** The conversation history is re-sent on every request, capped at about 56 KB. The oldest turns are dropped first. If the current message alone is too large, its beginning is cut and a note says so.
- **Tools:** tool definitions are passed to Quick as text, and the gateway parses `<tool_call>` blocks back out of the reply. When a request includes tools, the reply is buffered, so it is not streamed live.
- **Not supported:** images, and sampling parameters such as temperature (they are ignored). The Quick time zone is fixed to UTC.
- **Effort:** send an `x-quick-effort` header (`off`, `low`, `medium`, `high`, `max`) to set the reasoning effort.
- **Errors** are returned as OpenAI- or Anthropic-shaped JSON. Network failures give a short generic message. Token-refresh failures include the short error reason that AWS returns. Full details go to the Worker logs.

## Testing

- `npm run typecheck` runs TypeScript for both the UI and the Worker.
- `npm run build` builds the UI into `dist/`.
- `npx wrangler deploy --dry-run --outdir /tmp/qg-out` bundles the Worker without deploying it.
- `node scripts/smoke-test.mjs` runs 53 checks against that bundle (default `/tmp/qg-out/index.js`, or set `QG_BUNDLE`). It uses an in-memory KV and test data, and makes no AWS calls.
- `node --test scripts/oauth-login.test.mjs` runs 5 checks of the OAuth helper with a simulated browser and fake Amazon endpoints. It does not contact Amazon.
- `npx wrangler types --include-runtime=false` regenerates `worker-configuration.d.ts`. Plain `wrangler types` can hang in some sandboxes.
- `wrangler dev` needs a glibc-based system; it does not run on Alpine/musl.

The Worker was checked with `scripts/smoke-test.mjs`, which loads the bundled Worker with an in-memory KV store. It covered auth, account import and secret handling, API keys, OpenAI and Anthropic error shapes, and the unreachable-upstream path. The OAuth helper was run once live against Amazon Quick: the browser sign-in completed, the helper saved the account, and the admin API lists it as enabled. Chat through Quick has since been tested live: OpenAI and Anthropic routes (streaming and not), the admin Playground, and per-account usage counters. Note that a sign-in link expires quickly, so if the browser shows an expired page, run the helper again for a new link.

## Layout

```
src/worker/   Hono Worker: index.ts (routes), auth.ts, accounts.ts, quick.ts (WebSocket client),
              translate.ts, gateway.ts, openai.ts, anthropic.ts, crypto.ts, env.ts
src/web/      Admin UI: App.tsx (tabs), OverviewPanel, AccountsPanel, KeysPanel, PlaygroundPanel,
              ConnectPanel, LoginForm, lib/ (api, admin helpers), components/
scripts/      oauth-login.mjs (sign in to Quick and save the login), oauth-login.test.mjs,
              smoke-test.mjs (bundle checks), see Testing
wrangler.jsonc, vite.config.ts, tsconfig.app.json, tsconfig.worker.json
```

## License

MIT, see [LICENSE](LICENSE). Includes code ported from magpie-aws-quick (MIT).
