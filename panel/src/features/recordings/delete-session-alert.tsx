/**
 * Deleting recordings says how many go, because "delete session" reads as
 * harmless until you learn it is the only copy of a captured bug.
 */
import { Button } from '../../components/button'
import { Alert, AlertActions, AlertDescription, AlertTitle } from '../../components/alert'

export function DeleteSessionAlert({
  name,
  count,
  isCurrent,
  onConfirm,
  onClose,
}: {
  name: string | null
  count: number
  isCurrent: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  if (!name) return null
  return (
    <Alert open onClose={onClose}>
      <AlertTitle>Delete {count} recording{count === 1 ? '' : 's'}?</AlertTitle>
      <AlertDescription>
        Everything recorded into <span className="font-mono text-xs">{name}</span> is deleted.
        {isCurrent
          ? ' It stays the current session, empty, so this run keeps writing into it.'
          : ' The session goes with it.'}
      </AlertDescription>
      <AlertActions>
        <Button plain onClick={onClose}>Cancel</Button>
        <Button color="red" onClick={() => { onConfirm(); onClose() }}>Delete recordings</Button>
      </AlertActions>
    </Alert>
  )
}
