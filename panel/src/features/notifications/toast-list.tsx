/**
 * Every write the panel makes says so. Success fades after three seconds,
 * failure stays until it is dismissed, because a silent failure on an
 * operator's console is the worst outcome.
 *
 * Toasts sit at the top centre rather than the top right, because the top
 * right is where every page keeps its actions: Traffic's Pause and Clear,
 * Rules' New rule, a rule page's Duplicate and Delete. The centre covers only
 * the page title, which is static text the reader has already read.
 */
import { CheckCircleIcon, ExclamationTriangleIcon, XMarkIcon } from '@heroicons/react/20/solid'
import { Button } from '../../components/button'
import { useToasts } from './use-toasts'

export function ToastList() {
  const { toasts, dismiss } = useToasts()
  if (!toasts.length) return null
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-6"
    >
      <div className="flex w-full max-w-sm flex-col gap-3">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto rounded-lg bg-white p-4 shadow-lg ring-1 ring-zinc-950/5 dark:bg-zinc-800 dark:ring-white/10"
          >
            <div className="flex items-start gap-3">
              {t.tone === 'success' ? (
                <CheckCircleIcon className="size-5 shrink-0 fill-lime-600" />
              ) : (
                <ExclamationTriangleIcon className="size-5 shrink-0 fill-rose-600" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm/6 font-medium text-zinc-950 dark:text-white">{t.title}</p>
                {t.body && <p className="mt-0.5 text-sm/6 text-zinc-500 dark:text-zinc-400">{t.body}</p>}
                {t.action && (
                  <div className="mt-2">
                    <Button plain href={t.action.href} onClick={() => dismiss(t.id)}>
                      {t.action.label}
                    </Button>
                  </div>
                )}
              </div>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => dismiss(t.id)}
                className="-m-1 shrink-0 rounded p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
              >
                <XMarkIcon className="size-4" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
