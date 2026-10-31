/** A body, as it went over the wire, with a way to take it away. */
import { Code, Text } from '../../components/text'
import { bytes } from '../../lib/format'
import { CopyButton } from '../../ui/copy-button'

export function CodeBlock({ body, encoding }: { body: string | null; encoding: string | null }) {
  if (body === null) return <Text className="!text-sm/6 text-zinc-500">No body.</Text>

  if (encoding === 'base64') {
    return (
      <Text className="!text-sm/6 text-zinc-500">
        {bytes(body.length)} of binary, not shown. The CLI writes it out with{' '}
        <Code className="!text-xs">tunnel export</Code>.
      </Text>
    )
  }

  return (
    <div className="relative mt-2">
      <pre className="max-h-96 overflow-auto rounded-lg bg-zinc-950/[2.5%] p-3 pt-9 font-mono text-xs/5 text-zinc-800 ring-1 ring-zinc-950/5 dark:bg-white/5 dark:text-zinc-200 dark:ring-white/10">
        {body}
      </pre>
      <CopyButton plain text={body} className="!absolute top-1 right-1 !text-xs" />
    </div>
  )
}
