// Script mode, the main thread's side:
// ScriptRunner, which answers a request with its rule's handler(ctx); compileScript, the check
// the admin API runs before it writes a script; and the messages the main thread and
// the worker that runs handler(ctx) (script-worker.ts) send each other. The worker imports those
// as types only, which are erased, so neither module imports the other at runtime.
//
// One worker thread runs the scripts, one request at a time, each run with a timer, and a run
// that outlives its timer is stopped by terminating the worker; the next request starts another.
// One worker rather than one per request: starting one takes 30–80 ms, a run in a live one about
// 0.01 ms. One request at a time rather than a pool: a rule's ctx.state goes into a run and comes
// back with its result, so two runs of one rule at once would lose one's changes. A slow script
// holds up the script requests behind it, and nothing else.
//
// ctx.state stays on this thread, as the JSON text of each rule's bucket, and goes to the worker
// with each run: a worker stopped for one rule's timeout takes no other rule's state with it, and
// resetState answers at once.
import { MessageChannel, Worker, type MessagePort } from 'node:worker_threads'
import { reasonOf, UserError } from './errors.ts'
import { DROPPED_RESPONSE_HEADERS } from './exchanges.ts'
import { parseJson } from './json.ts'
import { getLogger } from './log.ts'
import {
  effectivePort,
  errorResponse,
  makeResponse,
  overrideHeaders,
  requestUrl,
  textResponse,
  type Request,
  type Response,
} from './messages.ts'
import type { TunnelRequestConfig } from './models.ts'
import { recordedBytes, RecordingReader, type Recorded, type RecordingStore } from './recordings.ts'
import { looksLikePython, prepareScript, PYTHON_HINT, ScriptSyntaxError } from './script-compile.ts'

/** One script run gets ten seconds */
export const SCRIPT_TIMEOUT_MS = 10_000

export interface ScriptRunnerOptions {
  /** How long one run may take, SCRIPT_TIMEOUT_MS unless given. The tests of timeouts give 100 */
  timeoutMs?: number
}

/** The check admin.ts's validatePatch runs on a script: throws UserError with the sentence
 *  `<key> has a script syntax error on line <N>: <message>`, when the script will not compile.
 *  Synchronous, and it runs none of the script.
 *
 *  Nothing is written here, so a whole batch can be checked before any of it is applied. An empty
 *  script is never passed here: validatePatch skips one */
export function compileScript(source: string, key: string): void {
  try {
    prepareScript(source, `script:${key}`)
  } catch (error) {
    // Anything else is a bug, not the caller's mistake to be told about in a 400
    if (!(error instanceof ScriptSyntaxError)) throw error
    // Where the parser gave no line, the sentence leaves the place out
    const where = error.line === null ? '' : ` on line ${error.line}`
    // When the script is a handler written in Python, the sentence says so
    const hint = looksLikePython(source) ? `. ${PYTHON_HINT}` : ''
    throw new UserError(`${key} has a script syntax error${where}: ${error.message}${hint}`)
  }
}

// ---- The wire between the two threads ----
// Every message is structured-cloned, so they are plain data: a Request's Buffer body goes as a
// Uint8Array of its own, its gave_up function not at all, and a Recorded as JSON text.
// script-worker.ts imports these as types.

/** What ctx shows of the request: Request's fields, port already effective, url already built */
export interface ScriptRequest {
  method: string
  scheme: string
  host: string
  port: number
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  body: Uint8Array
  client: string
  url: string
}

/** One request for the worker to answer with the rule's script. The main thread sends one at a
 *  time */
export interface RunMessage {
  type: 'run'
  id: number
  key: string
  source: string
  request: ScriptRequest
  stateJson: string // the rule's ctx.state bucket, '{}' the first time
}

/** ctx.recorded() / ctx.recordings(), on the lookup port */
export interface LookupMessage {
  id: number // the job it belongs to; a stale id is ignored
  op: 'one' | 'all'
  query: Record<string, string> | null // one only: null is "the request's own"
  key: string | null
  session: string | null
}

/** The main thread's answer on the lookup port: the Recorded (or null), or the list of them, as
 *  JSON text; or the message of the error the lookup threw, which the worker throws in the
 *  script */
export type LookupReply = { ok: true; json: string } | { ok: false; message: string }

