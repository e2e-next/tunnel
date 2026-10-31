// The transport independent core: what a request is answered with, decided in one place.
//
// TunnelCore.resolve(request) is the single entry point. The proxy listener, the request log and
// replay all go through it, so Request and Response are plain objects of our own (messages.ts)
// rather than anything bound to a socket: a test can ask the core exactly the question the proxy
// port asks.
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import type { TunnelConfigManager } from './config.ts'
import { reasonOf } from './errors.ts'
import { DROPPED_RESPONSE_HEADERS, decodeBody, ExchangeLog } from './exchanges.ts'
import {
  isJsonObject,
  parseJson,
  stringifySpaced,
  type JsonObject,
  type JsonValue,
} from './json.ts'
import { getLogger } from './log.ts'
import {
  effectivePort,
  errorResponse,
  jsonResponse,
  makeResponse,
  origin,
  overrideHeaders,
  requestKey,
  urlencode,
  type Request,
  type Response,
} from './messages.ts'
import { DEFAULT_SESSION, type TunnelRequestConfig } from './models.ts'
import { formatG } from './number-format.ts'
import { chooseSample, RecordingStore } from './recordings.ts'
import { selectRule } from './rule-keys.ts'
import { FunctionRunner } from './script-function.ts'
import { ScriptRunner } from './script.ts'
import { UpstreamRoutes } from './upstream-route.ts'
import { decodeContent, nodeUpstream, UpstreamError, type UpstreamClient } from './upstream.ts'

const log = getLogger('core')

/** Strict UTF-8: a byte that is not UTF-8 throws. ignoreBOM keeps a BOM at the start in the
 *  string, so that parseJson refuses it; TextDecoder would otherwise drop it unasked and merge
 *  into the JSON behind it */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** How often a wait on the caller looks up to see whether anybody is still there. The waits it
 *  slices are an hour by default (`hang`) or whatever `--delay` asked for, so a quarter of a
 *  second is both quick enough to be unnoticeable and rare enough to cost nothing */
export const WAIT_POLL_MS = 250

/** Dropped before forwarding upstream: the host belongs to the address we are sending to, and the
 *  length and the chunking are decided again once the body is a Buffer: nodeUpstream writes the
 *  length of a body that is not empty, node:http frames an empty one */
export const DROPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'transfer-encoding',
  'content-length',
])

/** What the garbage fault sends: JSON that stops in the middle. A body that begins like the JSON
 *  its content type promises and stops in the middle of it is what a truncated response from a
 *  real server looks like to a client's parser */
export const GARBAGE_BODY: Buffer = Buffer.from(
  '{"data": {"cards": [{"id": 1, "name": "half an answ',
)

/**
 * Wait up to `seconds`; true if the caller was still there at the end.
 *
 * A single sleep has nowhere to look. Both of this file's waits are waits *on somebody*, so they
 * happen in slices with a glance between them.
 *
 * A client that half-closes and goes on waiting reads the same as one that left — TCP sends the
 * same FIN for both — so its wait is cut short too.
 */
async function waitedItOut(request: Request, seconds: number): Promise<boolean> {
  const deadline = performance.now() + Math.max(seconds, 0) * 1000
  for (;;) {
    const left = deadline - performance.now()
    // The wait beats the departure: a caller that leaves exactly as the time runs out still gets
    // the answer that was being held back.
    if (left <= 0) return true
    if (request.gave_up()) return false
    // The clock is read again every round, so a timer that wakes a little early only makes one
    // more. Not unref'd: on 22.18 a test left waiting on nothing but an unref'd timer is recorded
    // as cancelled
    await sleep(Math.min(left, WAIT_POLL_MS))
  }
}

