/**
 * Traffic: every call through the proxy, with one of them open beside the list.
 *
 * The list and the detail sit side by side rather than on two routes because
 * debugging is "look at one, then the next": a round trip through a page would
 * cost the list's scroll position every time. Below lg there is no room for two
 * columns, so the detail becomes a dialog.
 */
import { ArrowDownIcon } from '@heroicons/react/16/solid'
import { ArchiveBoxXMarkIcon, SignalSlashIcon } from '@heroicons/react/24/outline'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Alert, AlertActions, AlertDescription, AlertTitle } from '../../components/alert'
import { BadgeButton } from '../../components/badge'
import { Button } from '../../components/button'
import { Dialog, DialogBody } from '../../components/dialog'
import { Heading } from '../../components/heading'
import { Code, Text } from '../../components/text'
import type { Summary } from '../../api/types'
import { useIsWide } from '../../lib/media'
import { go, type Route } from '../../router'
import { EmptyState, NoMatches } from '../../ui/empty-state'
import { useConnect } from '../connect/use-connect'
import { ExchangeDetail } from '../exchange/exchange-detail'
import { useExchange } from '../exchange/use-exchange'
import { useToasts } from '../notifications/use-toasts'
import { MockThisDialog } from '../rules/mock-this-dialog'
import { useRun } from '../run/use-run'
import { TrafficFilterRow } from './traffic-filters'
import { TrafficTable } from './traffic-table'
import { useTraffic } from './use-traffic'

/**
 * How far off the bottom still counts as being at it — about one dense row. A
 * row arriving mid-scroll, and the sub-pixel rounding of a fractional row
 * height, must not read as "the user scrolled up".
 */
const AT_BOTTOM = 40

