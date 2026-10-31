/**
 * What a page says when it has nothing to show. Always names the reason and
 * offers the next step, because "empty" and "broken" look the same otherwise.
 */
import React from 'react'
import { Button } from '../components/button'
import { Text } from '../components/text'

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  extra,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  children: React.ReactNode
  action?: { label: string; href?: string; onClick?: () => void }
  extra?: React.ReactNode
}) {
  return (
    <div className="py-20 text-center">
      <Icon className="mx-auto size-10 stroke-zinc-400" />
      <h3 className="mt-4 text-base/7 font-semibold text-zinc-950 dark:text-white">{title}</h3>
      <Text className="!mx-auto !mt-1 !max-w-md">{children}</Text>
      {extra && <div className="mt-4">{extra}</div>}
      {action &&
        (action.href ? (
          <Button className="mt-6" href={action.href}>
            {action.label}
          </Button>
        ) : (
          <Button className="mt-6" onClick={action.onClick}>
            {action.label}
          </Button>
        ))}
    </div>
  )
}

/** The other empty: filters that match nothing. */
export function NoMatches({ what, onClear }: { what: string; onClear: () => void }) {
  return (
    <div className="py-16 text-center">
      <Text>No {what} matches these filters.</Text>
      <Button plain className="mt-3" onClick={onClear}>
        Clear filters
      </Button>
    </div>
  )
}
