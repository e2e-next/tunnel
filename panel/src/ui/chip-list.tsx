/**
 * A list of short strings that are added and removed one at a time: hosts to
 * decrypt, headers to hide. A chip with a × reads as removable in a way a table
 * row does not, and the field below is where the next one goes.
 */
import { PlusIcon } from '@heroicons/react/16/solid'
import { useState } from 'react'
import { BadgeButton } from '../components/badge'
import { Button } from '../components/button'
import { Input } from '../components/input'
import { Text } from '../components/text'

export function ChipList({
  values,
  onRemove,
  onAdd,
  placeholder,
  color = 'zinc',
  empty = 'None yet.',
  label,
}: {
  values: string[]
  onRemove: (value: string) => void
  onAdd?: (value: string) => void
  placeholder?: string
  color?: 'zinc' | 'sky'
  empty?: string
  label: string
}) {
  const [draft, setDraft] = useState('')

  function add() {
    const value = draft.trim()
    if (!value || values.includes(value)) return
    onAdd?.(value)
    setDraft('')
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {values.length === 0 && <Text className="!text-sm/6 text-zinc-500">{empty}</Text>}
        {values.map((value) => (
          <BadgeButton key={value} color={color} aria-label={`Remove ${value}`} onClick={() => onRemove(value)}>
            <span className="font-mono">{value}</span> ×
          </BadgeButton>
        ))}
      </div>
      {onAdd && (
        <div className="mt-3 flex gap-2">
          <Input
            aria-label={label}
            placeholder={placeholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add()
              }
            }}
            className="[&_input]:!font-mono [&_input]:!text-xs"
          />
          <Button outline type="button" onClick={add}>
            <PlusIcon /> Add
          </Button>
        </div>
      )}
    </div>
  )
}
