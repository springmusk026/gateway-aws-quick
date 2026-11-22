import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { KeyRound, LayoutDashboard, LogOut, Menu, MessageSquare, Plug, Users, X, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ToastProvider, useToast } from '@/components/ui/toast'
import { api, ApiError, messageOf, type Account, type ApiKeyRecord, type AuthState } from '@/lib/api'
import { TAB_IDS, type Resource, type Tab } from '@/lib/admin'
import { cn } from '@/lib/utils'
import { EduNotice } from '@/components/EduNotice'
import { LoginForm } from '@/LoginForm'
import { OverviewPanel } from '@/OverviewPanel'
import { AccountsPanel } from '@/AccountsPanel'
import { KeysPanel } from '@/KeysPanel'
import { PlaygroundPanel } from '@/PlaygroundPanel'
import { ConnectPanel } from '@/ConnectPanel'

export default function App() {
  return (
    <ToastProvider>
      <Root />
    </ToastProvider>
  )
}

function Root() {
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setAuth(await api.me())
      setLoadError(null)
    } catch (err) {
      setLoadError(messageOf(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const signedOut = useCallback(() => setAuth({ configured: true, authenticated: false }), [])

  async function logout() {
    try {
      await api.logout()
    } catch {
      // Ignore: the cookie is cleared either way once we reload the state.
    }
    await refresh()
  }

  if (loadError) {
    return (
      <Shell>
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Cannot reach the gateway</CardTitle>
            <CardDescription>{loadError}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => void refresh()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      </Shell>
    )
  }

  if (!auth) {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </Shell>
    )
  }

  if (!auth.configured) {
    return (
      <Shell>
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Setup needed</CardTitle>
            <CardDescription>
              The Worker is missing its secrets. Set ADMIN_PASSWORD and ENCRYPTION_KEY with `npx wrangler secret put`
              (see the README), then reload this page.
            </CardDescription>
          </CardHeader>
        </Card>
      </Shell>
    )
  }

  if (!auth.authenticated) {
    return (
      <Shell>
        <LoginForm onDone={() => void refresh()} />
      </Shell>
    )
  }

  return <Admin onSignOut={() => void logout()} onAuthLost={signedOut} />
}

const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'accounts', label: 'Accounts', icon: Users },
  { id: 'keys', label: 'API keys', icon: KeyRound },
  { id: 'playground', label: 'Playground', icon: MessageSquare },
  { id: 'connect', label: 'Connect', icon: Plug },
]

const fetchAccounts = () => api.listAccounts().then((r) => r.accounts)
const fetchKeys = () => api.listKeys().then((r) => r.keys)

