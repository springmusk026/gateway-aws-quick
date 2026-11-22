// Local smoke test: drives the bundled Worker (wrangler --dry-run output) with a fake KV.
// Test data only. The fake Quick session never reaches AWS (region and issuer do not resolve).
const worker = (await import(process.env.QG_BUNDLE ?? '/tmp/qg-out/index.js')).default

class FakeKV {
  constructor() { this.m = new Map() }
  async get(k, type) {
    if (!this.m.has(k)) return null
    const v = this.m.get(k)
    return type === 'json' ? JSON.parse(v) : v
  }
  async put(k, v) { this.m.set(k, String(v)) }
  async delete(k) { this.m.delete(k) }
  async list({ prefix = '' } = {}) {
    return { keys: [...this.m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }
  }
}

const PASSWORD = 'local-test-password'
const env = { STORE: new FakeKV(), ADMIN_PASSWORD: PASSWORD, ENCRYPTION_KEY: 'local-test-encryption-key-not-a-real-secret-0123456789' }
const unconfigured = { STORE: new FakeKV(), ADMIN_PASSWORD: '', ENCRYPTION_KEY: '' }

let failures = 0
function check(name, cond, detail) {
  if (!cond) failures++
  console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : JSON.stringify(detail).slice(0, 400))
}

async function call(e, method, path, { body, cookie, key, raw } = {}) {
  const headers = new Headers()
  if (cookie) headers.set('cookie', cookie)
  if (key) headers.set('authorization', `Bearer ${key}`)
  let payload
  if (raw !== undefined) { payload = raw; headers.set('content-type', 'application/json') }
  else if (body !== undefined) { payload = JSON.stringify(body); headers.set('content-type', 'application/json') }
  const res = await worker.fetch(new Request('http://localhost:8787' + path, { method, headers, body: payload }), e, { waitUntil() {}, passThroughOnException() {} })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = undefined }
  return { status: res.status, headers: res.headers, text, json }
}

const fakeSession = JSON.stringify({
  accounts: {
    smoke: {
      email: 'smoke-test@example.com',
      ws_host: 'quick.invalid.example',
      tokens: { id_token: 'fake-id-token', access_token: 'fake-access-token', refresh_token: 'fake-refresh-token-XYZ' },
      client: { client_id: 'fake-client-id', client_secret: 'fake-client-secret-ABC', idc_region: 'nowhere-1', issuer_url: 'https://issuer.invalid' },
    },
  },
})

// 1. Health and session state
let r = await call(env, 'GET', '/api/health')
check('health 200 configured', r.status === 200 && r.json?.ok === true && r.json?.configured === true, r)
r = await call(env, 'GET', '/api/auth/me')
check('auth/me unauthenticated', r.status === 200 && r.json?.authenticated === false, r)

// 2. Admin routes need a session
r = await call(env, 'GET', '/api/accounts')
check('accounts requires session (401)', r.status === 401, r)
r = await call(env, 'POST', '/api/keys', { body: { name: 'x' } })
check('keys requires session (401)', r.status === 401, r)

// 3. Login
r = await call(env, 'POST', '/api/auth/login', { body: { password: 'wrong' } })
check('wrong password 401 JSON', r.status === 401 && typeof r.json?.error === 'string', r)
r = await call(env, 'POST', '/api/auth/login', { body: { password: PASSWORD } })
const setCookie = r.headers.get('set-cookie') || ''
const cookie = setCookie.split(';')[0]
check('right password 200 + session cookie', r.status === 200 && cookie.startsWith('qg_session=') && cookie.length > 20, { status: r.status, setCookie })
check('session cookie is HttpOnly', /HttpOnly/i.test(setCookie), setCookie)
r = await call(env, 'GET', '/api/auth/me', { cookie })
check('auth/me authenticated with cookie', r.status === 200 && r.json?.authenticated === true, r)

