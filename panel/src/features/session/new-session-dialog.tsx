/**
 * Naming a session, and optionally recording into it straight away. A session
 * only exists once something is written into it, so "new" means "point this run
 * at a name", and offering to start recording is what usually follows.
 */
import { useEffect, useState } from 'react'
import { Button } from '../../components/button'
import { Checkbox, CheckboxField } from '../../components/checkbox'
import { Dialog, DialogActions, DialogBody, DialogDescription, DialogTitle } from '../../components/dialog'
import { Description, ErrorMessage, Field, FieldGroup, Label } from '../../components/fieldset'
import { Input } from '../../components/input'
import { go } from '../../router'
import { useRun } from '../run/use-run'
import { SESSION_NAME, useSessions } from './use-sessions'

export function NewSessionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { hasRecordings, use } = useSessions()
  const { toggleRecording } = useRun()
  const [name, setName] = useState('')
  const [record, setRecord] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setName('')
      setRecord(true)
      setError(null)
    }
  }, [open])

  async function create() {
    if (!SESSION_NAME.test(name)) {
      setError('Use letters, digits, dots, dashes and underscores: the name becomes a directory.')
      return
    }
    if (hasRecordings(name)) {
      setError('A session already goes by that name.')
      return
    }
    if (record) await toggleRecording(name)
    else await use(name)
    onClose()
    go(`/recordings/${encodeURIComponent(name)}`)
  }

  return (
    <Dialog open={open} onClose={onClose} size="lg">
      <DialogTitle>New session</DialogTitle>
      <DialogDescription>
        A session is the scope of one run: recordings are written into it, and replay reads
        from it.
      </DialogDescription>
      <DialogBody>
        <FieldGroup>
          <Field>
            <Label>Name</Label>
            <Input
              autoFocus
              placeholder="acct_b"
              value={name}
              invalid={!!error}
              onChange={(e) => { setName(e.target.value); setError(null) }}
              onKeyDown={(e) => e.key === 'Enter' && create()}
            />
            {error ? (
              <ErrorMessage>{error}</ErrorMessage>
            ) : (
              <Description>It becomes a directory under the data directory.</Description>
            )}
          </Field>
          <CheckboxField>
            <Checkbox checked={record} onChange={setRecord} />
            <Label>Start recording into it now</Label>
            <Description>Calls that reach the real server are written into this session.</Description>
          </CheckboxField>
        </FieldGroup>
      </DialogBody>
      <DialogActions>
        <Button plain onClick={onClose}>Cancel</Button>
        <Button disabled={!name} onClick={create}>Create</Button>
      </DialogActions>
    </Dialog>
  )
}