/** Deep merge: objects recurse, everything else — arrays included — is replaced outright */
export function deepMerge(base: JsonValue, patch: JsonValue): JsonValue {
  // isJsonObject, not typeof: a RawJson (an integer past 2^53) is an object too, and taking it
  // apart would write {"rawJSON": "…"}
  if (!isJsonObject(base) || !isJsonObject(patch)) return patch
  // A Map keeps the keys of base where they are and adds new ones after them; Object.fromEntries
  // makes a key named __proto__ a key like any other, where assigning it would set the prototype
  const merged = new Map(Object.entries(base))
  for (const [key, value] of Object.entries(patch)) {
    const current = merged.get(key)
    merged.set(
      key,
      isJsonObject(current) && isJsonObject(value) ? deepMerge(current, value) : value,
    )
  }
  return Object.fromEntries(merged)
}

/**
 * A rule's merge_json folded into an answer that carries JSON. Mutates `headers`: the
 * content-type it found is rewritten to application/json. A body that is not JSON comes back
 * untouched.
 *
 * Shared by passthrough and replay, which is the whole of the declarative processing: one field of
 * a real or recorded answer changed, everything else left as it came. A body that is not JSON,
 * whatever its content type claimed, is passed on untouched rather than replaced by the patch.
 */
export function mergeIntoJson(
  headers: Record<string, string>,
  body: Buffer,
  patch: Readonly<JsonObject>,
): Buffer {
  if (Object.keys(patch).length === 0) return body

  const name = findHeader(headers, 'content-type')
  if (name === null || !isJson(headers[name]!)) return body

  let merged: JsonValue
  try {
    merged = deepMerge(parseJson(UTF8.decode(body)), patch)
  } catch (error) {
    log.warning(
      `The answer said JSON but did not carry it, so nothing was merged into it: ${reasonOf(error)}`,
    )
    return body
  }

  headers[name] = 'application/json'
  return Buffer.from(stringifySpaced(merged), 'utf8')
}

export interface TunnelCoreOptions {
  exchanges?: ExchangeLog // default new ExchangeLog(configManager)
  recordings?: RecordingStore // default new RecordingStore(configManager)
  scripts?: ScriptRunner // default new ScriptRunner(recordings) — the store above, injected or not
  functions?: FunctionRunner // default new FunctionRunner(recordings) — the same store
  routes?: UpstreamRoutes // default new UpstreamRoutes(): the real environment and system proxy
  upstream?: UpstreamClient // default nodeUpstream({ routes }) — the routes above, injected or not
}

/** An answer, and whether it is the one the upstream gave: only that is worth recording, as
 *  opposed to an answer tunnel made itself in its place */
interface Answered {
  response: Response
  fromUpstream: boolean
}

/** Matches a request against the configured rules and produces the answer. One per server */
export class TunnelCore {
  readonly configManager: TunnelConfigManager
  /** Every answered request lands here, and this is where the panel, the CLI and the recordings
   *  read it from */
  readonly exchanges: ExchangeLog
  /** And, while recording is switched on, every passthrough call is kept in the data directory as
   *  well, to be replayed later */
  readonly recordings: RecordingStore
  readonly scripts: ScriptRunner
  /** The function rules, held in memory beside the stored rules for the library's callers, and
   *  their handlers, which run on this thread (script-function.ts) */
  readonly functions: FunctionRunner
  /** Which way traffic tunnel does not answer itself leaves: the default upstream asks it per
   *  request, the proxy asks it for the tunnels it does not decrypt and sets its ownProxyPort,
   *  health and the banner describe() it */
  readonly routes: UpstreamRoutes
  readonly upstream: UpstreamClient
  /** How many calls each rule replaying in `sequence` has answered, which is what decides the
   *  next recording it hands back. Reset with the script state, for the same reason: it is what
   *  one test case would otherwise leave behind for the next */
  readonly #replayCounts = new Map<string, number>()
  /** The current session the counters above were counted through. A switch to another one is
   *  another batch of recordings, so they start over; noticed here rather than announced by the
   *  configuration, which has no business knowing what the core keeps */
  #countedSession: string | null = null
  /** The replay before this one, done or not: each waits for it before it starts (#replay) */
  #replayTurn: Promise<unknown> = Promise.resolve()

