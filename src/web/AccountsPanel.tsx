import { useRef, useState, type ReactNode } from 'react'
import {
  Check,
  ChevronDown,
  CircleAlert,
  FileJson,
  MessageSquare,
  Plus,
  RefreshCw,
  Smartphone,
  Terminal,
  Trash2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Textarea } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/toast'
import { CopyField } from '@/components/CopyButton'
import { InlineEdit } from '@/components/InlineEdit'
import { LoadState, Spinner } from '@/components/LoadState'
import { StatusDot } from '@/components/StatusDot'
import { api, formatCount, formatRelative, formatTime, type Account, type TestResult } from '@/lib/api'
import { accountName, summarizeTests, testAccounts, type Resource } from '@/lib/admin'
import { cn } from '@/lib/utils'

type Action = 'test' | 'chat' | 'toggle' | 'delete'

export function AccountsPanel({
  accounts,
  onError,
}: {
  accounts: Resource<Account[]>
  onError: (err: unknown) => void
}) {
  const toast = useToast()
  const [showAdd, setShowAdd] = useState<boolean | null>(null)
  const [busy, setBusy] = useState<Record<string, Action | undefined>>({})
  const [results, setResults] = useState<Record<string, TestResult>>({})
  const [testingAll, setTestingAll] = useState(false)

  const list = accounts.data
  // Open the "add" section by default only when there is nothing else to show.
  const addOpen = showAdd ?? (list !== null && list.length === 0)

  async function run(id: string, action: Action, work: () => Promise<void>) {
    setBusy((b) => ({ ...b, [id]: action }))
    try {
      await work()
    } catch (err) {
      onError(err)
    } finally {
      setBusy((b) => ({ ...b, [id]: undefined }))
    }
  }

  const setResult = (id: string, result: TestResult) => setResults((all) => ({ ...all, [id]: result }))

  const refreshLogin = (a: Account) =>
    run(a.id, 'test', async () => {
      setResult(a.id, await api.testAccount(a.id))
      await accounts.reload()
    })

  const chatTest = (a: Account) =>
    run(a.id, 'chat', async () => {
      setResult(a.id, await api.chatTestAccount(a.id))
      await accounts.reload()
    })

  const toggle = (a: Account, enabled: boolean) =>
    run(a.id, 'toggle', async () => {
      await api.updateAccount(a.id, { enabled })
      toast(enabled ? `${accountName(a)} is on again.` : `${accountName(a)} is off. Requests skip it.`)
      await accounts.reload()
    })

  function remove(a: Account) {
    if (!window.confirm(`Delete ${accountName(a)}? Its stored login is removed from the gateway.`)) return
    void run(a.id, 'delete', async () => {
      await api.deleteAccount(a.id)
      setResults((all) => {
        const next = { ...all }
        delete next[a.id]
        return next
      })
      toast(`Deleted ${accountName(a)}.`)
      await accounts.reload()
    })
  }

  async function rename(a: Account, label: string): Promise<boolean> {
    try {
      await api.updateAccount(a.id, { label })
      await accounts.reload()
      return true
    } catch (err) {
      onError(err)
      return false
    }
  }

  async function testAll() {
    if (!list) return
    setTestingAll(true)
    try {
      const found = await testAccounts(list.filter((a) => a.enabled))
      setResults((all) => ({ ...all, ...found }))
      toast(summarizeTests(found), Object.values(found).some((r) => !r.ok) ? 'error' : 'default')
      await accounts.reload()
    } catch (err) {
      onError(err)
    } finally {
      setTestingAll(false)
    }
  }

  return (
    <>
      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <CardTitle>Amazon Quick accounts</CardTitle>
            <CardDescription>
              Each request goes to the least recently used working account. If one fails before it answers, the
              next one takes over. Logins are encrypted before they are stored.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={testingAll || !list?.some((a) => a.enabled)}
              onClick={() => void testAll()}
              title="Refreshes the login of every enabled account"
            >
              {testingAll ? <Spinner /> : <RefreshCw className="size-3.5" />}
              {testingAll ? 'Testing…' : 'Test all'}
            </Button>
            <Button size="sm" variant={addOpen ? 'outline' : 'default'} onClick={() => setShowAdd(!addOpen)}>
              <Plus className="size-3.5" />
              Add account
              <ChevronDown className={cn('size-3.5 transition-transform', addOpen && 'rotate-180')} />
            </Button>
          </div>
        </CardHeader>

        {addOpen && (
          <CardContent>
            <AddAccount
              onImported={async (count) => {
                toast(count === 1 ? 'Account added.' : `${count} accounts added.`)
                setShowAdd(false)
                await accounts.reload()
              }}
              onError={onError}
            />
          </CardContent>
        )}
      </Card>

      {list === null ? (
        <LoadState what="accounts" error={accounts.error} onRetry={() => void accounts.reload()} />
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">No accounts yet. Add one above to start using the gateway.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {list.map((a) => (
            <AccountCard
              key={a.id}
              account={a}
              busy={busy[a.id]}
              result={results[a.id]}
              onRefresh={() => void refreshLogin(a)}
              onChat={() => void chatTest(a)}
              onToggle={(enabled) => void toggle(a, enabled)}
              onRename={(label) => rename(a, label)}
              onDelete={() => remove(a)}
            />
          ))}
        </ul>
      )}
    </>
  )
}

