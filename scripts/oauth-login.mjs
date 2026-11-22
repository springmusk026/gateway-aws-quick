#!/usr/bin/env node
// Sign in to Amazon Quick with a real browser login and save the account to your gateway.
//
// This is the same OAuth flow the Quick desktop app uses:
//   1. The script listens on 127.0.0.1 and prints a sign-in link.
//   2. You open the link in a browser on THIS device and sign in to Amazon.
//   3. Amazon sends the browser back to http://127.0.0.1:<port>. The script registers
//      a client, exchanges the code (PKCE) and fetches your user info.
//   4. The session goes straight to your gateway (/api/accounts/import). Tokens and
//      the admin password are never printed.
//
// The browser must be on the same device as this script, because Amazon only accepts
// loopback redirects. That is why the Worker can't do this step on its own.
//
// Usage:  node scripts/oauth-login.mjs [--stage prod] [--port 0] [--timeout-min 10] [--open]
// Config: GATEWAY_URL and ADMIN_PASSWORD, from the environment or from .secrets in the
//         project folder (gitignored). Both are required.
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_GATEWAY = ''
const APP_VERSION = '1.2.4660'
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000

const SOCIAL_DISCOVERY = {
  prod: 'https://quick.aws.com/sn',
  beta: 'https://devtest.quicksuite.aws.dev/sn',
  integ: 'https://devtest.quicksuite.aws.dev/sn',
  dev: 'https://devtest.quicksuite.aws.dev/sn',
}
const SOCIAL_DATA_PLANE = {
  prod: 'https://cell001.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev',
  beta: 'https://cell001.dp.appintegrations.us-west-2.beta.plato.ai.aws.dev',
  integ: 'https://cell001.dp.appintegrations.us-west-2.beta.plato.ai.aws.dev',
  dev: 'https://cell001.dp.appintegrations.us-west-2.beta.plato.ai.aws.dev',
}
const SOCIAL_SCOPES = {
  prod: 'quicksight:read_write',
  beta: 'quicksight_test:read_write',
  integ: 'quicksight_test:read_write',
  dev: 'quicksight_test:read_write',
}

const b64url = (buf) => Buffer.from(buf).toString('base64url')
const randomToken = () => b64url(randomBytes(32))
const oneLine = (v) => String(v ?? '').split(/\s+/).join(' ').trim()
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

function decodeJwt(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'))
  } catch {
    return {}
  }
}

async function postJson(fetchImpl, url, body, headers = {}) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  const host = new URL(url).host
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${host}: ${text.slice(0, 300)}`)
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`invalid JSON from ${host}`)
  }
  if (!parsed || typeof parsed !== 'object') throw new Error(`unexpected JSON from ${host}`)
  return parsed
}

function normalizeUserInfo(raw) {
  if (raw && typeof raw.userInfo === 'object') raw = raw.userInfo
  const pick = (...keys) => {
    for (const k of keys) {
      const v = raw?.[k]
      if (v != null && v !== '') return oneLine(v)
    }
    return ''
  }
  return {
    email: pick('email', 'emailAddress'),
    user_name: pick('userName', 'user_name', 'username'),
    first_name: pick('firstName', 'first_name'),
    last_name: pick('lastName', 'last_name'),
    display_name: pick('displayName', 'display_name'),
    user_arn: pick('userArn', 'user_arn'),
    quicksight_external_user_arn: pick('quicksightExternalUserArn', 'quicksight_external_user_arn'),
    role: pick('role'),
    identity_type: pick('identityType', 'identity_type'),
    aws_account_id: pick('awsAccountId', 'aws_account_id', 'accountId'),
    account_name: pick('accountName', 'account_name'),
    external_id: pick('externalId', 'external_id'),
    account_ownership: pick('accountOwnership', 'account_ownership'),
  }
}

/** Assemble the session record from a completed login (the shape the gateway imports). */
export function buildSession(p, { stage = 'prod' } = {}) {
  let tenant = String(p.tenant_url || p.discovery?.tenant_url || '').replace(/\/+$/, '')
  if (!tenant) tenant = SOCIAL_DATA_PLANE[stage] || SOCIAL_DATA_PLANE.prod
  if (!/^https?:\/\//.test(tenant)) tenant = `https://${tenant}`
  const ws_host = new URL(tenant).host
  if (!ws_host) throw new Error('cannot derive ws_host from tenant_url')
  const jwt = p.tokens.id_token || p.tokens.access_token || ''
  if (!jwt) throw new Error('token response has no id_token or access_token')
  const claims = decodeJwt(p.tokens.id_token || '')
  const now = Math.floor(Date.now() / 1000)
  const expiresIn = Number(p.tokens.expires_in) || 0
  let actor_arn = p.user_info?.user_arn || ''
  if (!actor_arn && typeof claims.sub === 'string' && claims.sub.startsWith('arn:')) actor_arn = claims.sub
  return {
    provider: 'social',
    stage,
    tenant_url: tenant,
    ws_host,
    jwt,
    actor_arn,
    aws_account_id: p.user_info?.aws_account_id || claims.aws_account_id || '',
    account_name: p.user_info?.account_name || '',
    email: p.user_info?.email || '',
    display_name: p.user_info?.display_name || '',
    region: p.discovery?.idc_region || 'us-east-1',
    usable_until: expiresIn ? now + expiresIn : Number(claims.exp) || 0,
    obtained_at: now,
    user_info: p.user_info || {},
    tokens: { ...p.tokens },
    client: {
      client_id: p.client_id || '',
      client_secret: p.client_secret || '',
      idc_region: p.discovery?.idc_region || '',
      issuer_url: p.discovery?.issuer_url || '',
    },
    discovery: { ...p.discovery },
  }
}