  constructor(configManager: TunnelConfigManager, options?: TunnelCoreOptions) {
    this.configManager = configManager
    this.exchanges = options?.exchanges ?? new ExchangeLog(configManager)
    this.recordings = options?.recordings ?? new RecordingStore(configManager)
    // The store just settled on, given or made: a script reads the recordings replay reads
    this.scripts = options?.scripts ?? new ScriptRunner(this.recordings)
    this.functions = options?.functions ?? new FunctionRunner(this.recordings)
    this.routes = options?.routes ?? new UpstreamRoutes()
    // The routes just settled on, given or made: the ownProxyPort the proxy sets on them is what
    // keeps a passthrough from going round through tunnel itself
    this.upstream = options?.upstream ?? nodeUpstream({ routes: this.routes })
  }

  /** Scripts, function rules, upstream, exchange log, recording store, in that order */
  async close(): Promise<void> {
    await this.scripts.close()
    this.functions.close()
    await this.upstream.close()
    await this.exchanges.close()
    await this.recordings.close()
  }

  /** Clear what a test case leaves behind, ctx.state, a script's and a function rule's, and the
   *  replay counters. No key clears every bucket and returns the keys that had something, sorted;
   *  a key clears that one and returns [key] when any side had it */
  resetState(requestKey?: string | null): string[] {
    const scriptKeys = this.scripts.resetState(requestKey)
    const functionKeys = this.functions.resetState(requestKey)
    if (requestKey === undefined || requestKey === null) {
      // By UTF-16 code unit, not by code point: the two differ only past U+FFFF
      const keys = [...scriptKeys, ...functionKeys, ...this.#replayCounts.keys()]
      const cleared = [...new Set(keys)].sort()
      this.#replayCounts.clear()
      return cleared
    }
    const hadCount = this.#replayCounts.delete(requestKey)
    return scriptKeys.length > 0 || functionKeys.length > 0 || hadCount ? [requestKey] : []
  }

  /** The configured rule that answers this request, if one does: the most specific of the stored
   *  rules and the function rules together, and of a stored rule and a function rule with one
   *  key, the function rule */
  matchedRule(request: Request): TunnelRequestConfig | null {
    const stored = this.configManager.getConfig().request_configs
    // Spread after the stored rules, so that on a key both have it is the function rule's
    const configs = this.functions.size === 0 ? stored : { ...stored, ...this.functions.rules() }
    return selectRule(configs, request.method, request.host, effectivePort(request), request.path)
  }

  /** That rule, or the default one for the global mode (not stored) */
  ruleFor(request: Request): TunnelRequestConfig {
    return this.matchedRule(request) ?? this.configManager.getRequestConfig(requestKey(request))
  }

  /** Answer one request and log the exchange: what came in, what went back. Resolves with a
   *  Response whatever happens; rejects only on a bug */
  async resolve(request: Request): Promise<Response> {
    const started = performance.now()
    const matched = this.matchedRule(request)
    const rule = matched ?? this.configManager.getRequestConfig(requestKey(request))

    const { response, fromUpstream } = await this.#answer(request, rule, matched !== null)

    const exchange = this.exchanges.recordHttp(request, response, {
      elapsed_ms: Math.round(performance.now() - started),
      // The rule that answered it, as it is written: a wildcard reports its own pattern, and
      // nothing at all means the global mode answered.
      matched_by: matched?.request_key ?? null,
      mode: rule.mode,
      // Filled in by replay: which recording answered, or that nothing was configured and
      // nothing was recorded for this request.
      replay_seq: response.replay_seq,
      unmatched: response.unmatched,
    })

    // Recording is a switch over passthrough traffic rather than a mode of its own: what the real
    // server said is what is worth replaying, while a mocked answer is already written down in the
    // rule that produced it. A disabled rule answered 503 without asking anyone, so it has nothing
    // to record either. Nor has a fault, a 502 or a 500 that stood in for the upstream's answer:
    // that is tunnel's own doing, and kept, it would replace the real answer the next replay picks.
    if (exchange !== null && fromUpstream) this.recordings.save(exchange)
    return response
  }

  /**
   * Answer in this rule's mode; whatever goes wrong becomes a response too, because the exchange
   * is logged either way.
   *
   * `configured` says whether a rule of the user's own matched this request, which is what replay
   * reports as unmatched when it finds nothing.
   */
  async #answer(
    request: Request,
    rule: TunnelRequestConfig,
    configured: boolean,
  ): Promise<Answered> {
    log.info(`${request.method} ${request.host}${request.path} -> ${rule.mode}`)

    if (!rule.enabled) {
      return {
        response: errorResponse(503, `${rule.request_key} is disabled`),
        fromUpstream: false,
      }
    }

    let answered: Answered
    try {
      answered = await this.#inMode(request, rule, configured)
    } catch (error) {
      if (error instanceof UpstreamError) {
        // The upstream server, not tunnel, is what failed: say so with the status that means it,
        // and keep the detail to one line. A proxy on the way is named, as it may be what failed
        const where = `${origin(request)}${error.via ? ` through ${error.via}` : ''}`
        log.warning(`Could not reach ${where}: ${error.message}`)
        const response = errorResponse(502, `Could not reach ${where}: ${error.message}`)
        return { response, fromUpstream: false }
      }
      const key = requestKey(request)
      const message = reasonOf(error)
      const stack = error instanceof Error ? (error.stack ?? message) : message
      log.error(`Failed to answer ${key}: ${message}\n${stack}`)
      return {
        response: errorResponse(500, `Failed to answer ${key}: ${message}`),
        fromUpstream: false,
      }
    }

    // Last word, whichever mode spoke first: a rule's own headers are how a cookie or a flag is
    // put on an answer that is otherwise the real one.
    answered.response.headers = overrideHeaders(answered.response.headers, rule.headers)
    return answered
  }

