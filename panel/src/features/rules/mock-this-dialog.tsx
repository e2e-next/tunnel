/**
 * Making a rule out of a call that already happened: the shortest path from
 * "I saw this response" to "answer this endpoint with it from now on". A dialog
 * rather than the editor, because it should not cost you your place in the list.
 */
import { useEffect, useState } from 'react'
import { Button } from '../../components/button'
import { Checkbox, CheckboxField } from '../../components/checkbox'
import { Dialog, DialogActions, DialogBody, DialogDescription, DialogTitle } from '../../components/dialog'
import { Description, ErrorMessage, Field, FieldGroup, Label } from '../../components/fieldset'
import { Input } from '../../components/input'
import { Textarea } from '../../components/textarea'
import type { Exchange } from '../../api/types'
import { splitKey } from '../../lib/format'
import { ruleHref } from '../../router'
import { useToasts } from '../notifications/use-toasts'
import { BLANK_RULE, useRules } from './use-rules'

export function MockThisDialog({
  exchange,
  onClose,
}: {
  exchange: Exchange | null
  onClose: () => void
}) {
  const { find, save } = useRules()
  const { failed } = useToasts()
  const [status, setStatus] = useState('200')
  const [body, setBody] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!exchange) return
    setStatus(String(exchange.response?.status ?? 200))
    const raw = exchange.response?.body ?? '{}'
    try {
      setBody(JSON.stringify(JSON.parse(raw), null, 2))
    } catch {
      setBody(raw)
    }
    setEnabled(true)
    setError(null)
  }, [exchange])

  if (!exchange) return null

  const key = exchange.key
  const existing = find(key)
  const { method, path } = splitKey(key)

  async function create() {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch (e) {
      setError(`That is not valid JSON: ${(e as Error).message}`)
      return
    }
    const err = await save(
      {
        ...BLANK_RULE,
        key,
        mode: 'json',
        json_response: parsed,
        status_code: Number(status) || 200,
        enabled,
        description: `Made from call #${exchange!.seq}`,
      },
      existing ? 'Rule replaced' : 'Rule created'
    )
    if (err) {
      failed('Could not save the rule', err)
      return
    }
    onClose()
  }

  return (
    <Dialog open onClose={onClose} size="2xl">
      <DialogTitle>
        Mock <span className="font-mono">{method} {path}</span>
      </DialogTitle>
      <DialogDescription>
        Answer this endpoint with the response below instead of the real server.
        {existing && ' A rule already covers this key, and saving replaces it.'}
      </DialogDescription>
      <DialogBody>
        <FieldGroup>
          <Field>
            <Label>Key</Label>
            <Input readOnly value={key} className="[&_input]:!font-mono [&_input]:!text-xs" />
            <Description>Method, host and path. Duplicate the rule later to change it.</Description>
          </Field>
          <Field>
            <Label>Status</Label>
            <Input
              type="number"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="max-w-32"
            />
          </Field>
          <Field>
            <Label>Response</Label>
            <Textarea
              rows={12}
              value={body}
              invalid={!!error}
              onChange={(e) => { setBody(e.target.value); setError(null) }}
              className="[&_textarea]:!font-mono [&_textarea]:!text-xs"
            />
            {error ? <ErrorMessage>{error}</ErrorMessage> : <Description>Sent as the body, as JSON.</Description>}
          </Field>
          <CheckboxField>
            <Checkbox checked={enabled} onChange={setEnabled} />
            <Label>Enabled</Label>
            <Description>Off keeps the rule but lets calls through.</Description>
          </CheckboxField>
        </FieldGroup>
      </DialogBody>
      <DialogActions>
        <Button plain onClick={onClose}>Cancel</Button>
        <Button onClick={create}>{existing ? 'Replace rule' : 'Create rule'}</Button>
      </DialogActions>
    </Dialog>
  )
}

export { ruleHref }
