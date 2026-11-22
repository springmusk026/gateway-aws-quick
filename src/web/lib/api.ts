// Thin client for the Worker's admin API (same origin, cookie session).

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export interface AuthState {
  configured: boolean
  authenticated: boolean
}

export interface Account {
  id: string
  label: string
  email: string
  enabled: boolean
  status: 'ok' | 'needs_login'
  createdAt: string
  lastUsed: number
  lastError: string | null
  tokenExpiresAt: number
  requests?: number
  failures?: number
  inputTokens?: number
  outputTokens?: number
}

export interface ApiKeyRecord {
  id: string
  name: string
  created: string
  lastUsed?: number
}

export interface TestResult {
  ok: boolean
  message: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface PlaygroundReply {
  text: string
  thinking: string
  ms: number
  usage: { input: number; output: number }
  model: string
}

// Keep in sync with MODELS in src/worker/index.ts.
export const MODELS = [
  { id: 'quick-fast', note: 'Quickest replies' },
  { id: 'quick-balanced', note: 'Good default' },
  { id: 'quick-smart', note: 'More careful' },
  { id: 'quick-advanced', note: 'Hardest tasks, slowest' },
] as const

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin' }
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const res = await fetch(path, init)
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const message = typeof data.error === 'string' ? data.error : `Request failed (${res.status}).`
    throw new ApiError(message, res.status)
  }
  return data as T
}

const enc = encodeURIComponent

export const api = {
  me: () => call<AuthState>('GET', '/api/auth/me'),
  login: (password: string) => call<{ ok: boolean }>('POST', '/api/auth/login', { password }),
  logout: () => call<{ ok: boolean }>('POST', '/api/auth/logout'),

  listAccounts: () => call<{ accounts: Account[] }>('GET', '/api/accounts'),
  importAccounts: (json: string, label: string) =>
    call<{ accounts: Account[] }>('POST', '/api/accounts/import', { json, label }),
  updateAccount: (id: string, patch: { enabled?: boolean; label?: string }) =>
    call<{ account: Account }>('PATCH', `/api/accounts/${enc(id)}`, patch),
  deleteAccount: (id: string) => call<{ ok: boolean }>('DELETE', `/api/accounts/${enc(id)}`),
  testAccount: (id: string) => call<TestResult>('POST', `/api/accounts/${enc(id)}/test`),
  chatTestAccount: (id: string) => call<TestResult>('POST', `/api/accounts/${enc(id)}/chat`),

  listKeys: () => call<{ keys: ApiKeyRecord[] }>('GET', '/api/keys'),
  createKey: (name: string) => call<{ key: string; record: ApiKeyRecord }>('POST', '/api/keys', { name }),
  renameKey: (id: string, name: string) => call<{ record: ApiKeyRecord }>('PATCH', `/api/keys/${enc(id)}`, { name }),
  deleteKey: (id: string) => call<{ ok: boolean }>('DELETE', `/api/keys/${enc(id)}`),

  playground: (model: string, system: string, messages: ChatMessage[]) =>
    call<PlaygroundReply>('POST', '/api/playground', { model, system, messages }),
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.'
}

function toMs(ts: number | string | null | undefined): number | null {
  if (ts === null || ts === undefined || ts === 0 || ts === '') return null
  const ms = new Date(ts).getTime()
  return Number.isNaN(ms) ? null : ms
}

export function formatTime(ts: number | string | null | undefined): string {
  const ms = toMs(ts)
  return ms === null ? 'Never' : new Date(ms).toLocaleString()
}

/** "3 min ago", "in 2 h", "just now"; "Never" for empty values. */
export function formatRelative(ts: number | string | null | undefined, now = Date.now()): string {
  const ms = toMs(ts)
  if (ms === null) return 'Never'
  const diff = ms - now
  const abs = Math.abs(diff)
  if (abs < 45_000) return 'just now'
  const units: [number, string][] = [
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'min'],
  ]
  for (const [size, unit] of units) {
    if (abs >= size || unit === 'min') {
      const n = Math.round(abs / size)
      return diff > 0 ? `in ${n} ${unit}` : `${n} ${unit} ago`
    }
  }
  return 'just now'
}

/** 1234 -> "1.2k", 2500000 -> "2.5M". */
export function formatCount(n: number | undefined): string {
  const v = n ?? 0
  if (v < 1000) return String(v)
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}k`
  return `${(v / 1_000_000).toFixed(1)}M`
}