/** What the handler returned, in the kinds the main thread answers differently */
export type ScriptBody =
  | { kind: 'none' }
  | { kind: 'json'; text: string } // stringifySpaced, big ints as digits
  | { kind: 'text'; text: string }
  | { kind: 'bytes'; bytes: Uint8Array }
  // The Recorded as JSON; bytes when the script put bytes in body
  | { kind: 'recorded'; json: string; bodyBytes: Uint8Array | null }

/** A returned value: status and headers are what the script gave ctx.reply, null when it gave
 *  none */
export interface ScriptReturn {
  status: number | null
  headers: Record<string, string> | null
  body: ScriptBody
}

/** The end of a run: what the handler returned, or the stack of what it threw */
export interface ResultMessage {
  type: 'result'
  id: number
  stateJson: string // ctx.state after the run, also when it threw
  outcome: { kind: 'returned'; value: ScriptReturn } | { kind: 'threw'; stack: string }
}

/** The worker's last top-level statement. The first job waits for it, so loading the worker
 *  (33–82 ms) is not charged to the script's timeout */
export interface ReadyMessage {
  type: 'ready'
}

/** What a script threw, or rejected a promise with, where nothing caught it: in a timer, a listener
 *  or a promise its handler left behind. The worker goes on, and the main thread logs it and answers
 *  no request with it: the request being answered need not be the one whose script left it */
export interface UncaughtMessage {
  type: 'uncaught'
  stack: string
}

/** What the worker posts to the main thread on its own port; lookups go on the lookup port */
export type WorkerMessage = ReadyMessage | ResultMessage | UncaughtMessage

// ---- The runner ----

/** script-worker.ts beside this module: .ts when tunnel runs from source, .js from dist. tsc's
 *  rewriteRelativeImportExtensions rewrites import statements, not strings, hence the choice */
const WORKER_URL = new URL(
  import.meta.url.endsWith('.ts') ? './script-worker.ts' : './script-worker.js',
  import.meta.url,
)

const log = getLogger('script')

/** One request and its rule, from run() until it is answered */
interface Job {
  id: number
  key: string // the rule's request_key, which names its ctx.state bucket
  rule: TunnelRequestConfig
  request: ScriptRequest
  reader: RecordingReader // what the script's ctx.recorded() and ctx.recordings() read
  resolve: (response: Response) => void
  timer: NodeJS.Timeout | undefined // from when the run is posted to the worker
}

/** The worker and what is its alone: its end of the lookup channel, the flag it waits on while a
 *  lookup is answered, and whether it has loaded */
interface Live {
  worker: Worker
  port: MessagePort
  flag: Int32Array
  ready: Promise<void> // resolves on its ReadyMessage, rejects should it stop before that
}

/** Runs the `script` rules' handler(ctx) in one worker thread, one request at a time, and holds
 *  their ctx.state buckets, in one object the core owns */
export class ScriptRunner {
  readonly timeoutMs: number
  readonly #store: RecordingStore
  /** Script state, one bucket per rule key, each the JSON text of the rule's ctx.state. In memory
   *  only: it is what a test case resets between runs, not something to carry across restarts */
  readonly #state = new Map<string, string>()
  /** The jobs behind #current, oldest first */
  readonly #queue: Job[] = []
  /** The job the worker is running, or is starting up to run */
  #current: Job | null = null
  #live: Live | null = null
  #nextId = 1

  constructor(recordings: RecordingStore, options: ScriptRunnerOptions = {}) {
    this.#store = recordings
    this.timeoutMs = options.timeoutMs ?? SCRIPT_TIMEOUT_MS
  }