export function TrafficPage({ route }: { route: Route }) {
  const traffic = useTraffic({ unmatchedOnly: route.query.get('unmatched') === '1' })
  const { notify } = useToasts()
  const { include } = useConnect()
  const wide = useIsWide()
  const [clearing, setClearing] = useState(false)
  const [mocking, setMocking] = useState<number | null>(null)

  /**
   * Following the bottom, or the seq that was last in the list when the user
   * scrolled away from it. One piece of state, because "not following" and
   * "everything after this row is new" are the same fact — and the badge has to
   * count the rows that pass the filters, since those are the ones clicking it
   * reveals.
   */
  const [leftAt, setLeftAt] = useState<number | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const rows = traffic.rows

  /**
   * Following is for the log, and only the log. A body search's rows came back
   * from the server as the answer to one question: nothing is ever appended to
   * them, so there is no bottom to pin and no arrivals to announce, and they are
   * read from the top. Filtering locally is a different thing and goes on
   * following, because what it filters is the live log — the two are on separate
   * flags on purpose.
   *
   * The scroll handler stands down too, which leaves `leftAt` as the search
   * found it: unticking resumes whatever the list was doing before.
   */
  const following = leftAt === null && !traffic.bodySearch
  const waiting =
    leftAt === null || traffic.bodySearch ? 0 : rows.filter((call) => call.seq > leftAt).length

  function onScroll() {
    const el = scroller.current
    if (!el || traffic.bodySearch) return
    const below = el.scrollHeight - el.scrollTop - el.clientHeight
    if (below > AT_BOTTOM) setLeftAt((at) => (at === null ? (rows.at(-1)?.seq ?? 0) : at))
    else setLeftAt(null)
  }

  function toBottom() {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
    setLeftAt(null)
  }

  // Pinned before the browser paints, so a row that arrives while following is
  // never seen as a jump.
  useLayoutEffect(() => {
    if (!following) return
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [rows, following])

  const selected = route.param ? Number(route.param) : null
  const { exchange, missing } = useExchange(selected)
  const { exchange: mockTarget } = useExchange(mocking)

  // The sidebar's "show unmatched" lands here with the filter in the fragment.
  const wantsUnmatched = route.query.get('unmatched') === '1'
  useEffect(() => {
    if (wantsUnmatched) traffic.setFilter('unmatchedOnly', true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsUnmatched])

  const actions = {
    open: (call: Summary) => go(`/traffic/${call.seq}`),
    mock: (call: Summary) => setMocking(call.seq),
    copyCurl: (call: Summary) => {
      navigator.clipboard?.writeText(`curl -X ${call.method} '${call.url}'`).catch(() => {})
      notify({ tone: 'success', title: 'curl command copied' })
    },
    copyKey: (call: Summary) => {
      navigator.clipboard?.writeText(call.key).catch(() => {})
      notify({ tone: 'success', title: 'Key copied' })
    },
    decrypt: (call: Summary) => include(call.host),
    onlyHost: (call: Summary) => traffic.setFilter('host', call.host),
  }

  /**
   * The row was clicked and the server does not have it: the log is a window,
   * and somebody cleared it — or newer calls pushed this one out — between the
   * list being read and the click. Rendering nothing at all is what made people
   * click again, and each click was another 404.
   */
  const detail = exchange ? (
    <ExchangeDetail
      exchange={exchange}
      onClose={() => go('/traffic')}
      onMock={(x) => setMocking(x.seq)}
    />
  ) : missing ? (
    <EmptyState
      icon={ArchiveBoxXMarkIcon}
      title="That call is gone"
      action={{ label: 'Back to the list', onClick: () => go('/traffic') }}
    >
      The log no longer holds call #{selected}. It was cleared, or newer calls pushed it
      out.
    </EmptyState>
  ) : null

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-end justify-between gap-4 px-6 pt-6 lg:px-8">
          <div>
            <Heading>Traffic</Heading>
            <Text className="!mt-1 !text-sm/6">
              {traffic.calls.length} call{traffic.calls.length === 1 ? '' : 's'} through the proxy
              {/* A body search is answered by the server, over bodies this page
                  never held, so its rows are not a share of the count in front
                  of them; the head says where they came from instead. */}
              {traffic.bodySearch
                ? `, ${rows.length} found on the server`
                : traffic.filtering && `, ${rows.length} shown`}
              {/* Said out loud, because a count that has stopped moving looks
                  like a panel that has stopped working. */}
              {traffic.paused && ' · paused'}
            </Text>
          </div>
          <div className="flex gap-3">
            <Button outline onClick={traffic.togglePause}>
              {traffic.paused ? 'Resume' : 'Pause'}
            </Button>
            <Button plain onClick={() => setClearing(true)}>Clear</Button>
          </div>
        </div>

        <div className="px-6 pt-5 lg:px-8">
          <TrafficFilterRow
            filters={traffic.filters}
            setFilter={traffic.setFilter}
            hosts={traffic.hosts}
            unmatchedCount={traffic.unmatchedCount}
            encryptedCount={traffic.encryptedCount}
          />
        </div>

        {/* The list scrolls inside the card so that the heading and the filters
            stay put; the button has to sit outside that scroll, or it would
            scroll away with the rows it is offering to show. */}
        <div className="relative min-h-0 flex-1">
          <div
            ref={scroller}
            onScroll={onScroll}
            className="h-full overflow-y-auto px-6 pb-6 lg:px-8"
          >
            {traffic.calls.length === 0 ? (
              <NoTraffic />
            ) : rows.length === 0 && traffic.searchPending ? (
              // The server has not answered yet, and the rows in hand hold no
              // bodies to match. Saying "no call matches" here would be a
              // verdict on a question still in flight.
              null
            ) : rows.length === 0 ? (
              <NoMatches what="call" onClear={traffic.clearFilters} />
            ) : (
              <TrafficTable rows={rows} selected={selected} actions={actions} />
            )}
          </div>
          {waiting > 0 && (
            // The wrapper does the positioning: BadgeButton sets `relative` on
            // itself, which an `absolute` passed in through className loses to.
            <div className="absolute right-6 bottom-6 lg:right-8">
              <BadgeButton
                onClick={toBottom}
                className="bg-white shadow-lg ring-1 ring-zinc-950/10 dark:bg-zinc-900 dark:ring-white/10"
              >
                <ArrowDownIcon className="size-3.5" />
                {waiting} new call{waiting === 1 ? '' : 's'}
              </BadgeButton>
            </div>
          )}
        </div>
      </div>

      {detail &&
        (wide ? (
          <aside className="w-[28rem] shrink-0 border-l border-zinc-950/10 dark:border-white/10">
            {detail}
          </aside>
        ) : (
          <Dialog open onClose={() => go('/traffic')} size="3xl">
            <DialogBody className="!mt-0 -m-6">{detail}</DialogBody>
          </Dialog>
        ))}

      <MockThisDialog exchange={mockTarget} onClose={() => setMocking(null)} />

      <Alert open={clearing} onClose={() => setClearing(false)}>
        <AlertTitle>Clear the log?</AlertTitle>
        <AlertDescription>
          The {traffic.calls.length} calls listed here are dropped. Recordings and rules are
          untouched.
        </AlertDescription>
        <AlertActions>
          <Button plain onClick={() => setClearing(false)}>Cancel</Button>
          <Button color="red" onClick={() => { traffic.clearLog(); setClearing(false) }}>
            Clear the log
          </Button>
        </AlertActions>
      </Alert>
    </div>
  )
}

function NoTraffic() {
  const { proxy } = useRun()
  const address = proxy ? `${proxy.lan_ips[0]}:${proxy.port}` : 'not running'
  return (
    <EmptyState
      icon={SignalSlashIcon}
      title="No traffic yet"
      action={{ label: 'Connect a device', href: '#/connect' }}
      extra={<Code>{address}</Code>}
    >
      Point a device or a simulator at the proxy and its calls appear here as they happen.
    </EmptyState>
  )
}
