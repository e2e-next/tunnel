/**
 * One step of connecting a device. The number turns into a tick when the log
 * shows the step actually worked, so the page reports reality rather than
 * repeating what was configured.
 */
import { CheckIcon } from '@heroicons/react/16/solid'
import React from 'react'
import { FormSection } from '../../ui/form-section'

export function ConnectStep({
  n,
  title,
  hint,
  done,
  children,
}: {
  n: number
  title: string
  hint: string
  done: boolean
  children: React.ReactNode
}) {
  return (
    <FormSection
      title={title}
      hint={hint}
      aside={
        <span
          aria-label={done ? 'Done' : `Step ${n}`}
          className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
            done
              ? 'bg-lime-500 text-white'
              : 'bg-zinc-950/5 text-zinc-600 dark:bg-white/10 dark:text-zinc-300'
          }`}
        >
          {done ? <CheckIcon className="size-3.5 fill-white" /> : n}
        </span>
      }
    >
      {children}
    </FormSection>
  )
}