function AccountCard({
  account: a,
  busy,
  result,
  onRefresh,
  onChat,
  onToggle,
  onRename,
  onDelete,
}: {
  account: Account
  busy: Action | undefined
  result: TestResult | undefined
  onRefresh: () => void
  onChat: () => void
  onToggle: (enabled: boolean) => void
  onRename: (label: string) => Promise<boolean>
  onDelete: () => void
}) {
  const name = accountName(a)
  const tokenText = !a.tokenExpiresAt
    ? 'Renews on first use'
    : a.tokenExpiresAt > Date.now()
      ? `Expires ${formatRelative(a.tokenExpiresAt)}`
      : 'Renews on next use'
  // A failed test usually stores the same text as lastError; show it once.
  const showLastError = a.lastError && !(result && !result.ok && result.message === a.lastError)

  return (
    <li
      className={cn('flex min-w-0 flex-col rounded-lg border border-border bg-card p-4', !a.enabled && 'opacity-75')}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <StatusDot account={a} />
            <InlineEdit value={a.label} shown={name} what="account" allowEmpty onSave={onRename} />
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 pl-4">
            {!a.enabled ? (
              <Badge variant="outline">Off</Badge>
            ) : a.status === 'needs_login' ? (
              <Badge variant="destructive">Log in again</Badge>
            ) : (
              <Badge variant="success">Working</Badge>
            )}
            {a.email && a.email !== name && (
              <span className="truncate text-xs text-muted-foreground">{a.email}</span>
            )}
          </div>
        </div>
        <Switch
          checked={a.enabled}
          disabled={busy !== undefined}
          onChange={onToggle}
          label={a.enabled ? `Turn off ${name}` : `Turn on ${name}`}
        />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
        <Fact
          label="Requests"
          value={`${formatCount(a.requests)}${a.failures ? ` · ${formatCount(a.failures)} failed` : ''}`}
        />
        <Fact label="Tokens" value={`${formatCount(a.inputTokens)} in · ${formatCount(a.outputTokens)} out`} />
        <Fact label="Last used" value={formatRelative(a.lastUsed)} title={formatTime(a.lastUsed)} />
        <Fact
          label="Access token"
          value={tokenText}
          title={a.tokenExpiresAt ? formatTime(a.tokenExpiresAt) : undefined}
        />
      </dl>

      {a.status === 'needs_login' && (
        <p className="mt-3 text-xs text-muted-foreground">
          Sign in again with this Amazon account (Android app or sign-in script). The gateway updates this entry
          instead of adding a new one.
        </p>
      )}

      {showLastError && (
        <p className="mt-3 break-words rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {a.lastError}
        </p>
      )}

      {result && (
        <p
          role="status"
          className={cn('mt-3 flex items-start gap-2 break-words text-xs', result.ok ? 'text-success' : 'text-destructive')}
        >
          {result.ok ? (
            <Check className="mt-px size-3.5 shrink-0" />
          ) : (
            <CircleAlert className="mt-px size-3.5 shrink-0" />
          )}
          <span>{result.message}</span>
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== undefined}
          onClick={onRefresh}
          title="Renews the access token. Does not send a chat."
        >
          {busy === 'test' ? <Spinner /> : <RefreshCw className="size-3.5" />}
          Refresh login
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== undefined}
          onClick={onChat}
          title="Sends one short message through this account"
        >
          {busy === 'chat' ? <Spinner /> : <MessageSquare className="size-3.5" />}
          {busy === 'chat' ? 'Waiting for reply…' : 'Chat test'}
        </Button>
        <Button size="sm" variant="destructive" className="ml-auto" disabled={busy !== undefined} onClick={onDelete}>
          {busy === 'delete' ? <Spinner /> : <Trash2 className="size-3.5" />}
          Delete
        </Button>
      </div>
    </li>
  )
}

