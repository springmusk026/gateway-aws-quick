import type { Env } from './env'
import { decryptJson, encryptJson, randomId } from './crypto'
import { QuickError } from './quick'

/** What the Worker needs to talk to Quick for one account. Stored encrypted in KV. */
export interface QuickSession {
  email: string
  wsHost: string
  actorArn: string
  clientId: string
  clientSecret: string
  region: string
  issuerUrl: string
  tokenEndpoint: string
  idToken: string
  accessToken: string
  refreshToken: string
  expiresAt: number // ms since epoch; 0 forces a refresh on next use
}

/** Public metadata, stored unencrypted at acct:<id> so the admin page can list it. */
export interface AccountMeta {
  id: string
  label: string
  email: string
  enabled: boolean
  status: 'ok' | 'needs_login'
  createdAt: string
  lastUsed: number
  lastError: string | null
  tokenExpiresAt: number
  // Usage counters (missing on accounts created before they existed). Updated with the
  // same KV write as lastUsed, so they cost nothing extra.
  requests?: number
  failures?: number
  inputTokens?: number
  outputTokens?: number
}

export interface UsageDelta {
  input: number
  output: number
}

export class AccountError extends Error {
  fatal: boolean
  constructor(message: string, fatal = false) {
    super(message)
    this.name = 'AccountError'
    this.fatal = fatal
  }
}

const REFRESH_MARGIN_MS = 120_000
const FALLBACK_TOKEN_ENDPOINT = (region: string) => `https://oidc.${region}.amazonaws.com/token`

// ---------- import ----------

