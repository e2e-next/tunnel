/** What goes back on the wire, whichever mode produced it, and how to break it. */
import { Description, Field, Label } from '../../../components/fieldset'
import { Input } from '../../../components/input'
import { Select } from '../../../components/select'
import { Textarea } from '../../../components/textarea'
import type { Rule } from '../../../api/types'

export function ResponseFields({
  draft,
  onEdit,
}: {
  draft: Rule
  onEdit: (patch: Partial<Rule>) => void
}) {
  const headerText = Object.entries(draft.headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')

  function parseHeaders(text: string) {
    const headers: Record<string, string> = {}
    for (const line of text.split('\n')) {
      const at = line.indexOf(':')
      if (at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim()
    }
    onEdit({ headers })
  }

  return (
    <>
      <div className="flex gap-3">
        <Field className="w-32">
          <Label>Status</Label>
          <Input
            type="number"
            value={draft.status_code}
            onChange={(e) => onEdit({ status_code: Number(e.target.value) })}
          />
        </Field>
        <Field className="w-32">
          <Label>Delay</Label>
          <Input
            type="number"
            step="0.1"
            value={draft.response_delay}
            onChange={(e) => onEdit({ response_delay: Number(e.target.value) })}
          />
          <Description>Seconds.</Description>
        </Field>
      </div>
      <Field>
        <Label>Extra headers</Label>
        <Textarea
          rows={3}
          placeholder="x-request-id: abc123"
          value={headerText}
          onChange={(e) => parseHeaders(e.target.value)}
          className="[&_textarea]:!font-mono [&_textarea]:!text-xs"
        />
        <Description>One per line, name then colon then value.</Description>
      </Field>
    </>
  )
}

export function FaultFields({
  draft,
  onEdit,
}: {
  draft: Rule
  onEdit: (patch: Partial<Rule>) => void
}) {
  return (
    <div className="flex gap-3">
      <Field className="w-48">
        <Label>Fault</Label>
        <Select value={draft.fault} onChange={(e) => onEdit({ fault: e.target.value as Rule['fault'] })}>
          <option value="none">None</option>
          <option value="hang">Hang</option>
          <option value="garbage">Garbage bytes</option>
          <option value="close">Close the connection</option>
        </Select>
      </Field>
      {draft.fault === 'hang' && (
        <Field className="w-32">
          <Label>For</Label>
          <Input
            type="number"
            value={draft.fault_seconds}
            onChange={(e) => onEdit({ fault_seconds: Number(e.target.value) })}
          />
          <Description>Seconds.</Description>
        </Field>
      )}
    </div>
  )
}
