import { useState } from 'react'
import { Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/LoadState'

/**
 * A name with a pencil button. Editing shows a small form; Enter saves, Escape cancels.
 * `onSave` returns true when the new name was stored, so the editor closes only on success.
 */
export function InlineEdit({
  value,
  shown,
  what,
  allowEmpty = false,
  onSave,
}: {
  value: string
  /** Text to show when not editing (defaults to value). */
  shown?: string
  /** What is being renamed, for screen readers, e.g. "account". */
  what: string
  allowEmpty?: boolean
  onSave: (next: string) => Promise<boolean>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)

  async function save() {
    const next = draft.trim()
    if (next === value) {
      setEditing(false)
      return
    }
    setSaving(true)
    const ok = await onSave(next)
    setSaving(false)
    if (ok) setEditing(false)
  }

  if (!editing) {
    return (
      <span className="flex min-w-0 items-center gap-1">
        <span className="truncate font-medium">{shown ?? value}</span>
        <button
          type="button"
          aria-label={`Rename ${what}`}
          title="Rename"
          onClick={() => {
            setDraft(value)
            setEditing(true)
          }}
          className="shrink-0 cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Pencil className="size-3.5" />
        </button>
      </span>
    )
  }

  return (
    <form
      className="flex min-w-0 flex-1 items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <Input
        autoFocus
        value={draft}
        maxLength={80}
        aria-label={`New name for the ${what}`}
        className="h-8 min-w-0"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setEditing(false)
        }}
      />
      <Button type="submit" size="sm" disabled={saving || (!allowEmpty && !draft.trim())}>
        {saving ? <Spinner /> : null}
        Save
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
        Cancel
      </Button>
    </form>
  )
}