type Raw = Record<string, any>

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Turn one session object (as written by magpie's oauth-sessions.json) into a QuickSession. */
function normalize(raw: Raw): QuickSession {
  const tokens: Raw = raw.tokens ?? {}
  const client: Raw = raw.client ?? {}
  const s: QuickSession = {
    email: str(raw.email),
    wsHost: str(raw.ws_host ?? raw.wsHost).replace(/^(wss?|https?):\/\//, '').replace(/\/+$/, ''),
    actorArn: str(raw.actor_arn ?? raw.actorArn),
    clientId: str(client.client_id ?? raw.client_id),
    clientSecret: str(client.client_secret ?? raw.client_secret),
    region: str(client.idc_region ?? raw.idc_region ?? raw.region),
    issuerUrl: str(client.issuer_url ?? raw.issuer_url),
    tokenEndpoint: '',
    idToken: str(tokens.id_token ?? raw.id_token),
    accessToken: str(tokens.access_token ?? raw.access_token),
    refreshToken: str(tokens.refresh_token ?? raw.refresh_token),
    expiresAt: 0,
  }
  if (!s.wsHost) throw new AccountError('Session has no ws_host. Log in again with magpie and export a fresh oauth-sessions.json.')
  if (!s.refreshToken || !s.clientId || !s.clientSecret) {
    throw new AccountError('Session has no refresh token or client credentials (client_id / client_secret). Log in again.')
  }
  if (!s.region && !s.issuerUrl) throw new AccountError('Session has no idc_region or issuer_url, so the token endpoint is unknown.')
  if (!s.email) s.email = s.actorArn || `account-${randomId('', 3)}`
  return s
}

/**
 * Accepts the magpie oauth-sessions.json file ({accounts:{key:session}}), a plain
 * array of sessions, or a single session object.
 */
export function parseImport(text: string): QuickSession[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new AccountError('That is not valid JSON.')
  }
  let list: Raw[]
  if (Array.isArray(data)) list = data as Raw[]
  else if (data && typeof data === 'object') {
    const obj = data as Raw
    if (obj.accounts && typeof obj.accounts === 'object') list = Object.values(obj.accounts) as Raw[]
    else if (obj.tokens || obj.refresh_token || obj.ws_host) list = [obj]
    else list = Object.values(obj).filter((v): v is Raw => !!v && typeof v === 'object')
  } else {
    throw new AccountError('Expected a JSON object or array of sessions.')
  }
  list = list.filter((x) => x && typeof x === 'object')
  if (!list.length) throw new AccountError('No sessions found in the file.')
  return list.map(normalize)
}

// ---------- KV storage ----------

const metaKey = (id: string) => `acct:${id}`
const secretKey = (id: string) => `acctsec:${id}`

export async function listAccounts(env: Env): Promise<AccountMeta[]> {
  const listed = await env.STORE.list({ prefix: 'acct:' })
  const metas = await Promise.all(listed.keys.map((k) => env.STORE.get<AccountMeta>(k.name, 'json')))
  return metas
    .filter((m): m is AccountMeta => Boolean(m))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

async function getMeta(env: Env, id: string): Promise<AccountMeta | null> {
  return env.STORE.get<AccountMeta>(metaKey(id), 'json')
}

async function putMeta(env: Env, meta: AccountMeta): Promise<void> {
  await env.STORE.put(metaKey(meta.id), JSON.stringify(meta))
}

/** Adds an account, or replaces the login of an existing account with the same email. */
export async function addAccount(env: Env, s: QuickSession, label?: string): Promise<AccountMeta> {
  const existing = (await listAccounts(env)).find((a) => a.email.toLowerCase() === s.email.toLowerCase())
  const meta: AccountMeta = existing
    ? { ...existing, status: 'ok', lastError: null, enabled: true }
    : {
        id: randomId('', 8),
        label: label?.trim() || s.email,
        email: s.email,
        enabled: true,
        status: 'ok',
        createdAt: new Date().toISOString(),
        lastUsed: 0,
        lastError: null,
        tokenExpiresAt: 0,
      }
  if (label?.trim() && existing) meta.label = label.trim()
  meta.tokenExpiresAt = s.expiresAt
  await env.STORE.put(secretKey(meta.id), await encryptJson(env.ENCRYPTION_KEY, s))
  await putMeta(env, meta)
  return meta
}

export async function updateAccount(env: Env, id: string, patch: { enabled?: boolean; label?: string }): Promise<AccountMeta | null> {
  const meta = await getMeta(env, id)
  if (!meta) return null
  if (typeof patch.enabled === 'boolean') meta.enabled = patch.enabled
  if (typeof patch.label === 'string' && patch.label.trim()) meta.label = patch.label.trim()
  await putMeta(env, meta)
  return meta
}

export async function deleteAccount(env: Env, id: string): Promise<boolean> {
  const meta = await getMeta(env, id)
  if (!meta) return false
  await env.STORE.delete(metaKey(id))
  await env.STORE.delete(secretKey(id))
  return true
}

async function loadSession(env: Env, id: string): Promise<QuickSession> {
  const payload = await env.STORE.get(secretKey(id))
  if (!payload) throw new AccountError('No stored login for this account. Import it again.', true)
  try {
    return await decryptJson<QuickSession>(env.ENCRYPTION_KEY, payload)
  } catch {
    throw new AccountError('Stored login could not be decrypted (ENCRYPTION_KEY changed?). Import it again.', true)
  }
}

// ---------- token refresh ----------

async function discoverTokenEndpoint(s: QuickSession): Promise<string> {
  if (s.issuerUrl) {
    try {
      const url = `${s.issuerUrl.replace(/\/+$/, '')}/.well-known/openid-configuration`
      const resp = await fetch(url, { headers: { accept: 'application/json' } })
      if (resp.ok) {
        const doc = (await resp.json()) as Raw
        if (typeof doc.token_endpoint === 'string' && doc.token_endpoint.startsWith('https://')) return doc.token_endpoint
      }
    } catch {
      // fall through to the regional endpoint
    }
  }
  if (!s.region) throw new AccountError('Cannot find the token endpoint: no region and discovery failed.')
  return FALLBACK_TOKEN_ENDPOINT(s.region)
}

async function refreshSession(s: QuickSession): Promise<QuickSession> {
  const endpoint = s.tokenEndpoint || (await discoverTokenEndpoint(s))
  let resp: Response
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        clientId: s.clientId,
        clientSecret: s.clientSecret,
        grantType: 'refresh_token',
        refreshToken: s.refreshToken,
      }),
    })
  } catch (err) {
    console.error('token refresh network error', err instanceof Error ? err.name : 'unknown')
    throw new AccountError('Could not reach AWS to refresh this login. Try again shortly.', false)
  }
  const text = await resp.text()
  let body: Raw = {}
  try {
    body = JSON.parse(text) as Raw
  } catch {
    // non-JSON error page
  }
  // Like magpie: a refresh may return only accessToken, so fall back to it for the chat token.
  const accessToken = str(body.accessToken) || str(body.access_token)
  const idToken = str(body.idToken) || str(body.id_token) || accessToken
  if (!resp.ok || !idToken) {
    // Never include the raw body: it contains tokens. Only the short error fields are shown.
    const reason = str(body.error_description) || str(body.error) || str(body.message) || (resp.ok ? 'no token in the response' : 'no error details')
    // 400/401/403 from the token endpoint mean the refresh token is no longer valid.
    const fatal = resp.status === 400 || resp.status === 401 || resp.status === 403
    throw new AccountError(`Token refresh failed (HTTP ${resp.status}): ${reason}`, fatal)
  }
  const expiresIn = Number(body.expiresIn ?? body.expires_in) > 0 ? Number(body.expiresIn ?? body.expires_in) : 3600
  return {
    ...s,
    tokenEndpoint: endpoint,
    idToken,
    accessToken: accessToken || s.accessToken,
    refreshToken: str(body.refreshToken) || str(body.refresh_token) || s.refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
  }
}