function Admin({ onSignOut, onAuthLost }: { onSignOut: () => void; onAuthLost: () => void }) {
  const toast = useToast()
  const [tab, go] = useHashTab()
  const accounts = useResource<Account[]>(fetchAccounts, onAuthLost)
  const keys = useResource<ApiKeyRecord[]>(fetchKeys, onAuthLost)
  // The newest key, kept in memory only, so the Connect tab can fill it into the snippets.
  const [freshKey, setFreshKey] = useState<string | null>(null)

  const onError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onAuthLost()
      else toast(messageOf(err), 'error')
    },
    [onAuthLost, toast],
  )

  // Keep account health current while the page is open and visible.
  const reloadAccounts = accounts.reload
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') void reloadAccounts()
    }
    const timer = window.setInterval(tick, 30_000)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [reloadAccounts])

  const needsAttention = (accounts.data ?? []).filter((a) => a.enabled && a.status === 'needs_login').length
  const current = TABS.find((t) => t.id === tab) ?? TABS[0]

  // Phone-sized screens get the sidebar as a slide-in drawer.
  const [navOpen, setNavOpen] = useState(false)
  useEffect(() => {
    if (!navOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavOpen(false)
    }
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      document.removeEventListener('keydown', onKey)
    }
  }, [navOpen])

  const navigate = (next: Tab) => {
    setNavOpen(false)
    go(next)
  }

  return (
    <div className="min-h-screen md:flex">
      {/* Top bar, phones only */}
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-background/95 px-3 py-2.5 backdrop-blur md:hidden">
        <Button variant="ghost" size="sm" aria-label="Open menu" aria-expanded={navOpen} onClick={() => setNavOpen(true)}>
          <Menu className="size-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold leading-tight">{current.label}</p>
          <p className="truncate text-xs text-muted-foreground">Quick Gateway</p>
        </div>
        {needsAttention > 0 && (
          <button
            type="button"
            onClick={() => navigate('accounts')}
            className="cursor-pointer rounded bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive"
          >
            {needsAttention} need login
          </button>
        )}
      </header>

      {/* Backdrop behind the drawer */}
      <div
        aria-hidden
        onClick={() => setNavOpen(false)}
        className={cn(
          'fixed inset-0 z-40 bg-black/40 transition-opacity md:hidden',
          navOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />

      <aside
        aria-label="Sidebar"
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-64 max-w-[85vw] flex-col border-r border-border bg-card transition-[transform,visibility] duration-200',
          'md:sticky md:top-0 md:z-auto md:h-screen md:w-60 md:shrink-0 md:translate-x-0',
          navOpen ? 'translate-x-0' : '-translate-x-full max-md:invisible',
        )}
      >
        <div className="flex items-start justify-between gap-2 px-4 pt-5 pb-4">
          <div className="min-w-0">
            <h1 className="text-base font-semibold leading-tight">Quick Gateway</h1>
            <p className="truncate text-xs text-muted-foreground" title={window.location.host}>
              {window.location.host}
            </p>
          </div>
          <Button variant="ghost" size="sm" aria-label="Close menu" className="md:hidden" onClick={() => setNavOpen(false)}>
            <X className="size-5" />
          </Button>
        </div>

        <nav aria-label="Sections" className="flex-1 overflow-y-auto px-2">
          <ul className="flex flex-col gap-0.5">
            {TABS.map((t) => {
              const active = tab === t.id
              const count =
                t.id === 'accounts' ? accounts.data?.length : t.id === 'keys' ? keys.data?.length : undefined
              const alert = t.id === 'accounts' && needsAttention > 0
              return (
                <li key={t.id}>
                  <a
                    href={`#${t.id}`}
                    aria-current={active ? 'page' : undefined}
                    onClick={(e) => {
                      e.preventDefault()
                      navigate(t.id)
                    }}
                    className={cn(
                      'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active
                        ? 'bg-accent text-foreground'
                        : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                    )}
                  >
                    <t.icon className="size-4 shrink-0" />
                    <span className="flex-1 truncate">{t.label}</span>
                    {count !== undefined && (
                      <span
                        className={cn(
                          'rounded px-1.5 text-xs tabular-nums',
                          alert ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
                        )}
                        title={alert ? `${needsAttention} need a new login` : undefined}
                      >
                        {count}
                      </span>
                    )}
                  </a>
                </li>
              )
            })}
          </ul>
        </nav>

        <EduNotice className="border-t border-border px-4 py-3" />

        <div className="border-t border-border p-2">
          <button
            type="button"
            onClick={onSignOut}
            className="flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <LogOut className="size-4" />
            Sign out
          </button>
        </div>
      </aside>

      <main className="mx-auto flex w-full min-w-0 max-w-5xl flex-1 flex-col gap-6 p-4 pb-24 sm:p-8">
        <h2 className="hidden text-xl font-semibold md:block">{current.label}</h2>
        {tab === 'overview' && <OverviewPanel accounts={accounts} keys={keys} go={go} onError={onError} />}
        {tab === 'accounts' && <AccountsPanel accounts={accounts} onError={onError} />}
        {tab === 'keys' && (
          <KeysPanel keys={keys} onError={onError} go={go} onCreated={(key) => setFreshKey(key)} />
        )}
        {tab === 'playground' && <PlaygroundPanel accounts={accounts.data} go={go} onError={onError} />}
        {tab === 'connect' && <ConnectPanel freshKey={freshKey} go={go} />}
      </main>
    </div>
  )
}

function readHash(): Tab {
  const id = window.location.hash.replace(/^#\/?/, '')
  return (TAB_IDS as string[]).includes(id) ? (id as Tab) : 'overview'
}

/** The open tab lives in the URL hash, so reloads and the back button keep your place. */
function useHashTab(): [Tab, (tab: Tab) => void] {
  const [tab, setTab] = useState<Tab>(readHash)

  useEffect(() => {
    const onHash = () => setTab(readHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const go = useCallback((next: Tab) => {
    if (window.location.hash !== `#${next}`) window.location.hash = next
    setTab(next)
    window.scrollTo({ top: 0 })
  }, [])

  return [tab, go]
}

function useResource<T>(fetcher: () => Promise<T>, onAuthLost: () => void): Resource<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setData(await fetcher())
      setError(null)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost()
      else setError(messageOf(err))
    }
  }, [fetcher, onAuthLost])

  useEffect(() => {
    void reload()
  }, [reload])

  return { data, error, reload }
}

function Shell({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-5 p-4 pb-24 sm:p-8">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold leading-tight">Quick Gateway</h1>
          <p className="truncate text-sm text-muted-foreground">
            <span className="hidden sm:inline">OpenAI and Anthropic compatible API for Amazon Quick · </span>
            {window.location.host}
          </p>
        </div>
        {action}
      </header>
      {children}
      <EduNotice className="mx-auto mt-auto max-w-md pt-8" />
    </div>
  )
}
