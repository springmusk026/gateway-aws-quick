import { useState } from 'react'
import { Check, CircleAlert, KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CopyButton, CopyField } from '@/components/CopyButton'
import { Spinner } from '@/components/LoadState'
import { MODELS } from '@/lib/api'
import type { Tab } from '@/lib/admin'
import { cn } from '@/lib/utils'

type SnippetId = 'curl-openai' | 'curl-anthropic' | 'python-openai' | 'python-anthropic' | 'js' | 'env'

const SNIPPETS: { id: SnippetId; label: string }[] = [
  { id: 'curl-openai', label: 'curl · OpenAI' },
  { id: 'curl-anthropic', label: 'curl · Anthropic' },
  { id: 'python-openai', label: 'Python · openai' },
  { id: 'python-anthropic', label: 'Python · anthropic' },
  { id: 'js', label: 'JavaScript' },
  { id: 'env', label: 'Env vars' },
]

function snippet(id: SnippetId, origin: string, model: string, key: string): string {
  switch (id) {
    case 'curl-openai':
      return `curl ${origin}/v1/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${model}", "messages": [{"role": "user", "content": "Hello"}]}'`
    case 'curl-anthropic':
      return `curl ${origin}/v1/messages \\
  -H "x-api-key: ${key}" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${model}", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}]}'`
    case 'python-openai':
      return `from openai import OpenAI

client = OpenAI(base_url="${origin}/v1", api_key="${key}")
reply = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "Hello"}],
)
print(reply.choices[0].message.content)`
    case 'python-anthropic':
      return `from anthropic import Anthropic

client = Anthropic(base_url="${origin}", api_key="${key}")
message = client.messages.create(
    model="${model}",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}],
)
print(message.content[0].text)`
    case 'js':
      return `import OpenAI from 'openai'

const client = new OpenAI({ baseURL: '${origin}/v1', apiKey: '${key}' })
const reply = await client.chat.completions.create({
  model: '${model}',
  messages: [{ role: 'user', content: 'Hello' }],
})
console.log(reply.choices[0].message.content)`
    case 'env':
      return `OPENAI_BASE_URL=${origin}/v1
OPENAI_API_KEY=${key}
ANTHROPIC_BASE_URL=${origin}
ANTHROPIC_API_KEY=${key}`
  }
}

type KeyCheck = { ok: boolean; message: string }

export function ConnectPanel({ freshKey, go }: { freshKey: string | null; go: (tab: Tab) => void }) {
  const origin = window.location.origin
  const [model, setModel] = useState('quick-balanced')
  const [key, setKey] = useState(freshKey ?? '')
  const [tab, setTab] = useState<SnippetId>('curl-openai')
  const [checking, setChecking] = useState(false)
  const [check, setCheck] = useState<KeyCheck | null>(null)

  const shownKey = key.trim() || 'YOUR_KEY'
  const code = snippet(tab, origin, model, shownKey)

  async function checkKey() {
    setChecking(true)
    setCheck(null)
    try {
      const res = await fetch('/v1/models', { headers: { authorization: `Bearer ${key.trim()}` } })
      const data = (await res.json().catch(() => ({}))) as {
        data?: unknown[]
        error?: { message?: string } | string
      }
      if (res.ok) {
        const count = Array.isArray(data.data) ? data.data.length : 0
        setCheck({ ok: true, message: `This key works. The gateway offers ${count} models.` })
      } else {
        const message = typeof data.error === 'string' ? data.error : data.error?.message
        setCheck({ ok: false, message: message || `The gateway refused the key (${res.status}).` })
      }
    } catch {
      setCheck({ ok: false, message: 'Could not reach the gateway.' })
    } finally {
      setChecking(false)
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Connect a client</CardTitle>
          <CardDescription>
            Point any OpenAI or Anthropic compatible app at these addresses and give it one of your API keys.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1.5">
            <p className="text-sm font-medium">OpenAI base URL</p>
            <CopyField value={`${origin}/v1`} />
            <p className="text-xs text-muted-foreground">Chat Completions: /v1/chat/completions. Models: /v1/models.</p>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <p className="text-sm font-medium">Anthropic base URL</p>
            <CopyField value={origin} />
            <p className="text-xs text-muted-foreground">Anthropic SDKs add /v1/messages themselves.</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Models</CardTitle>
          <CardDescription>Pick one to fill it into the examples below.</CardDescription>
        </CardHeader>
        <CardContent>
          <div role="radiogroup" aria-label="Model" className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {MODELS.map((m) => {
              const active = model === m.id
              return (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setModel(m.id)}
                  className={cn(
                    'flex cursor-pointer flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active ? 'border-foreground bg-accent' : 'border-border hover:bg-accent',
                  )}
                >
                  <span className="font-mono text-xs font-medium">{m.id}</span>
                  <span className="text-xs text-muted-foreground">{m.note}</span>
                </button>
              )
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Examples</CardTitle>
          <CardDescription>
            Paste a key to fill it in. It stays in this tab and is not saved. Add{' '}
            <code className="rounded bg-muted px-1">"stream": true</code> for streaming replies.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="grid flex-1 gap-1.5">
              <Label htmlFor="connect-key">API key (optional)</Label>
              <Input
                id="connect-key"
                value={key}
                autoComplete="off"
                spellCheck={false}
                placeholder="qgk_…"
                className="font-mono text-xs"
                onChange={(event) => {
                  setKey(event.target.value)
                  setCheck(null)
                }}
              />
            </div>
            <Button variant="outline" disabled={checking || !key.trim()} onClick={() => void checkKey()}>
              {checking ? <Spinner /> : <KeyRound className="size-4" />}
              Check key
            </Button>
          </div>
          {check && (
            <p
              role="status"
              className={cn('flex items-center gap-2 text-xs', check.ok ? 'text-success' : 'text-destructive')}
            >
              {check.ok ? <Check className="size-3.5" /> : <CircleAlert className="size-3.5" />}
              {check.message}
            </p>
          )}
          {!key.trim() && (
            <p className="text-xs text-muted-foreground">
              No key yet?{' '}
              <button
                type="button"
                className="cursor-pointer font-medium text-foreground underline underline-offset-2"
                onClick={() => go('keys')}
              >
                Create one on the API keys tab
              </button>
              .
            </p>
          )}

          <div role="tablist" aria-label="Example language" className="flex flex-wrap gap-1">
            {SNIPPETS.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={tab === s.id}
                onClick={() => setTab(s.id)}
                className={cn(
                  'cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  tab === s.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="relative">
            <pre className="overflow-x-auto rounded-md bg-muted p-3 pr-24 font-mono text-xs leading-relaxed">{code}</pre>
            <CopyButton text={code} className="absolute right-2 top-2 h-7 bg-background px-2" />
          </div>
        </CardContent>
      </Card>
    </>
  )
}
