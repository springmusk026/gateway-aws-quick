import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import type { Env } from './env'
import {
  checkAdminPassword,
  clearSessionCookie,
  isConfigured,
  isValidSessionToken,
  issueSessionToken,
  newApiKey,
  requireAdmin,
  requireApiKey,
  SESSION_COOKIE,
  setSessionCookie,
} from './auth'
import { AccountError, addAccount, deleteAccount, listAccounts, parseImport, testAccount, updateAccount } from './accounts'
import { sha256Hex } from './crypto'
import { chatCompletions, openAIError } from './openai'
import { messages, anthropicError } from './anthropic'
import { jsonResponse } from './http'
import { estimateUsage, runGateway, toGatewayError, type RunOptions } from './gateway'
import { BadRequest, fromOpenAI } from './translate'

const MODELS = ['quick-fast', 'quick-balanced', 'quick-smart', 'quick-advanced']
const NOT_CONFIGURED = 'Server not configured: set the ADMIN_PASSWORD and ENCRYPTION_KEY secrets.'

interface KeyRecord {
  id: string // SHA-256 of the key; the plaintext is never stored
  name: string
  created: string
  lastUsed?: number // ms since epoch, updated at most every 10 minutes
}

/** Runs one non-streaming request for the admin page and times it. */
async function runOnce(env: Env, body: Record<string, unknown>, opts: RunOptions = {}) {
  const n = fromOpenAI(body, undefined)
  n.stream = false
  const started = Date.now()
  let text = ''
  let thinking = ''
  let input = 0
  let output = 0
  let usageSeen = false
  for await (const e of runGateway(env, n, opts)) {
    if (e.kind === 'text') text += e.text
    else if (e.kind === 'thinking') thinking += e.text
    else {
      usageSeen = true
      input += e.input
      output += e.output
    }
  }
  const usage = usageSeen ? { input, output } : estimateUsage(n, text, thinking)
  return { text, thinking, ms: Date.now() - started, usage, model: n.model }
}

const app = new Hono<{ Bindings: Env }>()

// ---- health and admin session ----

app.get('/api/health', (c) => c.json({ ok: true, configured: isConfigured(c.env) }))

app.get('/api/auth/me', async (c) => {
  const authenticated = await isValidSessionToken(c.env, getCookie(c, SESSION_COOKIE))
  return c.json({ configured: isConfigured(c.env), authenticated })
})

app.post('/api/auth/login', async (c) => {
  if (!isConfigured(c.env)) return c.json({ error: NOT_CONFIGURED }, 503)
  const body = (await c.req.json().catch(() => null)) as { password?: unknown } | null
  if (!(await checkAdminPassword(c.env, body?.password))) {
    // Slow down wrong guesses a little.
    await new Promise((resolve) => setTimeout(resolve, 500))
    return c.json({ error: 'Wrong password.' }, 401)
  }
  setSessionCookie(c, await issueSessionToken(c.env))
  return c.json({ ok: true })
})

app.post('/api/auth/logout', (c) => {
  clearSessionCookie(c)
  return c.json({ ok: true })
})

// ---- admin API (signed-in only) ----

app.use('/api/accounts', requireAdmin)
app.use('/api/accounts/*', requireAdmin)
app.use('/api/keys', requireAdmin)
app.use('/api/keys/*', requireAdmin)
app.use('/api/playground', requireAdmin)

// Chat from the admin page without an API key. Body: {model, system?, messages:[{role, content}]}
app.post('/api/playground', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || !Array.isArray(body.messages)) return c.json({ error: 'Send a model and messages.' }, 400)
  const model = typeof body.model === 'string' && MODELS.includes(body.model) ? body.model : 'quick-balanced'
  const system = typeof body.system === 'string' ? body.system.trim() : ''
  const messages = system ? [{ role: 'system', content: system }, ...body.messages] : body.messages
  try {
    return c.json(await runOnce(c.env, { model, messages }))
  } catch (err) {
    if (err instanceof BadRequest) return c.json({ error: err.message }, 400)
    const e = toGatewayError(err)
    return c.json({ error: e.message }, e.status as 400)
  }
})

// A real chat turn through one account (the Test button only checks the token refresh).
app.post('/api/accounts/:id/chat', async (c) => {
  try {
    const r = await runOnce(
      c.env,
      { model: 'quick-fast', messages: [{ role: 'user', content: 'Reply with just the word OK.' }] },
      { accountId: c.req.param('id') },
    )
    const reply = r.text.trim().slice(0, 200)
    return c.json({ ok: true, message: `Chat works (${(r.ms / 1000).toFixed(1)} s): "${reply || '(empty reply)'}"`, ms: r.ms })
  } catch (err) {
    return c.json({ ok: false, message: toGatewayError(err).message })
  }
})

