// Shared bits for the admin panels: tab ids, loaded-data shape and account helpers.
import { api, ApiError, messageOf, type Account, type TestResult } from '@/lib/api'

export type Tab = 'overview' | 'accounts' | 'keys' | 'playground' | 'connect'
export const TAB_IDS: Tab[] = ['overview', 'accounts', 'keys', 'playground', 'connect']

/** Data loaded by App and shared by the panels. `data` is null until the first load finishes. */
export interface Resource<T> {
  data: T | null
  error: string | null
  reload: () => Promise<void>
}

export function accountName(account: Account): string {
  return account.label || account.email || 'Unnamed account'
}

export function isHealthy(account: Account): boolean {
  return account.enabled && account.status === 'ok' && !account.lastError
}

export interface AccountTotals {
  total: number
  working: number
  needsLogin: number
  disabled: number
  requests: number
  failures: number
  inputTokens: number
  outputTokens: number
}

export function totals(accounts: Account[]): AccountTotals {
  const t: AccountTotals = {
    total: accounts.length,
    working: 0,
    needsLogin: 0,
    disabled: 0,
    requests: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
  }
  for (const a of accounts) {
    if (!a.enabled) t.disabled++
    else if (a.status === 'needs_login') t.needsLogin++
    else t.working++
    t.requests += a.requests ?? 0
    t.failures += a.failures ?? 0
    t.inputTokens += a.inputTokens ?? 0
    t.outputTokens += a.outputTokens ?? 0
  }
  return t
}

/**
 * Refreshes the login of every given account in parallel. A 401 (admin session gone) is rethrown so the
 * caller can sign out; any other failure becomes a failed result for that account.
 */
export async function testAccounts(accounts: Account[]): Promise<Record<string, TestResult>> {
  const results: Record<string, TestResult> = {}
  await Promise.all(
    accounts.map(async (a) => {
      try {
        results[a.id] = await api.testAccount(a.id)
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) throw err
        results[a.id] = { ok: false, message: messageOf(err) }
      }
    }),
  )
  return results
}

export function summarizeTests(results: Record<string, TestResult>): string {
  const all = Object.values(results)
  const ok = all.filter((r) => r.ok).length
  if (all.length === 0) return 'No enabled accounts to test.'
  if (ok === all.length) return all.length === 1 ? 'The account is working.' : `All ${all.length} accounts are working.`
  return `${ok} of ${all.length} accounts working. Check the failed ones on the Accounts tab.`
}