// 4. Accounts
r = await call(env, 'GET', '/api/accounts', { cookie })
check('empty account list', r.status === 200 && Array.isArray(r.json?.accounts) && r.json.accounts.length === 0, r)
r = await call(env, 'POST', '/api/accounts/import', { cookie, body: { json: 'not json', label: '' } })
check('import invalid JSON -> 400', r.status === 400 && typeof r.json?.error === 'string', r)
r = await call(env, 'POST', '/api/accounts/import', { cookie, body: { json: '{"sessions":{"a":{"email":"x"}}}', label: '' } })
check('import incomplete session -> 400', r.status === 400, r)
r = await call(env, 'POST', '/api/accounts/import', { cookie, body: { json: fakeSession, label: 'Smoke account' } })
check('import fake session -> 200', r.status === 200 && r.json?.accounts?.length === 1, r)
const acctId = r.json?.accounts?.[0]?.id
r = await call(env, 'GET', '/api/accounts', { cookie })
check('account listed', r.status === 200 && r.json?.accounts?.length === 1 && r.json.accounts[0].label === 'Smoke account', r)
check('no secrets in account list', !/fake-refresh-token|fake-client-secret|fake-access-token/.test(r.text), r.text)
const rawValues = [...env.STORE.m.values()].join('\n')
check('refresh token not stored in plaintext', !rawValues.includes('fake-refresh-token-XYZ') && !rawValues.includes('fake-client-secret-ABC'), 'plaintext found in KV')
r = await call(env, 'PATCH', `/api/accounts/${acctId}`, { cookie, body: { enabled: false } })
check('disable account', r.status === 200 && r.json?.account?.enabled === false, r)
r = await call(env, 'PATCH', `/api/accounts/${acctId}`, { cookie, body: { enabled: true } })
check('re-enable account', r.status === 200 && r.json?.account?.enabled === true, r)
r = await call(env, 'PATCH', '/api/accounts/nope', { cookie, body: { enabled: false } })
check('patch unknown account -> 404', r.status === 404, r)
r = await call(env, 'POST', `/api/accounts/${acctId}/test`, { cookie })
check('test endpoint returns ok/message shape', r.status === 200 && typeof r.json?.ok === 'boolean' && typeof r.json?.message === 'string', r)
console.log('  info: test result ok=' + r.json?.ok + ' message=' + (r.json?.message || '').slice(0, 160))

// 5. API keys
r = await call(env, 'POST', '/api/keys', { cookie, body: { name: 'smoke key' } })
const key = r.json?.key
check('create key returns qgk_ key', r.status === 200 && typeof key === 'string' && key.startsWith('qgk_'), r)
const keyId = r.json?.record?.id
check('key record has hash id, no plaintext', /^[0-9a-f]{64}$/.test(keyId || '') && !JSON.stringify(r.json.record).includes(key), r)
check('plaintext key not stored in KV', ![...env.STORE.m.values()].some((v) => v.includes(key)), 'plaintext key found in KV')
r = await call(env, 'GET', '/api/keys', { cookie })
check('key listed without plaintext', r.status === 200 && r.json?.keys?.length === 1 && !r.text.includes(key), r)

// 6. OpenAI / Anthropic side auth
r = await call(env, 'GET', '/v1/models')
check('/v1/models without key -> 401 OpenAI error', r.status === 401 && typeof r.json?.error?.message === 'string', r)
r = await call(env, 'GET', '/v1/models', { key: 'qgk_wrong' })
check('/v1/models with wrong key -> 401', r.status === 401, r)
r = await call(env, 'GET', '/v1/models', { key })
check('/v1/models with key -> 4 models', r.status === 200 && r.json?.data?.length === 4, r)
r = await call(env, 'POST', '/v1/chat/completions', { key, raw: 'not json' })
check('chat with bad JSON -> 400 OpenAI error', r.status === 400 && typeof r.json?.error?.message === 'string', r)
r = await call(env, 'POST', '/v1/chat/completions', { key, body: { model: 'quick-balanced', messages: [{ role: 'user', content: 'hi' }] } })
console.log('  info: chat with unreachable upstream -> status ' + r.status + ' body ' + r.text.slice(0, 300))
check('chat with unreachable upstream -> error JSON, no stack', r.status >= 400 && r.json?.error && !/at .*\.(ts|js):\d+/.test(r.text), r)
r = await call(env, 'POST', '/v1/messages', { key, body: { model: 'quick-balanced', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } })
console.log('  info: messages with unreachable upstream -> status ' + r.status + ' body ' + r.text.slice(0, 300))
check('messages with unreachable upstream -> Anthropic error shape', r.status >= 400 && r.json?.type === 'error' && typeof r.json?.error?.type === 'string', r)
r = await call(env, 'POST', '/v1/messages', { key, raw: '{bad' })
check('messages with bad JSON -> 400 Anthropic error', r.status === 400 && r.json?.type === 'error', r)

