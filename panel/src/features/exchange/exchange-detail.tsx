/**
 * One call in full: what went out, what came back, and which rule answered.
 *
 * Traffic shows it in the column beside the list and Recordings shows it in a
 * dialog, so it takes the exchange and two optional actions rather than reading
 * a route: the same component then serves both without knowing which it is in.
 */
import { XMarkIcon } from '@heroicons/react/16/solid'
import { Badge } from '../../components/badge'
import { Button } from '../../components/button'
import { DescriptionDetails, DescriptionList, DescriptionTerm } from '../../components/description-list'
import { Divider } from '../../components/divider'
import { Subheading } from '../../components/heading'
import { Text, TextLink } from '../../components/text'
import type { Exchange } from '../../api/types'
import { bytes, clock, modeColor, ms, statusColor } from '../../lib/format'
import { ruleHref } from '../../router'
import { CopyButton } from '../../ui/copy-button'
import { CodeBlock } from './code-block'
import { FieldLabel, HeaderList } from './header-list'

export function ExchangeDetail({
  exchange: x,
  onClose,
  onMock,
}: {
  exchange: Exchange
  onClose?: () => void
  onMock?: (x: Exchange) => void
}) {
  const tunnel = x.kind === 'connect'
  const query = Object.entries(x.request.query)

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start gap-3 border-b border-zinc-950/5 p-6 dark:border-white/10">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge color="zinc" className="!font-mono">{x.request.method}</Badge>
            {x.response ? (
              <Badge color={statusColor(x.response.status)}>{x.response.status}</Badge>
            ) : (
              <Badge color="zinc">tunnel</Badge>
            )}
            {x.unmatched && <Badge color="amber">unmatched</Badge>}
            {x.replay_seq !== null && <Badge color="amber">replay #{x.replay_seq}</Badge>}
          </div>
          <p className="mt-2 font-mono text-xs/5 break-all text-zinc-950 dark:text-white">{x.request.url}</p>
        </div>
        {onClose && (
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="-m-1 rounded p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
          >
            <XMarkIcon className="size-4" />
          </button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <Subheading level={3}>Overview</Subheading>
        <Divider className="mt-3" soft />
        <DescriptionList className="!text-sm/6">
          <DescriptionTerm>Time</DescriptionTerm>
          <DescriptionDetails className="tabular-nums">{clock(x.time)}</DescriptionDetails>
          {tunnel ? (
            <>
              <DescriptionTerm>Tunnel</DescriptionTerm>
              <DescriptionDetails className="!font-mono">{x.host}:{x.port}</DescriptionDetails>
              <DescriptionTerm>Bytes</DescriptionTerm>
              <DescriptionDetails>{bytes(x.bytes_up)} up · {bytes(x.bytes_down)} down</DescriptionDetails>
            </>
          ) : (
            <>
              <DescriptionTerm>Duration</DescriptionTerm>
              <DescriptionDetails>{ms(x.elapsed_ms)}</DescriptionDetails>
              <DescriptionTerm>Size</DescriptionTerm>
              <DescriptionDetails>{bytes(x.size)}</DescriptionDetails>
            </>
          )}
          <DescriptionTerm>Client</DescriptionTerm>
          <DescriptionDetails className="!font-mono">{x.client}</DescriptionDetails>
          <DescriptionTerm>Key</DescriptionTerm>
          <DescriptionDetails className="!font-mono break-all">{x.key}</DescriptionDetails>
        </DescriptionList>

        <Subheading level={3} className="mt-8">Answered by</Subheading>
        <Divider className="mt-3" soft />
        <AnsweredBy exchange={x} />

        {tunnel ? (
          <Text className="!mt-8 !text-sm/6">
            This host was tunnelled without being decrypted, so tunnel saw bytes rather than
            a request. Add it to the SSL list on{' '}
            <TextLink href="#/connect">Connect a device</TextLink> to read it.
          </Text>
        ) : (
          <>
            <Subheading level={3} className="mt-8">Request</Subheading>
            <Divider className="mt-3" soft />
            {query.length > 0 && (
              <>
                <FieldLabel>Query</FieldLabel>
                <HeaderList values={Object.fromEntries(query)} />
              </>
            )}
            <FieldLabel>Headers</FieldLabel>
            <HeaderList values={x.request.headers} />
            <FieldLabel>Body</FieldLabel>
            <CodeBlock body={x.request.body} encoding={x.request.body_encoding} />

            <Subheading level={3} className="mt-8">Response</Subheading>
            <Divider className="mt-3" soft />
            {x.response ? (
              <>
                <FieldLabel>Headers</FieldLabel>
                <HeaderList values={x.response.headers} />
                <FieldLabel>Body</FieldLabel>
                <CodeBlock body={x.response.body} encoding={x.response.body_encoding} />
              </>
            ) : (
              <Text className="!text-sm/6 text-zinc-500">Nothing came back.</Text>
            )}
          </>
        )}
      </div>

      {!tunnel && (
        <footer className="flex flex-wrap gap-3 border-t border-zinc-950/5 p-4 dark:border-white/10">
          {onMock && <Button onClick={() => onMock(x)}>Mock this…</Button>}
          <CopyButton label="Copy as curl" text={curlFor(x)} />
          <CopyButton plain label="Copy key" text={x.key} />
        </footer>
      )}
    </div>
  )
}

function AnsweredBy({ exchange: x }: { exchange: Exchange }) {
  if (x.unmatched) {
    return (
      <Text className="!text-sm/6">
        No rule matched and this session has no recording for it, so tunnel refused the
        call. Make a rule from it below, or record it in Live mode first.
      </Text>
    )
  }
  if (!x.matched_by) {
    return (
      <Text className="!text-sm/6">
        No rule matched, so the call went to the real server in Live mode.
      </Text>
    )
  }
  return (
    <DescriptionList className="!text-sm/6">
      <DescriptionTerm>Rule</DescriptionTerm>
      <DescriptionDetails>
        <TextLink href={ruleHref(x.matched_by)} className="!font-mono !text-xs">
          {x.matched_by}
        </TextLink>
      </DescriptionDetails>
      <DescriptionTerm>Mode</DescriptionTerm>
      <DescriptionDetails>
        {x.mode && <Badge color={modeColor[x.mode]}>{x.mode}</Badge>}
      </DescriptionDetails>
      {x.replay_seq !== null && (
        <>
          <DescriptionTerm>Recording</DescriptionTerm>
          <DescriptionDetails>#{x.replay_seq}</DescriptionDetails>
        </>
      )}
    </DescriptionList>
  )
}

/** The call as a shell command, so it can be replayed outside the panel. */
function curlFor(x: Exchange): string {
  const parts = [`curl -X ${x.request.method} '${x.request.url}'`]
  for (const [name, value] of Object.entries(x.request.headers)) {
    parts.push(`  -H '${name}: ${value}'`)
  }
  if (x.request.body) parts.push(`  --data '${x.request.body.replace(/'/g, "'\\''")}'`)
  return parts.join(' \\\n')
}