const page = (title, text) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e8e8ea;font:16px/1.5 system-ui,sans-serif}
main{max-width:420px;margin:24px;padding:28px;border:1px solid #2a2e37;border-radius:14px;background:#171a21}
h1{font-size:20px;margin:0 0 8px}
p{margin:0;color:#b5bac4}
</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(text)}</p></main></body></html>`

const waitingPage = () => page('Waiting for sign-in', 'Finish signing in to Amazon. This page is only the callback; the script will say when the account is saved.')
const successPage = (who) => page('Signed in to Amazon Quick', `Signed in as ${who || 'your account'}. You can close this tab.`)
const errorPage = (message) => page('Sign-in did not finish', `${message} Run the script again to start over.`)

/**
 * Run the browser OAuth login. Resolves with a session object for saveToGateway().
 * Options exist mainly for tests: fetchImpl (AWS calls) and openBrowser (gets the sign-in URL).
 */
export function runOAuthLogin({
  stage = 'prod',
  port = 0,
  timeoutMs = LOGIN_TIMEOUT_MS,
  fetchImpl = fetch,
  openBrowser = null,
  log = () => {},
} = {}) {
  const state = randomToken()
  const nonce = randomToken()
  const verifier = randomToken()
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const scopes = SOCIAL_SCOPES[stage] || SOCIAL_SCOPES.prod
  const params = { discovery: {}, client_id: '', client_secret: '', tokens: {}, user_info: {}, tenant_url: '' }
  let redirectUri = ''
  let timer = null

  return new Promise((resolve, reject) => {
    let finished = false
    const finish = (fn, arg) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      try {
        server.close()
      } catch {}
      server.closeIdleConnections?.()
      fn(arg)
    }

    const send = (res, status, html, after) => {
      if (res.headersSent) return after?.()
      const data = Buffer.from(html)
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store' })
      res.end(data, () => after?.())
    }

    const server = createServer(async (req, res) => {
      const fail = (status, message) => {
        log(`Sign-in failed: ${message}`)
        send(res, status, errorPage(message), () => finish(reject, new Error(message)))
      }
      try {
        const u = new URL(req.url, 'http://127.0.0.1')
        if (u.pathname === '/favicon.ico') {
          res.writeHead(204)
          res.end()
          return
        }

        if (u.pathname === '/callback') {
          // Step 2: Amazon tells us who the tenant is. Register a public client for it.
          const q = u.searchParams
          if (q.get('nonce') !== nonce) return fail(400, 'Discovery nonce mismatch (stale sign-in link?).')
          if (q.get('error')) return fail(400, `Login failed: ${q.get('error')} ${q.get('error_description') || ''}`.trim())
          params.discovery = {
            issuer_url: q.get('issuerUrl') || q.get('issuer_url') || q.get('issuer') || '',
            tenant_url: q.get('tenantUrl') || q.get('tenant_url') || '',
            account: q.get('account') || '',
            idc_instance_id: q.get('idcInstanceId') || q.get('idc_instance_id') || '',
            idc_region: q.get('idcRegion') || q.get('idc_region') || 'us-east-1',
          }
          params.tenant_url = params.discovery.tenant_url
          if (!params.discovery.issuer_url) return fail(400, 'The discovery callback did not include an issuer URL.')
          const idcRegion = params.discovery.idc_region
          const client = await postJson(fetchImpl, `https://oidc.${idcRegion}.amazonaws.com/client/register`, {
            clientName: 'AmazonQuick-Desktop',
            clientType: 'public',
            scopes: [scopes],
            grantTypes: ['authorization_code', 'refresh_token'],
            redirectUris: [redirectUri],
            issuerUrl: params.discovery.issuer_url,
          })
          params.client_id = client.clientId || client.client_id || ''
          params.client_secret = client.clientSecret || client.client_secret || ''
          if (!params.client_id) return fail(502, 'Client registration returned no client ID.')
          const authUrl = new URL(`https://oidc.${idcRegion}.amazonaws.com/authorize`)
          authUrl.searchParams.set('response_type', 'code')
          authUrl.searchParams.set('client_id', params.client_id)
          authUrl.searchParams.set('redirect_uri', redirectUri)
          authUrl.searchParams.set('scope', scopes)
          authUrl.searchParams.set('state', state)
          authUrl.searchParams.set('code_challenge', challenge)
          authUrl.searchParams.set('code_challenge_method', 'S256')
          res.writeHead(302, { Location: authUrl.toString(), 'Cache-Control': 'no-store' })
          res.end()
          return
        }

        if (u.pathname === '/' || u.pathname === '/index.html') {
          // Step 3: AWS only accepts loopback redirects with an empty path, so the code lands on "/".
          const q = u.searchParams
          if (!q.has('code') && !q.has('state') && !q.has('error')) return send(res, 200, waitingPage())
          if (q.get('error')) return fail(400, `Sign-in failed: ${q.get('error')} ${q.get('error_description') || ''}`.trim())
          if (q.get('state') !== state) return fail(400, 'OAuth state mismatch.')
          const code = q.get('code')
          if (!code) return fail(400, 'The OAuth callback has no code.')
          const idcRegion = params.discovery.idc_region || 'us-east-1'
          const tok = await postJson(fetchImpl, `https://oidc.${idcRegion}.amazonaws.com/token`, {
            clientId: params.client_id,
            clientSecret: params.client_secret,
            grantType: 'authorization_code',
            code,
            redirectUri,
            codeVerifier: verifier,
          })
          params.tokens = {
            access_token: tok.accessToken || tok.access_token || '',
            refresh_token: tok.refreshToken || tok.refresh_token || '',
            id_token: tok.idToken || tok.id_token || '',
            expires_in: Number(tok.expiresIn ?? tok.expires_in ?? 0),
          }
          if (!params.tokens.id_token && !params.tokens.access_token) return fail(502, 'The token response had no ID or access token.')
          // Step 4: who is this? The user-info call goes to the data plane, not the tenant host.
          const base = String(params.tenant_url || '').replace(/\/+$/, '') || SOCIAL_DATA_PLANE[stage] || SOCIAL_DATA_PLANE.prod
          const infoBase = base.includes('dp.appintegrations') ? base : SOCIAL_DATA_PLANE[stage] || SOCIAL_DATA_PLANE.prod
          params.user_info = normalizeUserInfo(
            await postJson(fetchImpl, `${infoBase}/integration/quick-work/user-info`, {}, { Authorization: `Bearer ${params.tokens.access_token}` }),
          )
          const session = buildSession(params, { stage })
          const who = params.user_info.email || params.user_info.display_name || params.user_info.user_name || ''
          return send(res, 200, successPage(who), () => finish(resolve, session))
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('not found')
      } catch (err) {
        fail(502, err instanceof Error ? err.message : String(err))
      }
    })

    server.on('error', (err) => finish(reject, new Error(`Cannot listen on 127.0.0.1:${port}: ${err.message}`)))
    timer = setTimeout(
      () => finish(reject, new Error(`Timed out waiting for the browser sign-in (${Math.round(timeoutMs / 60000)} min).`)),
      timeoutMs,
    )
    server.listen(port, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${server.address().port}`
      const surface = encodeURIComponent(`desktop:${nonce}:${server.address().port}:${APP_VERSION}`)
      const url = `${SOCIAL_DISCOVERY[stage] || SOCIAL_DISCOVERY.prod}?qwSurface=${surface}`
      log(`Open this sign-in link in a browser on this device:\n${url}`)
      log('Waiting for the sign-in to finish…')
      if (openBrowser) Promise.resolve(openBrowser(url)).catch(() => log('Could not open a browser; use the link above.'))
    })
  })
}

/**
 * Add the session to the gateway as an account. Logs in as admin first, then imports.
 * Returns the saved account list. Throws with a short message on failure.
 */
export async function saveToGateway(session, { gatewayUrl = DEFAULT_GATEWAY, password, fetchImpl = fetch } = {}) {
  const base = gatewayUrl.replace(/\/+$/, '')
  const login = await fetchImpl(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  if (!login.ok) throw new Error(`Gateway sign-in failed (HTTP ${login.status}). Check ADMIN_PASSWORD.`)
  const setCookies = typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie() : [login.headers.get('set-cookie') || '']
  const cookie = setCookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('qg_session='))
  if (!cookie) throw new Error('The gateway did not return a session cookie.')

  const res = await fetchImpl(`${base}/api/accounts/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ json: JSON.stringify(session) }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`The gateway rejected the session (HTTP ${res.status}): ${data.error || 'unknown error'}`)
  return data.accounts || []
}