app.get('/api/accounts', async (c) => c.json({ accounts: await listAccounts(c.env) }))

app.post('/api/accounts/import', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { json?: unknown; label?: unknown } | null
  if (!body || typeof body.json !== 'string' || !body.json.trim()) {
    return c.json({ error: 'Paste the contents of oauth-sessions.json first.' }, 400)
  }
  let sessions
  try {
    sessions = parseImport(body.json)
  } catch (err) {
    const message = err instanceof AccountError ? err.message : 'That does not look like an oauth-sessions.json file.'
    return c.json({ error: message }, 400)
  }
  const label = typeof body.label === 'string' ? body.label.trim().slice(0, 80) : ''
  const accounts = []
  for (const s of sessions) {
    // A custom label only makes sense for a single account.
    accounts.push(await addAccount(c.env, s, sessions.length === 1 && label ? label : undefined))
  }
  return c.json({ accounts })
})

app.patch('/api/accounts/:id', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return c.json({ error: 'Request body must be JSON.' }, 400)
  const patch: { enabled?: boolean; label?: string } = {}
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
  if (typeof body.label === 'string') patch.label = body.label.trim().slice(0, 80)
  const account = await updateAccount(c.env, c.req.param('id'), patch)
  if (!account) return c.json({ error: 'Account not found.' }, 404)
  return c.json({ account })
})

app.delete('/api/accounts/:id', async (c) => {
  const ok = await deleteAccount(c.env, c.req.param('id'))
  if (!ok) return c.json({ error: 'Account not found.' }, 404)
  return c.json({ ok: true })
})

app.post('/api/accounts/:id/test', async (c) => c.json(await testAccount(c.env, c.req.param('id'))))

app.get('/api/keys', async (c) => {
  const list = await c.env.STORE.list({ prefix: 'apikey:' })
  const keys: KeyRecord[] = []
  for (const k of list.keys) {
    const record = await c.env.STORE.get<KeyRecord>(k.name, 'json')
    if (record) keys.push(record)
  }
  keys.sort((a, b) => a.created.localeCompare(b.created))
  return c.json({ keys })
})

app.post('/api/keys', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null
  const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : 'API key'
  const key = newApiKey()
  const id = await sha256Hex(key)
  const record: KeyRecord = { id, name, created: new Date().toISOString() }
  await c.env.STORE.put(`apikey:${id}`, JSON.stringify(record))
  // The plaintext key is returned once and never stored.
  return c.json({ key, record })
})

app.patch('/api/keys/:id', async (c) => {
  const id = c.req.param('id')
  const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : ''
  if (!name) return c.json({ error: 'Give the key a name.' }, 400)
  const record = /^[0-9a-f]{64}$/.test(id) ? await c.env.STORE.get<KeyRecord>(`apikey:${id}`, 'json') : null
  if (!record) return c.json({ error: 'Key not found.' }, 404)
  const updated = { ...record, name }
  await c.env.STORE.put(`apikey:${id}`, JSON.stringify(updated))
  return c.json({ record: updated })
})

app.delete('/api/keys/:id', async (c) => {
  const id = c.req.param('id')
  if (!/^[0-9a-f]{64}$/.test(id) || !(await c.env.STORE.get(`apikey:${id}`))) {
    return c.json({ error: 'Key not found.' }, 404)
  }
  await c.env.STORE.delete(`apikey:${id}`)
  return c.json({ ok: true })
})

// ---- OpenAI- and Anthropic-compatible API (API key required) ----

app.use('/v1/*', requireApiKey)

app.get('/v1/models', (c) =>
  c.json({
    object: 'list',
    data: MODELS.map((id) => ({ id, object: 'model', created: 0, owned_by: 'quick-gateway' })),
  }),
)

app.post('/v1/chat/completions', (c) => chatCompletions(c))
app.post('/v1/messages', (c) => messages(c))

// ---- errors ----

app.notFound((c) => {
  const path = c.req.path
  if (path.startsWith('/v1/')) {
    return path.endsWith('/messages')
      ? jsonResponse(anthropicError('not_found_error', 'Not found.'), 404)
      : jsonResponse(openAIError('Not found.', 'invalid_request_error', 'not_found'), 404)
  }
  if (path.startsWith('/api/')) return c.json({ error: 'Not found.' }, 404)
  return c.text('Not found', 404)
})

app.onError((err, c) => {
  // Details go to the Worker logs only, never to the client.
  console.error('unhandled error', err instanceof Error ? err.name : 'unknown')
  const path = c.req.path
  if (path.startsWith('/v1/')) {
    return path.endsWith('/messages')
      ? jsonResponse(anthropicError('api_error', 'Internal gateway error.'), 500)
      : jsonResponse(openAIError('Internal gateway error.'), 500)
  }
  return c.json({ error: 'Internal error.' }, 500)
})

export default app
