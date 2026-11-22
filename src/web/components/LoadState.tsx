import { LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** Shown while a list is still loading, or when its first load failed. */
export function LoadState({ what, error, onRetry }: { what: string; error: string | null; onRetry: () => void }) {
  if (error) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-destructive">
          Could not load {what}: {error}
        </span>
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      </div>
    )
  }
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <LoaderCircle className="size-4 animate-spin" />
      Loading {what}…
    </p>
  )
}

/** Small spinner for buttons that are waiting on the server. */
export function Spinner() {
  return <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
}