/** Reads KEY=VALUE lines (ignores comments and blanks). Values are never logged. */
export function readSecrets(file) {
  const out = {}
  if (!existsSync(file)) return out
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

function openInBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : ['xdg-open', [url]]
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

function parseArgs(argv) {
  const opts = { stage: 'prod', port: 0, timeoutMin: 10, open: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--stage') opts.stage = argv[++i]
    else if (a === '--port') opts.port = Number(argv[++i])
    else if (a === '--timeout-min') opts.timeoutMin = Number(argv[++i])
    else if (a === '--open') opts.open = true
    else throw new Error(`Unknown option: ${a}`)
  }
  if (!SOCIAL_DISCOVERY[opts.stage]) throw new Error(`Unknown stage "${opts.stage}" (use prod, beta, integ or dev).`)
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new Error('--port must be 0 to 65535 (0 picks a free port).')
  if (!(opts.timeoutMin > 0)) throw new Error('--timeout-min must be a positive number.')
  return opts
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(argv)
  const secrets = readSecrets(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.secrets'))
  const get = (k) => env[k] || secrets[k] || ''
  const gatewayUrl = get('GATEWAY_URL') || DEFAULT_GATEWAY
  if (!gatewayUrl) throw new Error('GATEWAY_URL is not set. Add it to .secrets in the project folder or the environment, e.g. https://quick-gateway.<your-subdomain>.workers.dev')
  const password = get('ADMIN_PASSWORD')
  if (!password) throw new Error('ADMIN_PASSWORD is not set. Add it to .secrets in the project folder or the environment.')

  console.log(`Gateway: ${gatewayUrl}`)
  const session = await runOAuthLogin({
    stage: opts.stage,
    port: opts.port,
    timeoutMs: opts.timeoutMin * 60_000,
    log: console.log,
    openBrowser: opts.open ? openInBrowser : null,
  })
  console.log(`Signed in as ${session.email || session.actor_arn || 'unknown user'}${session.aws_account_id ? ` (AWS account ${session.aws_account_id})` : ''}.`)
  const accounts = await saveToGateway(session, { gatewayUrl, password })
  console.log(`Saved to your gateway: ${accounts.map((a) => a.email).join(', ') || 'done'}.`)
  return accounts
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(`Sign-in failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    },
  )
}
