import { useEffect, useRef, useState, type FormEvent } from 'react'
import { CircleAlert, Send, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/input'
import { CopyButton } from '@/components/CopyButton'
import { Spinner } from '@/components/LoadState'
import { api, formatCount, MODELS, type Account, type ChatMessage } from '@/lib/api'
import type { Tab } from '@/lib/admin'
import { cn } from '@/lib/utils'

interface Turn extends ChatMessage {
  meta?: { ms: number; input: number; output: number; model: string; thinking: string }
}

const SUGGESTIONS = [
  'Say hello in Nepali, then translate it.',
  'Explain what an API gateway does in two sentences.',
  'Give me three name ideas for a small tea shop.',
]

const MODEL_KEY = 'quick-gateway.playground.model'

export function PlaygroundPanel({
  accounts,
  go,
  onError,
}: {
  accounts: Account[] | null
  go: (tab: Tab) => void
  onError: (err: unknown) => void
}) {
  const [model, setModel] = useState(() => {
    const saved = window.localStorage.getItem(MODEL_KEY)
    return MODELS.some((m) => m.id === saved) ? (saved as string) : 'quick-balanced'
  })
  const [system, setSystem] = useState('')
  const [showSystem, setShowSystem] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const endRef = useRef<HTMLDivElement>(null)

  const noWorking = accounts !== null && !accounts.some((a) => a.enabled && a.status === 'ok')
  const note = MODELS.find((m) => m.id === model)?.note

  useEffect(() => {
    window.localStorage.setItem(MODEL_KEY, model)
  }, [model])

  useEffect(() => {
    if (!sending) return
    const started = Date.now()
    setElapsed(0)
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [sending])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [turns, sending])

  async function send(event?: FormEvent) {
    event?.preventDefault()
    const text = draft.trim()
    if (!text || sending) return
    const before = turns
    const history: Turn[] = [...before, { role: 'user', content: text }]
    setTurns(history)
    setDraft('')
    setSending(true)
    try {
      const reply = await api.playground(
        model,
        system,
        history.map(({ role, content }) => ({ role, content })),
      )
      setTurns([
        ...history,
        {
          role: 'assistant',
          content: reply.text,
          meta: {
            ms: reply.ms,
            input: reply.usage.input,
            output: reply.usage.output,
            model: reply.model,
            thinking: reply.thinking,
          },
        },
      ])
    } catch (err) {
      // Put the message back so nothing is lost; the error shows as a toast.
      setTurns(before)
      setDraft(text)
      onError(err)
    } finally {
      setSending(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Playground</CardTitle>
        <CardDescription>
          Chat through the gateway without an API key. It picks an account like any client would, and the chat counts
          toward usage.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {noWorking && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
            <CircleAlert className="size-4 shrink-0 text-destructive" />
            <span className="flex-1">No working account right now, so chats will fail.</span>
            <Button size="sm" variant="outline" onClick={() => go('accounts')}>
              Open accounts
            </Button>
          </div>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="pg-model">Model</Label>
            <select
              id="pg-model"
              value={model}
              disabled={sending}
              onChange={(event) => setModel(event.target.value)}
              className="h-9 cursor-pointer rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          </div>
          <p className="pb-2 text-xs text-muted-foreground">{note}</p>
          <div className="ml-auto flex gap-2">
            <Button
              size="sm"
              variant="outline"
              aria-expanded={showSystem}
              onClick={() => setShowSystem(!showSystem)}
            >
              System prompt{system.trim() ? ' (set)' : ''}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={sending || turns.length === 0}
              onClick={() => setTurns([])}
            >
              <Trash2 className="size-3.5" />
              Clear
            </Button>
          </div>
        </div>

        {showSystem && (
          <div className="grid gap-1.5">
            <Label htmlFor="pg-system">System prompt (optional)</Label>
            <Textarea
              id="pg-system"
              rows={3}
              className="min-h-20 font-sans text-sm"
              value={system}
              placeholder="You are a helpful assistant. Answer briefly."
              onChange={(event) => setSystem(event.target.value)}
            />
          </div>
        )}

        <div className="flex min-h-64 flex-col gap-4 rounded-md border border-border bg-background p-4">
          {turns.length === 0 && !sending ? (
            <div className="m-auto flex max-w-md flex-col items-center gap-3 text-center">
              <p className="text-sm text-muted-foreground">Send a message to try the gateway. Or start with:</p>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setDraft(s)}
                    className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            turns.map((turn, i) => <TurnView key={i} turn={turn} />)
          )}
          {sending && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Spinner />
              Waiting for Quick… {elapsed > 0 ? `${elapsed} s` : ''}
            </p>
          )}
          <div ref={endRef} />
        </div>

        <form className="flex flex-col gap-2" onSubmit={(event) => void send(event)}>
          <Label htmlFor="pg-input" className="sr-only">
            Message
          </Label>
          <Textarea
            id="pg-input"
            rows={3}
            className="min-h-20 font-sans text-sm"
            value={draft}
            placeholder="Type a message"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void send()
            }}
          />
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">Ctrl + Enter sends. The whole conversation is sent each time.</p>
            <Button type="submit" disabled={sending || !draft.trim()}>
              {sending ? <Spinner /> : <Send className="size-4" />}
              Send
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function TurnView({ turn }: { turn: Turn }) {
  if (turn.role === 'user') {
    return (
      <div className="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-muted px-3 py-2 text-sm">
        {turn.content}
      </div>
    )
  }
  const meta = turn.meta
  return (
    <div className="flex max-w-[92%] flex-col gap-2">
      {meta?.thinking && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">Thinking</summary>
          <p className="mt-1 whitespace-pre-wrap border-l-2 border-border pl-3">{meta.thinking}</p>
        </details>
      )}
      <div className={cn('whitespace-pre-wrap break-words text-sm', !turn.content && 'italic text-muted-foreground')}>
        {turn.content || '(empty reply)'}
      </div>
      {meta && (
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {meta.model} · {(meta.ms / 1000).toFixed(1)} s · {formatCount(meta.input)} in / {formatCount(meta.output)}{' '}
            out
          </span>
          {turn.content && <CopyButton text={turn.content} className="h-7 px-2" />}
        </div>
      )}
    </div>
  )
}
