import { TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'

const NOTICE_URL = 'https://github.com/springmusk026/gateway-aws-quick/blob/main/NOTICE.md'

/** Short, always-visible reminder that this is an unofficial, educational project. See NOTICE.md. */
export function EduNotice({ className }: { className?: string }) {
  return (
    <p className={cn('flex items-start gap-2 text-xs leading-snug text-muted-foreground', className)}>
      <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>
        Unofficial, for educational use only. Not affiliated with Amazon or AWS. Use only your own account, at your own
        risk.{' '}
        <a href={NOTICE_URL} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
          Read the notice
        </a>
      </span>
    </p>
  )
}