  /** Answer one request with this rule's script. Never rejects: whatever goes wrong is a
   *  Response — 500 {"detail": "<key> is in script mode but has no script"}, 500 text
   *  "The script failed:\n<stack>", 500 text "The script timed out after <seconds> seconds",
   *  500 text "The script runner crashed: <why>" */
  run(request: Request, rule: TunnelRequestConfig, currentSession: string): Promise<Response> {
    if (rule.script.trim() === '') {
      return Promise.resolve(
        errorResponse(500, `${rule.request_key} is in script mode but has no script`),
      )
    }
    // The state bucket is keyed by the rule, which may be a wildcard: one rule, one bucket, so
    // that a reset clears something predictable. Made before the run, so a reset names a rule
    // that ran whatever its script did
    const key = rule.request_key
    if (!this.#state.has(key)) this.#state.set(key, '{}')
    const reader = new RecordingReader(this.#store, request, rule, currentSession)
    // What the script's ctx shows of the request, which goes to the worker
    const shown = scriptRequest(request)
    return new Promise((resolve) => {
      const id = this.#nextId++
      this.#queue.push({ id, key, rule, request: shown, reader, resolve, timer: undefined })
      void this.#pump()
    })
  }

  /** The scripts' side of the core's resetState: clear what a test case leaves behind in
   *  ctx.state. No key clears every bucket and returns their keys sorted; a key drops that bucket
   *  and returns [key] when there was one, else [] */
  resetState(requestKey?: string | null): string[] {
    if (requestKey === undefined || requestKey === null) {
      const cleared = [...this.#state.keys()].sort()
      this.#state.clear()
      return cleared
    }
    return this.#state.delete(requestKey) ? [requestKey] : []
  }

  /** Stop the worker. Queued or running jobs are answered 500 text "The script runner was closed".
   *  A later run() starts a new worker */
  async close(): Promise<void> {
    const closed = () => textResponse('The script runner was closed', 500)
    for (const job of this.#queue.splice(0)) job.resolve(closed())
    const job = this.#current
    if (job !== null) {
      clearTimeout(job.timer)
      job.resolve(closed())
      this.#current = null
    }
    const live = this.#live
    if (live === null) return
    // Let go of it before waiting for it to stop: a run() meanwhile starts another worker rather
    // than posting to this one
    this.#live = null
    live.port.close()
    await live.worker.terminate()
  }

  /** Post the first job of the queue to the worker, starting a worker first when there is none.
   *  Does nothing while a job is running */
  async #pump(): Promise<void> {
    if (this.#current !== null) return
    const job = this.#queue.shift()
    if (job === undefined) return
    // Taken before the wait below, so that a #pump meanwhile finds a job running and leaves it
    this.#current = job
    // Not inside the try: new Worker() throws only for an execArgv flag it refuses, and every Node
    // from 22.18 on takes this one, while the catch would leave the job unanswered and every run
    // after it waiting behind it
    const live = this.#live ?? this.#spawn()
    try {
      // A new worker takes 33–82 ms to load, which is not the script's to be charged for: the
      // timer starts when the run is posted, so a 100 ms timeout still gives a run 100 ms
      await live.ready
    } catch {
      // It stopped before it was ready: close() stopped it and has answered the job, or its error
      // or exit event answers it
      return
    }
    // Answered while it waited, by close() or by a stopped worker: nothing left to post
    if (this.#current !== job) return
    live.worker.ref()
    job.timer = setTimeout(() => this.#timedOut(), this.timeoutMs)
    const run: RunMessage = {
      type: 'run',
      id: job.id,
      key: job.key,
      source: job.rule.script,
      request: job.request,
      stateJson: this.#state.get(job.key) ?? '{}',
    }
    // The body run() copied: its ArrayBuffer is the job's own, so it moves to the worker
    live.worker.postMessage(run, [job.request.body.buffer as ArrayBuffer])
  }

  /** A worker, which becomes #live, with every handler wired. It stays referenced, so the process
   *  waits for it, until #finish finds nothing left to run: unreferenced while it loads, it would
   *  leave nothing on the event loop, and Node would exit 13 on a top-level await never settled */
  #spawn(): Live {
    const { port1, port2 } = new MessageChannel()
    const flag = new Int32Array(new SharedArrayBuffer(4))
    const worker = new Worker(WORKER_URL, {
      name: 'tunnel-script',
      // Instead of the parent's flags, which a test run's --import is among, this one: the
      // worker's first stripTypeScriptTypes call warns, on the parent's stderr
      execArgv: ['--disable-warning=ExperimentalWarning'],
      workerData: { lookupPort: port2, flag },
      transferList: [port2],
    })
    const ready = Promise.withResolvers<void>()
    const live: Live = { worker, port: port1, flag, ready: ready.promise }
    // Each handler knows its own worker and ignores what any other sends: a worker that was
    // terminated reports its exit late, after the next one may have answered a run
    port1.on('message', (message: LookupMessage) => {
      if (live === this.#live) void this.#onLookup(live, message)
    })
    // The port is a live handle too, which would keep the process from exiting while the worker
    // idles unreferenced
    port1.unref()
    worker.on('message', (message: WorkerMessage) => {
      if (message.type === 'ready') ready.resolve()
      // From whichever worker: what a script left behind failed, and this line is all anyone sees
      // of it
      else if (message.type === 'uncaught')
        log.error(`Uncaught error in a script:\n${message.stack}`)
      else if (live === this.#live) this.#onResult(message)
    })
    worker.on('error', (error: unknown) => {
      ready.reject(error)
      if (live === this.#live) this.#crashed(error)
    })
    worker.on('exit', (code: number) => {
      ready.reject(new Error(`the worker exited with code ${code}`))
      if (live === this.#live) this.#exited(code)
    })
    this.#live = live
    return live
  }

  /** ctx.recorded() or ctx.recordings() in the running script of `live`, which waits on its flag
   *  for the answer: what the job's reader finds, as JSON text (a big integer's RawJson as its
   *  digits, null as null), or the message of what the reader threw, which the worker throws in
   *  the script. Answered on the asking worker's own port, so the reply goes nowhere else */
  async #onLookup(live: Live, message: LookupMessage): Promise<void> {
    const job = this.#current
    // From a run that is over, which the worker does not ask for (its lookup() throws in the
    // script instead): should one come all the same, what it asked is nobody's to answer
    if (job === null || message.id !== job.id) return
    const { key, session } = message
    let reply: LookupReply
    try {
      // No query is the request's own, which the reader leaves to its caller
      const found =
        message.op === 'one'
          ? await job.reader.one({ query: message.query ?? job.request.query, key, session })
          : await job.reader.all({ key, session })
      reply = { ok: true, json: JSON.stringify(found) }
    } catch (error) {
      // A key that does not read, say: the reader's UserError
      reply = { ok: false, message: reasonOf(error) }
    }
    // The run timed out, or the runner closed, while the recordings were read: the worker that
    // asked is stopped or stopping, and nothing waits for the answer
    if (this.#current !== job) return
    live.port.postMessage(reply)
    // After the answer, so that it is on the port by the time the flag lets the worker look
    Atomics.store(live.flag, 0, 1)
    Atomics.notify(live.flag, 0)
  }

  /** The end of the running job's run */
  #onResult(message: ResultMessage): void {
    const job = this.#current
    if (job === null || message.id !== job.id) return
    clearTimeout(job.timer)
    // Not into a bucket a reset dropped while the script ran: that run's changes go with it
    if (this.#state.has(job.key)) this.#state.set(job.key, message.stateJson)
    const { outcome } = message
    let failed = outcome.kind === 'threw' ? outcome.stack : null
    if (outcome.kind === 'returned') {
      try {
        job.resolve(scriptResponse(outcome.value, job.rule))
      } catch (error) {
        // What the handler returned makes no answer: a recording whose headers the script set to
        // null, say. That is the script's failure as much as a throw in it is, and thrown here,
        // in the worker's message event, it would leave the job unanswered and end the process
        failed = error instanceof Error ? (error.stack ?? String(error)) : String(error)
      }
    }
    if (failed !== null) {
      // A mock server is a debugging tool: the stack goes back to the caller, who is the person
      // who just wrote the script
      log.error(`Script failed: ${job.key}\n${failed}`)
      job.resolve(textResponse(`The script failed:\n${failed}`, 500))
    }
    this.#finish()
  }

  /** The running job's timer went off before its result came. Nothing but terminate() stops a
   *  handler that loops, waits on a promise nothing settles or blocks in Atomics.wait, so the
   *  worker goes, and what the run did to ctx.state goes with it; the next run starts another */
  #timedOut(): void {
    const job = this.#current
    if (job === null) return
    job.resolve(textResponse(`The script timed out after ${this.timeoutMs / 1000} seconds`, 500))
    log.error(`Script timed out: ${job.key}`)
    this.#discardWorker()
    this.#finish()
  }

  /** The worker failed with an error of its own rather than a run's: in loading script-worker.ts,
   *  or out of memory. An error a script leaves uncaught does not come here: the worker logs it and
   *  goes on (UncaughtMessage). The running job, if there is one, is answered 500, and the next run
   *  starts another worker. The exit that follows is not heard: the worker is let go of here.
   *
   *  Logged with or without a job: a process.exit() in a timer a handler left behind ends the
   *  worker when no run is waiting, and this line is all anyone sees of it */
  #crashed(error: unknown): void {
    const why = reasonOf(error)
    log.error(`The script runner crashed: ${why}`)
    this.#discardWorker()
    const job = this.#current
    if (job === null) return
    clearTimeout(job.timer)
    job.resolve(textResponse(`The script runner crashed: ${why}`, 500))
    this.#finish()
  }

  /** The worker exited with no error before it: a script called process.exit() */
  #exited(code: number): void {
    this.#crashed(new Error(`the worker exited with code ${code}`))
  }

  /** Let go of the worker and stop it, without waiting for it to stop: its exit, when it comes,
   *  is no longer #live's to hear, and a run meanwhile starts another */
  #discardWorker(): void {
    const live = this.#live
    if (live === null) return
    this.#live = null
    live.port.close()
    live.worker.terminate().catch((error: unknown) => {
      log.error(`Could not stop the script worker: ${reasonOf(error)}`)
    })
  }

  /** The running job is answered: on to the next, or, with none, let the process exit around the
   *  idle worker. #pump references it again for the next run */
  #finish(): void {
    this.#current = null
    if (this.#queue.length > 0) void this.#pump()
    else this.#live?.worker.unref()
  }
}

/** What a handler's ctx shows of a request (script-context.ts, handlerContext), in the worker and on
 *  the main thread alike: Request's fields, the port already effective and the url already built,
 *  and copies of the query, the headers and the body, so that what a handler changes in them is not
 *  what the log keeps */
export function scriptRequest(request: Request): ScriptRequest {
  return {
    method: request.method,
    scheme: request.scheme,
    host: request.host,
    port: effectivePort(request),
    path: request.path,
    query: { ...request.query },
    headers: { ...request.headers },
    // A copy exactly as long as the body, with an ArrayBuffer of its own, which ScriptRunner then
    // moves to the worker rather than copying again. Not the Buffer itself: a small Buffer is a
    // slice of a pool (8 KiB, 64 KiB on Node 26), which a clone would copy whole, neighbours' bytes
    // and all, and a transfer would take from everyone else using it
    body: new Uint8Array(request.body),
    client: request.client,
    url: requestUrl(request),
  }
}

/** The response to a return value: an object or array becomes JSON, bytes go out as they are,
 *  anything else is text. A Recorded brings its own status, headers and body. ctx.reply's
 *  status overrides the rule's status_code, and its headers are written over the ones the body
 *  brings */
export function scriptResponse(value: ScriptReturn, rule: TunnelRequestConfig): Response {
  const status = value.status ?? rule.status_code
  const { body } = value
  switch (body.kind) {
    case 'none':
      return makeResponse({ status, headers: { ...(value.headers ?? {}) } })
    case 'json':
      // The text stringifySpaced wrote in the worker, so not through jsonResponse again;
      // the headers as jsonResponse makes them
      return makeResponse({
        status,
        headers: overrideHeaders({ 'content-type': 'application/json' }, value.headers),
        body: Buffer.from(body.text, 'utf8'),
      })
    case 'text':
      return textResponse(body.text, status, value.headers)
    case 'bytes':
      // With no content-type but one ctx.reply gave. The worker moved these bytes here, so the
      // Buffer is a view of them rather than another copy
      return makeResponse({
        status,
        headers: { ...(value.headers ?? {}) },
        body: Buffer.from(body.bytes.buffer, body.bytes.byteOffset, body.bytes.byteLength),
      })
    case 'recorded': {
      // The recording answers as it was recorded, unless the handler said otherwise: a status
      // it gave ctx.reply wins, and headers it named are written over the recorded ones. The
      // framing headers are left behind exactly as replay leaves them: they describe the bytes
      // the real server sent, which are not the bytes going out now
      const recorded = parseJson(body.json) as unknown as Recorded
      const kept = Object.fromEntries(
        Object.entries(recorded.headers).filter(
          ([name]) => !DROPPED_RESPONSE_HEADERS.has(name.toLowerCase()),
        ),
      )
      return makeResponse({
        status: value.status ?? recorded.status,
        headers: overrideHeaders(kept, value.headers),
        // Bytes the script put in the body came beside the JSON, moved here by the worker
        body: recordedBytes({
          body: body.bodyBytes ?? recorded.body,
          body_encoding: recorded.body_encoding,
        }),
      })
    }
  }
}