function Fact({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium tabular-nums" title={title}>
        {value}
      </dd>
    </div>
  )
}

function AddAccount({
  onImported,
  onError,
}: {
  onImported: (count: number) => Promise<void>
  onError: (err: unknown) => void
}) {
  const [json, setJson] = useState('')
  const [label, setLabel] = useState('')
  const [importing, setImporting] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function readFile(file: File | undefined) {
    setFileError(null)
    if (!file) return
    try {
      setJson(await file.text())
    } catch {
      setFileError('Could not read that file. Try pasting its contents instead.')
    }
  }

  async function importNow() {
    setImporting(true)
    try {
      const data = await api.importAccounts(json, label)
      setJson('')
      setLabel('')
      if (fileRef.current) fileRef.current.value = ''
      await onImported(data.accounts.length)
    } catch (err) {
      onError(err)
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Method icon={<Smartphone className="size-4" />} title="Android app" note="Easiest">
        <p>
          Install <code className="rounded bg-muted px-1">quick-gateway.apk</code>, sign in with your admin password,
          then finish the Amazon sign-in in the browser it opens. The account appears here.
        </p>
      </Method>

      <Method icon={<Terminal className="size-4" />} title="Sign-in script" note="On a computer">
        <p>In the quick-gateway folder, with ADMIN_PASSWORD in .secrets, run:</p>
        <CopyField value="node scripts/oauth-login.mjs --open" />
        <p>It opens the Amazon sign-in and saves the login here.</p>
      </Method>

      <Method icon={<FileJson className="size-4" />} title="Import a file" note="oauth-sessions.json">
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void importNow()
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="import-file">File</Label>
            <Input
              id="import-file"
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="text-xs file:mr-2 file:border-0 file:bg-transparent file:text-xs file:font-medium"
              onChange={(event) => void readFile(event.target.files?.[0])}
            />
            {fileError && <p className="text-xs text-destructive">{fileError}</p>}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="import-json">Or paste it</Label>
            <Textarea
              id="import-json"
              rows={4}
              className="min-h-20"
              value={json}
              placeholder='{"sessions": [...]}'
              onChange={(event) => setJson(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="import-label">Name (optional, single account only)</Label>
            <Input
              id="import-label"
              value={label}
              maxLength={80}
              placeholder="Work account"
              onChange={(event) => setLabel(event.target.value)}
            />
          </div>
          <div>
            <Button type="submit" size="sm" disabled={importing || !json.trim()}>
              {importing && <Spinner />}
              {importing ? 'Importing…' : 'Import'}
            </Button>
          </div>
        </form>
      </Method>

      <p className="text-xs text-muted-foreground lg:col-span-3">
        Signing in again with an Amazon account that is already here refreshes that account instead of adding a copy.
      </p>
    </div>
  )
}

function Method({
  icon,
  title,
  note,
  children,
}: {
  icon: ReactNode
  title: string
  note: string
  children: ReactNode
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-md border border-border p-4 text-sm">
      <header className="flex items-center gap-2">
        <span className="text-muted-foreground">{icon}</span>
        <h3 className="font-medium">{title}</h3>
        <span className="ml-auto text-xs text-muted-foreground">{note}</span>
      </header>
      <div className="flex flex-col gap-2 text-xs text-muted-foreground">{children}</div>
    </section>
  )
}
