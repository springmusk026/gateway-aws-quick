import type { Account } from '@/lib/api'
import { cn } from '@/lib/utils'

/** Green: working. Red: needs a new login. Grey: turned off. */
export function StatusDot({ account }: { account: Account }) {
  const state = !account.enabled ? 'off' : account.status === 'needs_login' ? 'bad' : 'ok'
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        state === 'ok' && 'bg-success',
        state === 'bad' && 'bg-destructive',
        state === 'off' && 'bg-muted-foreground/40',
      )}
    />
  )
}
