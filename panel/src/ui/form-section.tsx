/**
 * The two-column section the Catalyst settings page is built from: what this is
 * and why on the left, the controls on the right. Rules, Connect and Settings
 * all lay out this way, so the shape lives here once.
 */
import React from 'react'
import { Subheading } from '../components/heading'
import { Text } from '../components/text'

export function FormSection({
  title,
  hint,
  aside,
  children,
}: {
  title: string
  hint: string
  /** Sits before the title, for a step number or a tick. */
  aside?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
      <div className="space-y-1">
        <div className="flex items-center gap-3">
          {aside}
          <Subheading>{title}</Subheading>
        </div>
        <Text className={`!text-sm/6 ${aside ? 'sm:pl-9' : ''}`}>{hint}</Text>
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  )
}
