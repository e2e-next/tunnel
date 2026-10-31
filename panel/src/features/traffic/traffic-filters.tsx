/**
 * The filter row. Every control narrows the same list and they combine, so they
 * sit on one line rather than behind a menu: which ones are on has to be
 * readable at a glance while you are reading the list itself.
 */
import { MagnifyingGlassIcon } from '@heroicons/react/16/solid'
import { useEffect, useRef } from 'react'
import { BadgeButton } from '../../components/badge'
import { Checkbox, CheckboxField } from '../../components/checkbox'
import { Label } from '../../components/fieldset'
import { Input, InputGroup } from '../../components/input'
import { Listbox, ListboxDescription, ListboxLabel, ListboxOption } from '../../components/listbox'
import { Select } from '../../components/select'
import type { TrafficFilters } from './use-traffic'

const STATUS_BANDS = [
  { value: '', label: 'Any status' },
  { value: '2', label: '2xx' },
  { value: '3', label: '3xx' },
  { value: '4', label: '4xx' },
  { value: '5', label: '5xx' },
]

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'CONNECT']

export function TrafficFilterRow({
  filters,
  setFilter,
  hosts,
  unmatchedCount,
  encryptedCount,
}: {
  filters: TrafficFilters
  setFilter: <K extends keyof TrafficFilters>(key: K, value: TrafficFilters[K]) => void
  hosts: [string, number][]
  unmatchedCount: number
  encryptedCount: number
}) {
  const search = useRef<HTMLInputElement>(null)

  // "/" is where a search box is on every tool a developer already uses.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName ?? ''
      if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) {
        e.preventDefault()
        search.current?.focus()
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex flex-wrap items-center gap-3">
      <InputGroup className="!w-72">
        <MagnifyingGlassIcon />
        <Input
          ref={search}
          type="search"
          aria-label="Search calls"
          placeholder="Search calls"
          value={filters.q}
          onChange={(e) => setFilter('q', e.target.value)}
        />
      </InputGroup>

      <Listbox
        aria-label="Host"
        className="!w-56"
        value={filters.host}
        onChange={(host: string) => setFilter('host', host)}
      >
        <ListboxOption value="">
          <ListboxLabel>All hosts</ListboxLabel>
        </ListboxOption>
        {hosts.map(([name, count]) => (
          <ListboxOption key={name} value={name}>
            <ListboxLabel className="font-mono">{name}</ListboxLabel>
            <ListboxDescription>{count}</ListboxDescription>
          </ListboxOption>
        ))}
      </Listbox>

      <Select
        aria-label="Method"
        className="!w-36"
        value={filters.method}
        onChange={(e) => setFilter('method', e.target.value)}
      >
        <option value="">Any method</option>
        {METHODS.map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
      </Select>

      <Select
        aria-label="Status"
        className="!w-36"
        value={filters.statusBand}
        onChange={(e) => setFilter('statusBand', e.target.value)}
      >
        {STATUS_BANDS.map((b) => (
          <option key={b.value} value={b.value}>{b.label}</option>
        ))}
      </Select>

      <BadgeButton
        color={filters.unmatchedOnly ? 'amber' : 'zinc'}
        aria-pressed={filters.unmatchedOnly}
        onClick={() => setFilter('unmatchedOnly', !filters.unmatchedOnly)}
      >
        Unmatched {unmatchedCount}
      </BadgeButton>

      <BadgeButton
        color={filters.encryptedOnly ? 'sky' : 'zinc'}
        aria-pressed={filters.encryptedOnly}
        onClick={() => setFilter('encryptedOnly', !filters.encryptedOnly)}
      >
        Encrypted {encryptedCount}
      </BadgeButton>

      <CheckboxField className="!items-center">
        <Checkbox
          checked={filters.searchBodies}
          onChange={(on) => setFilter('searchBodies', on)}
        />
        <Label className="!text-sm/6">Search bodies</Label>
      </CheckboxField>
    </div>
  )
}
