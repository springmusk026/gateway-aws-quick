import { useState, type FormEvent } from 'react'
import { KeyRound, Plug, Plus, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/toast'
import { CopyButton } from '@/components/CopyButton'
import { InlineEdit } from '@/components/InlineEdit'
import { LoadState, Spinner } from '@/components/LoadState'
import { api, formatRelative, formatTime, type ApiKeyRecord } from '@/lib/api'
import type { Resource, Tab } from '@/lib/admin'

function formatDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function KeysPanel({
  keys,
  onError,
  go,
  onCreated,
}: {
  keys: Resource<ApiKeyRecord[]>
  onError: (err: unknown) => void
  go: (tab: Tab) => void
  onCreated: (key: string) => void
}) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [newKey, setNewKey] = useState<{ key: string; name: string } | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setCreating(true)
    try {
      const data = await api.createKey(name.trim() || 'API key')
      setNewKey({ key: data.key, name: data.record.name })
      onCreated(data.key)
      setName('')
      await keys.reload()
    } catch (err) {
      onError(err)
    } finally {
      setCreating(false)
    }
  }

  async function rename(key: ApiKeyRecord, next: string): Promise<boolean> {
    try {
      await api.renameKey(key.id, next)
      await keys.reload()
      return true
    } catch (err) {
      onError(err)
      return false
    }
  }

  async function remove(key: ApiKeyRecord) {
    if (!window.confirm(`Delete the key "${key.name}"? Apps that use it stop working right away.`)) return
    setDeleting(key.id)
    try {
      await api.deleteKey(key.id)
      toast(`Deleted the key "${key.name}".`)
      await keys.reload()
    } catch (err) {
      onError(err)
    } finally {
      setDeleting(null)
    }
  }

  const list = keys.data

  return (
    <Card>
      <CardHeader>
        <CardTitle>API keys</CardTitle>
        <CardDescription>
          Apps send a key as <code className="rounded bg-muted px-1">Authorization: Bearer …</code> (OpenAI style) or{' '}
          <code className="rounded bg-muted px-1">x-api-key</code> (Anthropic style). Only a hash is stored, so you see
          each key once, right after you create it.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(event) => void create(event)}>
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor="key-name">Name for the new key</Label>
            <Input
              id="key-name"
              value={name}
              maxLength={80}
              placeholder="Laptop, n8n, phone…"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={creating}>
            {creating ? <Spinner /> : <Plus className="size-4" />}
            {creating ? 'Creating…' : 'Create key'}
          </Button>
        </form>

        {newKey && (
          <div className="grid gap-3 rounded-md border border-warning/50 bg-warning/5 p-4">
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm font-medium">
                Copy the key “{newKey.name}” now. It will not be shown again.
              </p>
              <button
                type="button"
                aria-label="Dismiss"
                className="cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground"
                onClick={() => setNewKey(null)}
              >
                <X className="size-4" />
              </button>
            </div>
            <code className="break-all rounded-md bg-background px-3 py-2 font-mono text-sm">{newKey.key}</code>
            <div className="flex flex-wrap gap-2">
              <CopyButton text={newKey.key} label="Copy key" />
              <Button size="sm" variant="outline" onClick={() => go('connect')}>
                <Plug className="size-3.5" />
                Set up a client with it
              </Button>
            </div>
          </div>
        )}

        {list === null ? (
          <LoadState what="keys" error={keys.error} onRetry={() => void keys.reload()} />
        ) : list.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-border px-4 py-8 text-center">
            <KeyRound className="size-5 text-muted-foreground" />
            <p className="text-sm font-medium">No keys yet</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Create one key per app or device. Then you can remove one without breaking the others.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {list.map((key) => (
              <li key={key.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <InlineEdit value={key.name} what="key" onSave={(next) => rename(key, next)} />
                  <p className="text-xs text-muted-foreground">
                    Created {formatDate(key.created)} ·{' '}
                    <span title={key.lastUsed ? formatTime(key.lastUsed) : undefined}>
                      {key.lastUsed ? `last used ${formatRelative(key.lastUsed)}` : 'not used yet'}
                    </span>
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={deleting === key.id}
                  onClick={() => void remove(key)}
                  aria-label={`Delete the key ${key.name}`}
                >
                  {deleting === key.id ? <Spinner /> : <Trash2 className="size-3.5" />}
                  <span className="hidden sm:inline">Delete</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
        {list !== null && list.length > 0 && (
          <p className="text-xs text-muted-foreground">“Last used” updates at most every 10 minutes.</p>
        )}
      </CardContent>
    </Card>
  )
}