  /** The answer this rule's mode produces, or the fault it produces instead */
  async #inMode(
    request: Request,
    rule: TunnelRequestConfig,
    configured: boolean,
  ): Promise<Answered> {
    if (rule.response_delay > 0 && !(await waitedItOut(request, rule.response_delay))) {
      // Only the waiting is cut short: the mode still runs, so a passthrough is still recorded, a
      // script still counts its call and a sequence replay still moves on. What the delay was
      // holding back is worth producing even once nobody is there to read it — the recording is
      // kept for later, not for the client that walked off.
      log.info(
        `Not holding ${rule.request_key} for the rest of its ${formatG(rule.response_delay)}s ` +
          'delay: the client stopped waiting',
      )
    }

    if (rule.fault !== 'none') {
      return { response: await this.#fault(request, rule), fromUpstream: false }
    }

    switch (rule.mode) {
      case 'json':
        return { response: jsonResponse(rule.json_response, rule.status_code), fromUpstream: false }
      case 'script': {
        const session = this.configManager.getConfig().session
        // A function rule's handler runs on this thread, a stored rule's script in the worker
        const runner = this.functions.owns(rule) ? this.functions : this.scripts
        return { response: await runner.run(request, rule, session), fromUpstream: false }
      }
      case 'passthrough':
        // The one answer that is the upstream's own, once it has come back
        return { response: await this.#passthrough(request, rule), fromUpstream: true }
      case 'replay':
        // What the real server once said, played back: recorded already, not recorded again
        return { response: await this.#replay(request, rule, configured), fromUpstream: false }
      default:
        // A configuration that was checked cannot get here, which is why rule.mode is `never`
        return {
          response: errorResponse(500, `Unknown response mode: ${rule.mode as string}`),
          fromUpstream: false,
        }
    }
  }

  /**
   * Go wrong the way this rule was told to, instead of answering.
   *
   * Each of the three is a client error branch that is otherwise hard to reach: a request that
   * never comes back, an answer that does not parse, and a connection that drops mid-flight.
   */
  async #fault(request: Request, rule: TunnelRequestConfig): Promise<Response> {
    log.info(`Answering ${rule.request_key} with the ${rule.fault} fault`)

    if (rule.fault === 'hang') return this.#hang(request, rule)
    if (rule.fault === 'garbage') {
      return makeResponse({
        status: rule.status_code,
        headers: { 'content-type': 'application/json' },
        body: GARBAGE_BODY,
      })
    }
    // close: nothing is written at all. The listener reads this and drops the connection, so the
    // client meets a network error rather than a status it could have handled.
    return makeResponse({ status: 0, close: true })
  }

  /**
   * Hold the request for `fault_seconds`, unless the caller stops waiting.
   *
   * The wait is the whole point of the fault, but it is a wait *on somebody*. An hour is the
   * default — longer than any client's timeout, which is what makes it useful — so a client that
   * gave up after thirty seconds would otherwise leave a connection task and its socket held for
   * the remaining fifty-nine and a half minutes, over and over across a test run.
   */
  async #hang(request: Request, rule: TunnelRequestConfig): Promise<Response> {
    const started = performance.now()
    const seconds = formatG(rule.fault_seconds)
    if (await waitedItOut(request, rule.fault_seconds)) {
      return errorResponse(504, `${rule.request_key} hung for ${seconds} seconds`)
    }

    const held = ((performance.now() - started) / 1000).toFixed(1)
    log.info(
      `Letting go of ${rule.request_key} after ${held}s: it was told to hang for ${seconds}, ` +
        'and the client stopped waiting',
    )
    // Nothing is written to a socket nobody is holding — the same shape the `close` fault uses.
    // The exchange is still logged, so the run can see the call arrived and was abandoned.
    return makeResponse({ status: 0, close: true })
  }

  /**
   * Answer from the recordings, with the sample the strategy picks.
   *
   * Nothing here reaches the network, which is the whole point in a test run: what the client
   * gets is what the real server once said, status, headers and body together.
   *
   * One replay at a time, in the order they arrive. The store is read with awaits between reading
   * a sequence's position and moving it on, and replays that arrive together would all be handed
   * the same recording.
   */
  #replay(request: Request, rule: TunnelRequestConfig, configured: boolean): Promise<Response> {
    const turn = this.#replayTurn.then(() => this.#replayInTurn(request, rule, configured))
    // The next one goes once this one is done, however it ended
    this.#replayTurn = turn.catch(() => undefined)
    return turn
  }

  /** #replay, once this request's turn has come */
  async #replayInTurn(
    request: Request,
    rule: TunnelRequestConfig,
    configured: boolean,
  ): Promise<Response> {
    const current = this.configManager.getConfig().session || DEFAULT_SESSION
    if (current !== this.#countedSession) {
      this.#countedSession = current
      this.#replayCounts.clear()
    }

    // A rule that names a session is pinned to it; one that does not follows the run, so that a
    // single switch moves every endpoint at once.
    const session = rule.replay_session || current
    const samples = await this.recordings.samples(
      session,
      request.method,
      request.host,
      request.path,
      rule.request_key,
    )
    const position = this.#replayCounts.get(rule.request_key) ?? 0
    const chosen = chooseSample(samples, rule.replay_strategy, request.query, position)
    const recorded = chosen === null ? null : await this.recordings.load(chosen)
    if (recorded === null || recorded.response === null) {
      return this.#nothingRecorded(request, session, configured)
    }

    // Moved on only once there is an answer: a recording that could not be read is no call
    // answered, and the next one is offered the same sample. And only from where it was read: a
    // reset while the recording was read comes after this call, and the counter stays cleared
    if (
      rule.replay_strategy === 'sequence' &&
      (this.#replayCounts.get(rule.request_key) ?? 0) === position
    ) {
      this.#replayCounts.set(rule.request_key, position + 1)
    }

    const answer = recorded.response
    const headers = dropHeaders(answer.headers, DROPPED_RESPONSE_HEADERS)
    if (this.configManager.getConfig().replay_marker) {
      // Which recording this came from: the quickest way to tell a replayed answer from a real
      // one while a test is being written.
      headers['x-tunnel-replay'] = String(recorded.seq)
    }

    log.info(`Replaying ${requestKey(request)} from session ${session}, recording ${recorded.seq}`)
    const body = mergeIntoJson(
      headers,
      decodeBody(answer.body, answer.body_encoding),
      rule.merge_json,
    )
    return makeResponse({ status: answer.status, headers, body, replay_seq: recorded.seq })
  }

  /**
   * Replay had nothing to answer with: 404, saying which kind of nothing.
   *
   * An endpoint nobody configured and nobody recorded is the one worth flagging: it is what
   * `tunnel requests --unmatched` lists, and the header is there so that a client's own test case
   * can see it as well. A rule that asked for a session holding nothing for it is a different
   * mistake, so it reads differently and is not counted as a missing rule; it names the session
   * that was searched rather than the field it came from, since a rule that leaves the field
   * empty is read as the current session.
   */
  #nothingRecorded(request: Request, session: string, configured: boolean): Response {
    const key = requestKey(request)
    if (configured) return errorResponse(404, `No recording for ${key} in session ${session}`)

    log.info(`Nothing configured and nothing recorded for ${key}`)
    const response = jsonResponse({ detail: `no rule or recording for ${key}`, key }, 404, {
      'x-tunnel-unmatched': '1',
    })
    response.unmatched = true
    return response
  }

  async #passthrough(request: Request, rule: TunnelRequestConfig): Promise<Response> {
    const url = this.#upstreamUrl(request, rule)
    const headers = dropHeaders(request.headers, DROPPED_REQUEST_HEADERS)

    log.info(`Passing ${request.method} ${url} through`)
    const upstream = await this.upstream.send({
      method: request.method,
      url,
      headers,
      body: request.body,
    })

    // decodeContent takes the encoding off the body below (zlib), so leaving the encoding header
    // on would make the client decompress it a second time; the length changed with the body, and
    // chunking is the transport's business. Names are compared in lower case: nodeUpstream gives
    // them that way, a fake upstream may not
    const responseHeaders = dropHeaders(upstream.headers, DROPPED_RESPONSE_HEADERS)
    const name = findHeader(upstream.headers, 'content-encoding')
    const encoding = name === null ? undefined : upstream.headers[name]
    const body = mergeIntoJson(
      responseHeaders,
      decodeContent(upstream.body, encoding),
      rule.merge_json,
    )

    return makeResponse({ status: upstream.status, headers: responseHeaders, body })
  }

  /**
   * Where passthrough sends this request.
   *
   * With no `target` it goes to the origin the client was calling anyway, which is the whole
   * point of a forward proxy. A target that carries a path of its own replaces the URL outright —
   * Charles calls that Map Remote — while a bare base URL only replaces the origin.
   */
  #upstreamUrl(request: Request, rule: TunnelRequestConfig): string {
    const target = rule.target.trim()
    let url: string
    if (target !== '' && hasPath(target)) {
      url = target
    } else {
      if (target === '' && request.host === '') {
        throw new Error('passthrough has no target and the request carries no host to send it to')
      }
      url = `${target !== '' ? target.replace(/\/+$/, '') : origin(request)}${request.path}`
    }

    const query = urlencode(request.query)
    if (query !== '') url += (url.includes('?') ? '&' : '?') + query
    return url
  }
}

function isJson(contentType: string): boolean {
  return contentType.toLowerCase().includes('application/json')
}

/** True for `https://api.example.com/v5/feed`, false for `https://api.example.com` */
function hasPath(url: string): boolean {
  // What URL cannot parse (`nonsense`) is all path: used as it is, it is the upstream client that
  // says what is wrong with it
  if (!URL.canParse(url)) return true
  // `http://other` has the path '/': like '', not a path of its own
  const { pathname } = new URL(url)
  return pathname !== '' && pathname !== '/'
}

/** `headers` without the ones `names` lists, whatever the case they are spelled in: a new object,
 *  `headers` as it was. Object.fromEntries keeps a header named __proto__ a key like any other */
function dropHeaders(
  headers: Readonly<Record<string, string>>,
  names: ReadonlySet<string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !names.has(name.toLowerCase())),
  )
}

/** The first name in `headers` that is `name` (lower case) whatever its case, or null */
function findHeader(headers: Readonly<Record<string, string>>, name: string): string | null {
  return Object.keys(headers).find((key) => key.toLowerCase() === name) ?? null
}
