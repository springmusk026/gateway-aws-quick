import { createMiddleware } from 'hono/factory'
import { getCookie, setCookie } from 'hono/cookie'
import type { Context } from 'hono'
import type { Env } from './env'
import { hmacSign, hmacVerify, randomId, safeEqual, sha256Hex } from './crypto'

export const SESSION_COOKIE = 'qg_session'
const SESSION_TTL_S = 7 * 24 * 3600
const SESSION_PURPOSE = 'admin-session'
const KEY_TOUCH_MS = 10 * 60 * 1000

export function isConfigured(env: Env): boolean {
  return Boolean(env.ADMIN_PASSWORD && env.ENCRYPTION_KEY)
}

export async function checkAdminPassword(env: Env, given: unknown): Promise<boolean> {
  if (typeof given !== 'string' || !given || !env.ADMIN_PASSWORD) return false
  return safeEqual(given, env.ADMIN_PASSWORD)
}

/** Signed token "<expiresUnix>.<hmac>" stored in an HttpOnly cookie. */
export async function issueSessionToken(env: Env): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S
  const sig = await hmacSign(env.ENCRYPTION_KEY, SESSION_PURPOSE, String(exp))
  return `${exp}.${sig}`
}

export async function isValidSessionToken(env: Env, token: string | undefined): Promise<boolean> {
  if (!token || !env.ENCRYPTION_KEY) return false
  const dot = token.indexOf('.')
  if (dot < 0) return false
  const expStr = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false
  return hmacVerify(env.ENCRYPTION_KEY, SESSION_PURPOSE, expStr, sig)
}

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: SESSION_TTL_S,
  })
}

export function clearSessionCookie(c: Context): void {
  setCookie(c, SESSION_COOKIE, '', { httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: 0 })
}

/** Guards the admin JSON API (/api/accounts, /api/keys). */
export const requireAdmin = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  if (!isConfigured(c.env)) {
    return c.json({ error: 'Server not configured: set the ADMIN_PASSWORD and ENCRYPTION_KEY secrets.' }, 503)
  }
  const ok = await isValidSessionToken(c.env, getCookie(c, SESSION_COOKIE))
  if (!ok) return c.json({ error: 'Not signed in.' }, 401)
  await next()
})

export function newApiKey(): string {
  return `qgk_${randomId('', 24)}`
}

/** Guards the OpenAI/Anthropic-compatible endpoints (/v1/*). Keys are stored as SHA-256 hashes. */
export const requireApiKey = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const auth = c.req.header('authorization') ?? ''
  const token = auth.toLowerCase().startsWith('bearer ')
    ? auth.slice(7).trim()
    : (c.req.header('x-api-key') ?? '').trim()
  const message = 'Missing or invalid API key.'
  if (token) {
    const kvKey = `apikey:${await sha256Hex(token)}`
    const record = await c.env.STORE.get<{ lastUsed?: number }>(kvKey, 'json')
    if (record) {
      // "Last used" for the admin page, written at most every 10 minutes to stay within KV write limits.
      const now = Date.now()
      if (!record.lastUsed || now - record.lastUsed > KEY_TOUCH_MS) {
        const write = c.env.STORE.put(kvKey, JSON.stringify({ ...record, lastUsed: now })).catch(() => {})
        try {
          c.executionCtx.waitUntil(write)
        } catch {
          await write
        }
      }
      return next()
    }
  }
  if (c.req.path.endsWith('/messages')) {
    return c.json({ type: 'error', error: { type: 'authentication_error', message } }, 401)
  }
  return c.json({ error: { message, type: 'authentication_error', param: null, code: 'invalid_api_key' } }, 401)
})
