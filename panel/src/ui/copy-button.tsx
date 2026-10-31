/**
 * Copying is the panel's most repeated action: an address onto a device, a key
 * into a test, a body into a bug report. The button says so for two seconds,
 * because the clipboard gives no other sign it worked.
 */
import { ClipboardIcon } from '@heroicons/react/16/solid'
import { useState } from 'react'
import { Button } from '../components/button'
import { useToasts } from '../features/notifications/use-toasts'

export function CopyButton({
  text,
  label = 'Copy',
  plain = false,
  className = '',
}: {
  text: string
  label?: string
  plain?: boolean
  className?: string
}) {
  const { notify } = useToasts()
  const [done, setDone] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // A browser without clipboard permission still gets the confirmation:
      // the text is on screen to select by hand.
    }
    setDone(true)
    setTimeout(() => setDone(false), 2000)
    notify({ tone: 'success', title: `${label} copied` })
  }

  // Catalyst types the variants as a union, so each one is its own element.
  const body = (
    <>
      <ClipboardIcon />
      {done ? 'Copied' : label}
    </>
  )
  return plain ? (
    <Button plain onClick={copy} className={className}>
      {body}
    </Button>
  ) : (
    <Button outline onClick={copy} className={className}>
      {body}
    </Button>
  )
}