// 7. Unknown routes
r = await call(env, 'GET', '/v1/nope', { key })
check('unknown /v1 route -> 404 JSON', r.status === 404 && typeof r.json?.error?.message === 'string', r)
r = await call(env, 'GET', '/api/nope', { cookie })
check('unknown /api route -> 404 JSON', r.status === 404 && typeof r.json?.error === 'string', r)

// 7b. Admin extras: key rename and last use, playground, per-account chat test, usage counters
r = await call(env, 'PATCH', `/api/keys/${keyId}`, { cookie, body: { name: 'renamed key' } })
check('rename key', r.status === 200 && r.json?.record?.name === 'renamed key', r)
r = await call(env, 'PATCH', `/api/keys/${keyId}`, { cookie, body: { name: '   ' } })
check('rename key to blank -> 400', r.status === 400 && typeof r.json?.error === 'string', r)
r = await call(env, 'PATCH', `/api/keys/${'0'.repeat(64)}`, { cookie, body: { name: 'x' } })
check('rename unknown key -> 404', r.status === 404, r)
r = await call(env, 'GET', '/api/keys', { cookie })
check('key lastUsed recorded after use', typeof r.json?.keys?.[0]?.lastUsed === 'number', r)
r = await call(env, 'POST', '/api/playground', { body: { model: 'quick-fast', messages: [{ role: 'user', content: 'hi' }] } })
check('playground requires session (401)', r.status === 401, r)
r = await call(env, 'POST', '/api/playground', { cookie, body: { model: 'quick-fast' } })
check('playground without messages -> 400', r.status === 400 && typeof r.json?.error === 'string', r)
r = await call(env, 'POST', '/api/playground', { cookie, body: { model: 'quick-fast', messages: [{ role: 'user', content: 'hi' }] } })
console.log('  info: playground with unreachable upstream -> status ' + r.status + ' body ' + r.text.slice(0, 200))
check('playground with unreachable upstream -> error JSON', r.status >= 400 && typeof r.json?.error === 'string', r)
r = await call(env, 'POST', `/api/accounts/${acctId}/chat`, { cookie })
check('account chat test -> ok:false with message', r.status === 200 && r.json?.ok === false && typeof r.json?.message === 'string', r)
r = await call(env, 'POST', '/api/accounts/nope/chat', { cookie })
check('chat test of unknown account -> ok:false', r.status === 200 && r.json?.ok === false, r)
r = await call(env, 'GET', '/api/accounts', { cookie })
check('failures counted on the account', (r.json?.accounts?.[0]?.failures ?? 0) >= 1, r)

// 8. Revoke key, then sign out
r = await call(env, 'DELETE', `/api/keys/${keyId}`, { cookie })
check('delete key ok', r.status === 200, r)
r = await call(env, 'GET', '/v1/models', { key })
check('deleted key no longer works', r.status === 401, r)
r = await call(env, 'DELETE', `/api/accounts/${acctId}`, { cookie })
check('delete account ok', r.status === 200, r)
check('account secret removed from KV', ![...env.STORE.m.keys()].some((k) => k.startsWith('acct')), [...env.STORE.m.keys()])
r = await call(env, 'POST', '/api/auth/logout', { cookie })
check('logout 200', r.status === 200, r)

