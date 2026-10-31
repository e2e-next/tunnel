/**
 * Every write the panel makes says so. Success fades; failure stays until it is
 * dismissed, because a silent failure on an operator's console is the worst
 * outcome. Kept apart from server state: a toast is about this browser tab.
 */
import React, { createContext, useCallback, useContext, useMemo, useState } from 'react'

export interface Toast {
  id: number
  tone: 'success' | 'error'
  title: string
  body?: string
  action?: { label: string; href: string }
}

interface Toasts {
  toasts: Toast[]
  notify: (t: Omit<Toast, 'id'>) => void
  /** Reports a failed write, with whatever the API said. */
  failed: (what: string, error: unknown) => void
  dismiss: (id: number) => void
}

const Context = createContext<Toasts | null>(null)

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), [])

  const notify = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random()
    setToasts((all) => [...all, { ...t, id }])
    if (t.tone === 'success') setTimeout(() => dismiss(id), 3000)
  }, [dismiss])

  const failed = useCallback(
    (what: string, error: unknown) =>
      notify({ tone: 'error', title: what, body: error instanceof Error ? error.message : String(error) }),
    [notify]
  )

  const value = useMemo(() => ({ toasts, notify, failed, dismiss }), [toasts, notify, failed, dismiss])
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function useToasts(): Toasts {
  const t = useContext(Context)
  if (!t) throw new Error('useToasts outside ToastProvider')
  return t
}
