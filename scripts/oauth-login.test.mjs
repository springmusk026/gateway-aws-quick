// Tests for the OAuth helper. Amazon's endpoints and the browser are simulated, so
// this checks our side of the flow (nonce, PKCE, state, session shape, gateway import),
// not Amazon itself. Run: node --test scripts/oauth-login.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { runOAuthLogin, saveToGateway } from './oauth-login.mjs'

const b64url = (buf) => Buffer.from(buf).toString('base64url')
const fakeJwt = (claims) => `${b64url(JSON.stringify({ alg: 'none' }))}.${b64url(JSON.stringify(claims))}.sig`

/** Fake AWS: client registration, token exchange (checks PKCE) and user-info. */
function fakeAws(ctx) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url)
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ url, body, headers: init.headers || {} })
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })
    if (u.host === 'oidc.us-east-1.amazonaws.com' && u.pathname === '/client/register') {
      return json({ clientId: 'client-123', clientSecret: 'secret-456' })
    }
    if (u.host === 'oidc.us-east-1.amazonaws.com' && u.pathname === '/token') {
      if (b64url(createHash('sha256').update(body.codeVerifier).digest()) !== ctx.challenge) {
        return json({ error: 'invalid_grant', error_description: 'PKCE mismatch' }, 400)
      }
      return json({
        accessToken: 'access-abc',
        refreshToken: 'refresh-def',
        idToken: fakeJwt({ sub: 'user-sub', exp: 4102444800 }),
        expiresIn: 3600,
      })
    }
    if (u.pathname === '/integration/quick-work/user-info') {
      return json({
        userInfo: {
          email: 'alice@example.com',
          userName: 'alice',
          displayName: 'Alice',
          userArn: 'arn:aws:quick::123456789012:user/alice',
          awsAccountId: '123456789012',
          accountName: 'Example',
        },
      })
    }
    throw new Error(`unexpected request to ${url}`)
  }
  return { fetchImpl, calls }
}

/** Plays the browser: follows Amazon's redirects to our loopback server. */
async function playBrowser(startUrl, { nonce: nonceOverride, state: stateOverride, ctx, code = 'auth-code-1' } = {}) {
  const [, nonce, port] = new URL(startUrl).searchParams.get('qwSurface').split(':')
  const cb = await fetch(
    `http://127.0.0.1:${port}/callback?nonce=${nonceOverride ?? nonce}` +
      `&issuerUrl=${encodeURIComponent('https://identitycenter.example/issuer')}` +
      `&tenantUrl=${encodeURIComponent('https://acme.quick.example.com')}&idcRegion=us-east-1`,
    { redirect: 'manual' },
  )
  const status = cb.status
  const location = cb.headers.get('location') || ''
  await cb.text()
  if (status !== 302) return { status, location: '' }
  const auth = new URL(location)
  assert.equal(auth.origin + auth.pathname, 'https://oidc.us-east-1.amazonaws.com/authorize')
  assert.equal(auth.searchParams.get('client_id'), 'client-123')
  assert.equal(auth.searchParams.get('redirect_uri'), `http://127.0.0.1:${port}`)
  assert.equal(auth.searchParams.get('scope'), 'quicksight:read_write')
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256')
  if (ctx) ctx.challenge = auth.searchParams.get('code_challenge')
  // Amazon sends the code back to the loopback root.
  const state = stateOverride ?? auth.searchParams.get('state')
  const done = await fetch(`http://127.0.0.1:${port}/?code=${code}&state=${state}`)
  const html = await done.text()
  return { status: done.status, html }
}