/**
 * Returns a session whose id token is valid for at least the next two minutes; refreshes and stores it if needed.
 * With force, always refreshes (used by the admin Test button to check the refresh token itself).
 */
export async function freshSession(env: Env, id: string, force = false): Promise<QuickSession> {
  let s = await loadSession(env, id)
  if (!force && s.idToken && s.expiresAt - REFRESH_MARGIN_MS > Date.now()) return s
  s = await refreshSession(s)
  await env.STORE.put(secretKey(id), await encryptJson(env.ENCRYPTION_KEY, s))
  const meta = await getMeta(env, id)
  if (meta) {
    meta.tokenExpiresAt = s.expiresAt
    await putMeta(env, meta)
  }
  return s
}

// ---------- selection and bookkeeping ----------

/** Enabled accounts that are not in needs_login, least recently used first. */
export async function pickAccounts(env: Env): Promise<AccountMeta[]> {
  return (await listAccounts(env))
    .filter((a) => a.enabled && a.status === 'ok')
    .sort((a, b) => a.lastUsed - b.lastUsed)
}

export async function recordUse(env: Env, id: string, usage?: UsageDelta): Promise<void> {
  const meta = await getMeta(env, id)
  if (!meta) return
  meta.lastUsed = Date.now()
  meta.lastError = null
  meta.requests = (meta.requests ?? 0) + 1
  if (usage) {
    meta.inputTokens = (meta.inputTokens ?? 0) + usage.input
    meta.outputTokens = (meta.outputTokens ?? 0) + usage.output
  }
  await putMeta(env, meta)
}

export async function recordFailure(env: Env, id: string, err: unknown): Promise<void> {
  const meta = await getMeta(env, id)
  if (!meta) return
  const known = err instanceof AccountError || err instanceof QuickError
  if (!known) console.error('account failure', err instanceof Error ? err.name : 'unknown')
  // Quick's own errors (timeouts, socket closed, stream errors) carry a useful message; show it.
  const message = known ? err.message : 'Unexpected error. Check the Worker logs.'
  meta.lastError = message.slice(0, 300)
  meta.lastUsed = Date.now()
  meta.failures = (meta.failures ?? 0) + 1
  if (err instanceof AccountError && err.fatal) meta.status = 'needs_login'
  await putMeta(env, meta)
}

/** Used by the admin "Test" button. Refreshes if needed and reports the outcome. */
export async function testAccount(env: Env, id: string): Promise<{ ok: boolean; message: string }> {
  try {
    const s = await freshSession(env, id, true)
    const meta = await getMeta(env, id)
    if (meta) {
      meta.status = 'ok'
      meta.lastError = null
      await putMeta(env, meta)
    }
    return {
      ok: true,
      message: `Refresh worked; new token good until ${new Date(s.expiresAt).toISOString()}. The Quick chat socket is only tested by a real request.`,
    }
  } catch (err) {
    await recordFailure(env, id, err)
    if (err instanceof AccountError) return { ok: false, message: err.message }
    return { ok: false, message: 'Something went wrong while checking this login. Check the Worker logs.' }
  }
}