// 8b. A session shaped the way scripts/oauth-login.mjs builds it must import (fake values)
const oauthEnv = { STORE: new FakeKV(), ADMIN_PASSWORD: PASSWORD, ENCRYPTION_KEY: env.ENCRYPTION_KEY }
const helperSession = {
  provider: 'social', stage: 'prod', tenant_url: 'https://acme.quick.example.com', ws_host: 'acme.quick.example.com',
  jwt: 'fake-id-token-h', actor_arn: 'arn:aws:quick::123456789012:user/alice', aws_account_id: '123456789012',
  account_name: 'Example', email: 'alice@example.com', display_name: 'Alice', region: 'us-east-1',
  usable_until: 4102444800, obtained_at: 1790000000, user_info: { email: 'alice@example.com' },
  tokens: { access_token: 'fake-access-h', refresh_token: 'fake-refresh-h', id_token: 'fake-id-token-h', expires_in: 3600 },
  client: { client_id: 'fake-client-h', client_secret: 'fake-secret-h', idc_region: 'us-east-1', issuer_url: 'https://identitycenter.example/issuer' },
  discovery: { issuer_url: 'https://identitycenter.example/issuer', tenant_url: 'https://acme.quick.example.com', account: '', idc_instance_id: '', idc_region: 'us-east-1' },
}
r = await call(oauthEnv, 'POST', '/api/auth/login', { body: { password: PASSWORD } })
const oauthCookie = (r.headers.get('set-cookie') || '').split(';')[0]
r = await call(oauthEnv, 'POST', '/api/accounts/import', { cookie: oauthCookie, body: { json: JSON.stringify(helperSession), label: '' } })
check('helper-shaped OAuth session imports -> 200', r.status === 200 && r.json?.accounts?.[0]?.email === 'alice@example.com', r)
check('helper session secrets not echoed', !/fake-refresh-h|fake-secret-h|fake-access-h/.test(r.text), r.text)
// Refresh regression: AWS may answer with accessToken only (HTTP 200). Stub the token endpoint.
const oauthAcctId = r.json?.accounts?.[0]?.id
const realFetch = globalThis.fetch
let refreshMode = 'access-only'
globalThis.fetch = async (url) => {
  const u = String(url)
  const json = { 'content-type': 'application/json' }
  if (u.includes('openid-configuration')) return new Response(JSON.stringify({ token_endpoint: 'https://oidc.example.test/token' }), { headers: json })
  if (u === 'https://oidc.example.test/token') {
    if (refreshMode === 'access-only') return new Response(JSON.stringify({ accessToken: 'fake-access-new', expiresIn: 3600 }), { status: 200, headers: json })
    return new Response('{"message":"invalid refresh","leaked":"leak-me-123"}', { status: 400, headers: json })
  }
  throw new Error('unexpected fetch in smoke test: ' + u)
}
try {
  r = await call(oauthEnv, 'POST', `/api/accounts/${oauthAcctId}/test`, { cookie: oauthCookie })
  check('refresh with only accessToken (HTTP 200) -> test ok', r.status === 200 && r.json?.ok === true, r)
  refreshMode = 'reject'
  r = await call(oauthEnv, 'POST', `/api/accounts/${oauthAcctId}/test`, { cookie: oauthCookie })
  check('failed refresh: short reason, raw body not echoed', r.json?.ok === false && !r.text.includes('leak-me-123'), r)
} finally {
  globalThis.fetch = realFetch
}

// 9. Not configured
r = await call(unconfigured, 'GET', '/api/auth/me')
check('unconfigured: auth/me says configured=false', r.status === 200 && r.json?.configured === false, r)
r = await call(unconfigured, 'POST', '/api/auth/login', { body: { password: 'x' } })
check('unconfigured: login -> 503', r.status === 503, r)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