test('completes the OAuth flow and returns a session the gateway can import', async () => {
  const ctx = {}
  const aws = fakeAws(ctx)
  let browser
  const session = await runOAuthLogin({
    fetchImpl: aws.fetchImpl,
    timeoutMs: 5000,
    openBrowser: (url) => {
      browser = playBrowser(url, { ctx })
      return browser
    },
  })
  const page = await browser
  assert.equal(page.status, 200)
  assert.match(page.html, /Signed in as alice@example\.com/)

  // Session shape: what the gateway's parseImport needs.
  assert.equal(session.ws_host, 'acme.quick.example.com')
  assert.equal(session.email, 'alice@example.com')
  assert.equal(session.aws_account_id, '123456789012')
  assert.equal(session.actor_arn, 'arn:aws:quick::123456789012:user/alice')
  assert.equal(session.client.client_id, 'client-123')
  assert.equal(session.client.client_secret, 'secret-456')
  assert.equal(session.client.idc_region, 'us-east-1')
  assert.equal(session.client.issuer_url, 'https://identitycenter.example/issuer')
  assert.equal(session.tokens.access_token, 'access-abc')
  assert.equal(session.tokens.refresh_token, 'refresh-def')
  assert.ok(session.tokens.id_token)
  assert.ok(session.jwt)

  // The token exchange carries the code and the PKCE verifier; the fake AWS already
  // checked the verifier against the challenge Amazon saw.
  const token = aws.calls.find((c) => c.url.endsWith('/token'))
  assert.equal(token.body.grantType, 'authorization_code')
  assert.equal(token.body.code, 'auth-code-1')
  assert.match(token.body.redirectUri, /^http:\/\/127\.0\.0\.1:\d+$/)

  // User info goes to the data plane, with the access token.
  const info = aws.calls.find((c) => c.url.includes('/integration/quick-work/user-info'))
  assert.match(info.url, /^https:\/\/cell001\.dp\.appintegrations\.us-east-1\.prod\./)
  assert.equal(info.headers.Authorization, 'Bearer access-abc')
})

test('rejects a callback whose nonce does not match', async () => {
  const aws = fakeAws({})
  let page
  const login = runOAuthLogin({
    fetchImpl: aws.fetchImpl,
    timeoutMs: 5000,
    openBrowser: (url) => {
      page = playBrowser(url, { nonce: 'not-the-nonce' })
      return page
    },
  })
  await assert.rejects(login, /nonce mismatch/)
  assert.equal((await page).status, 400)
  assert.equal(aws.calls.length, 0, 'no AWS calls after a bad nonce')
})

test('rejects a return with the wrong state', async () => {
  const ctx = {}
  const aws = fakeAws(ctx)
  let page
  const login = runOAuthLogin({
    fetchImpl: aws.fetchImpl,
    timeoutMs: 5000,
    openBrowser: (url) => {
      page = playBrowser(url, { ctx, state: 'forged-state' })
      return page
    },
  })
  await assert.rejects(login, /state mismatch/)
  assert.equal((await page).status, 400)
  assert.equal(aws.calls.some((c) => c.url.endsWith('/token')), false, 'no token exchange with a forged state')
})

test('times out when nobody finishes the sign-in', async () => {
  await assert.rejects(runOAuthLogin({ timeoutMs: 100, fetchImpl: fakeAws({}).fetchImpl }), /Timed out/)
})

test('saveToGateway logs in as admin and imports the session as JSON', async () => {
  const session = { email: 'a@example.com', ws_host: 'x.example.com', tokens: { refresh_token: 'r' } }
  const seen = {}
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    if (req.url === '/api/auth/login') {
      seen.password = body.password
      if (body.password !== 'pw') {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: 'Wrong password.' }))
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'qg_session=sess-token; Path=/; HttpOnly; Secure; SameSite=Strict',
      })
      return res.end(JSON.stringify({ ok: true }))
    }
    if (req.url === '/api/accounts/import') {
      seen.cookie = req.headers.cookie
      seen.json = body.json
      const parsed = JSON.parse(body.json)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ accounts: [{ email: parsed.email }] }))
    }
    res.writeHead(404)
    res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const gatewayUrl = `http://127.0.0.1:${server.address().port}/`
  try {
    const accounts = await saveToGateway(session, { gatewayUrl, password: 'pw' })
    assert.deepEqual(accounts, [{ email: 'a@example.com' }])
    assert.equal(seen.password, 'pw')
    assert.equal(seen.cookie, 'qg_session=sess-token')
    assert.deepEqual(JSON.parse(seen.json), session)

    await assert.rejects(saveToGateway(session, { gatewayUrl, password: 'wrong' }), /Check ADMIN_PASSWORD/)
  } finally {
    server.closeAllConnections()
    server.close()
  }
})
