import { useState } from 'react'
import { Check, CircleAlert, MessageSquare, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { LoadState, Spinner } from '@/components/LoadState'
import { StatusDot } from '@/components/StatusDot'
import { useToast } from '@/components/ui/toast'
import { formatCount, formatRelative, type Account, type ApiKeyRecord } from '@/lib/api'
import { accountName, summarizeTests, testAccounts, totals, type Resource, type Tab } from '@/lib/admin'
import { cn } from '@/lib/utils'

export function OverviewPanel({
  accounts,
  keys,
  go,
  onError,
}: {
  accounts: Resource<Account[]>
  keys: Resource<ApiKeyRecord[]>
  go: (tab: Tab) => void
  onError: (err: unknown) => void
}) {
  const toast = useToast()
  const [testing, setTesting] = useState(false)

  if (accounts.data === null || keys.data === null) {
    return (
      <Card>
        <CardContent className="pt-5">
          <LoadState
            what="the overview"
            error={accounts.error ?? keys.error}
            onRetry={() => {
              void accounts.reload()
              void keys.reload()
            }}
          />
        </CardContent>
      </Card>
    )
  }

  const list = accounts.data
  const keyList = keys.data
  const t = totals(list)
  const keyLastUsed = Math.max(0, ...keyList.map((k) => k.lastUsed ?? 0))
  const attention = list.filter((a) => a.enabled && (a.status === 'needs_login' || a.lastError))
  const maxRequests = Math.max(1, ...list.map((a) => a.requests ?? 0))
  const byUse = [...list].sort((a, b) => (b.requests ?? 0) - (a.requests ?? 0) || b.lastUsed - a.lastUsed)

  const steps: { done: boolean; title: string; body: string; action: string; tab: Tab }[] = [
    {
      done: t.total > 0,
      title: 'Add an Amazon Quick account',
      body: 'Sign in with the Android app or the sign-in script, or import a JSON file.',
      action: 'Add account',
      tab: 'accounts',
    },
    {
      done: keyList.length > 0,
      title: 'Create an API key',
      body: 'Give each app or device its own key, so you can remove one without breaking the rest.',
      action: 'Create key',
      tab: 'keys',
    },
    {
      done: keyLastUsed > 0,
      title: 'Connect a client',
      body: 'Point any OpenAI or Anthropic compatible app at this gateway.',
      action: 'Show setup',
      tab: 'connect',
    },
  ]
  const setupDone = steps.every((s) => s.done)

  const accountHint =
    t.total === 0
      ? 'None added yet'
      : [t.needsLogin && `${t.needsLogin} need login`, t.disabled && `${t.disabled} off`]
          .filter(Boolean)
          .join(' · ') || 'All working'

  async function testAll() {
    setTesting(true)
    try {
      const results = await testAccounts(list.filter((a) => a.enabled))
      const failed = Object.values(results).some((r) => !r.ok)
      toast(summarizeTests(results), failed ? 'error' : 'default')
      await accounts.reload()
    } catch (err) {
      onError(err)
    } finally {
      setTesting(false)
    }
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Working accounts"
          value={`${t.working} / ${t.total}`}
          hint={accountHint}
          bad={t.needsLogin > 0}
        />
        <Stat
          label="Requests"
          value={formatCount(t.requests)}
          hint={t.failures ? `${formatCount(t.failures)} failed attempts` : 'No failures'}
        />
        <Stat
          label="Tokens"
          value={formatCount(t.inputTokens + t.outputTokens)}
          hint={`${formatCount(t.inputTokens)} in · ${formatCount(t.outputTokens)} out`}
        />
        <Stat
          label="API keys"
          value={String(keyList.length)}
          hint={keyLastUsed ? `Last used ${formatRelative(keyLastUsed)}` : 'Not used yet'}
        />
      </div>

      {!setupDone && (
        <Card>
          <CardHeader>
            <CardTitle>Get started</CardTitle>
            <CardDescription>Three steps and any OpenAI or Anthropic client can use your Quick accounts.</CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="flex flex-col divide-y divide-border">
              {steps.map((step, i) => (
                <li key={step.title} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                  <span
                    className={cn(
                      'flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium',
                      step.done ? 'border-success bg-success/10 text-success' : 'border-border text-muted-foreground',
                    )}
                  >
                    {step.done ? <Check className="size-3.5" /> : i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={cn('text-sm font-medium', step.done && 'text-muted-foreground line-through')}>
                      {step.title}
                    </p>
                    {!step.done && <p className="text-xs text-muted-foreground">{step.body}</p>}
                  </div>
                  {!step.done && (
                    <Button size="sm" variant="outline" onClick={() => go(step.tab)}>
                      {step.action}
                    </Button>
                  )}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}

      {attention.length > 0 && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CircleAlert className="size-4 text-destructive" />
              Needs attention
            </CardTitle>
            <CardDescription>
              Requests skip these accounts until they work again. A new login usually fixes it.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <ul className="flex flex-col gap-2">
              {attention.map((a) => (
                <li key={a.id} className="rounded-md border border-border p-3 text-sm">
                  <p className="font-medium">{accountName(a)}</p>
                  <p className="text-xs text-muted-foreground">
                    {a.status === 'needs_login' ? 'Needs a new login. ' : ''}
                    {a.lastError ?? ''}
                  </p>
                </li>
              ))}
            </ul>
            <div>
              <Button size="sm" variant="outline" onClick={() => go('accounts')}>
                Open accounts
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {list.length > 0 && (
        <Card>
          <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-1.5">
              <CardTitle>Account usage</CardTitle>
              <CardDescription>Requests go to the least recently used working account.</CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={testing} onClick={() => void testAll()}>
                {testing ? <Spinner /> : <RefreshCw className="size-3.5" />}
                {testing ? 'Testing…' : 'Test all'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => go('playground')}>
                <MessageSquare className="size-3.5" />
                Try a chat
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-3">
              {byUse.map((a) => {
                const requests = a.requests ?? 0
                return (
                  <li key={a.id} className="grid gap-1.5">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="flex min-w-0 items-center gap-2">
                        <StatusDot account={a} />
                        <span className="truncate font-medium">{accountName(a)}</span>
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {formatCount(requests)} req · {formatRelative(a.lastUsed)}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-foreground/60"
                        style={{ width: `${Math.round((requests / maxRequests) * 100)}%` }}
                      />
                    </div>
                  </li>
                )
              })}
            </ul>
            <p className="mt-4 text-xs text-muted-foreground">
              Counts started with this version of the gateway. Token numbers are estimates when Quick does not report
              them.
            </p>
          </CardContent>
        </Card>
      )}
    </>
  )
}

function Stat({ label, value, hint, bad }: { label: string; value: string; hint: string; bad?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      <p className={cn('mt-0.5 truncate text-xs', bad ? 'text-destructive' : 'text-muted-foreground')}>{hint}</p>
    </div>
  )
}
