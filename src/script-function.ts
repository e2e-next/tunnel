// Function rules: rules that a function held in memory answers, where a stored rule's script would.
// They are the library's: setRule() with a handler puts one here, and the core, once it has matched
// a `script` rule, asks FunctionRunner whether the rule is one of its own before it hands the
// request to the script worker.
//
// A handler runs here, on the main thread, which is the caller's: it is handed the ctx a script's
// handler(ctx) is, and what it returns is answered by the same rules, script-context.ts's and
// scriptResponse()'s, within the same limit and with the same 500s. What differs is only what the
// thread decides. ctx.recorded() and ctx.recordings() hand back promises, where the worker waits
// for the disk blocked. Calls run as they come, where scripts queue: nothing crosses a thread, so a
// rule's calls share its ctx.state, one live object, and none loses what another wrote. And a
// handler that loops synchronously cannot be stopped: it holds the very thread its timer would go
// off on.
import { getLogger } from './log.ts'
import { textResponse, type Request, type Response } from './messages.ts'
import type { TunnelRequestConfig } from './models.ts'
import { RecordingReader, type RecordingStore } from './recordings.ts'
import {
  handlerContext,
  isPlainObject,
  parseScriptJson,
  Recorded,
  type Reply,
  stackOf,
  toReturn,
  type RecordedOptions,
} from './script-context.ts'
import { SCRIPT_TIMEOUT_MS, scriptRequest, scriptResponse } from './script.ts'

const log = getLogger('script-function')

/** What a function handler is handed: a script's ctx (script-worker.ts), field for field and in its
 *  order, but that recorded() and recordings() return promises */
export interface FunctionContext {
  method: string
  path: string
  query: Record<string, string> // copies, as the body is: what a handler changes is not logged
  headers: Record<string, string>
  body: Buffer
  json: unknown // the body as JSON, an integer past 2^53 a BigInt; null when it is none
  state: unknown // the rule's one live object, until a reset
  scheme: string
  host: string
  port: number
  url: string
  client: string
  recorded(options?: RecordedOptions): Promise<Recorded | null>
  recordings(options?: Omit<RecordedOptions, 'query'>): Promise<Recorded[]>
  reply(body: unknown, status?: unknown, headers?: unknown): Reply
}

/** A function rule's handler(ctx). What it returns, or what a promise it returns resolves with, is
 *  answered as a script's return value is */
export type FunctionHandler = (ctx: FunctionContext) => unknown

/** A rule's ctx.state bucket: the object its calls are handed, until a call puts another in its
 *  place or a reset drops the bucket */
interface Bucket {
  state: object
}

/** One call of a handler, until it is answered: at once when the handler returns anything but a
 *  promise, else by that promise, by the call's timer or by close() */
interface Call {
  key: string // the rule's request_key, which names its ctx.state bucket
  ctx: FunctionContext
  bucket: Bucket // the rule's bucket when the call began
  seen: object // ctx.state as last looked at: what the call was handed, or what it put in its place
  resolve: (response: Response) => void
  timer: NodeJS.Timeout | undefined // while it waits for a promise
  timedOut: boolean
}

/** Holds the function rules and answers the requests they match, as ScriptRunner answers the
 *  script rules': the same ctx, return values, limit and 500s. The core owns one */
export class FunctionRunner {
  readonly timeoutMs: number
  readonly #store: RecordingStore
  /** The function rules by key, in the order they were first set */
  readonly #rules = new Map<string, TunnelRequestConfig>()
  /** Each rule's handler, by the rule object rather than its key: a request whose rule is replaced
   *  or deleted while it waits out its response_delay runs the handler it matched, as a script
   *  request runs the script it matched */
  readonly #handlers = new WeakMap<TunnelRequestConfig, FunctionHandler>()
  /** ctx.state, one live object per rule key, in a bucket per key. In memory only, as a script's
   *  is: it is what a test case resets between runs. Apart from the script buckets of the same
   *  keys, which are JSON text that crosses to the worker and back. A reset drops a bucket rather
   *  than emptying it: a call that began before the reset keeps what it ends with in a bucket
   *  nobody reads any more (#keepState) */
  readonly #state = new Map<string, Bucket>()
  /** The calls waiting for a promise, which close() answers */
  readonly #running = new Set<Call>()

  constructor(recordings: RecordingStore, options: { timeoutMs?: number } = {}) {
    this.#store = recordings
    this.timeoutMs = options.timeoutMs ?? SCRIPT_TIMEOUT_MS
  }

  /** How many function rules there are */
  get size(): number {
    return this.#rules.size
  }

  /** Each function rule by its key, the very object set() was given, in the order they were first
   *  set: what the core chooses among, with the stored rules */
  rules(): Record<string, TunnelRequestConfig> {
    return Object.fromEntries(this.#rules)
  }

  /** The function rule with this key, and its handler; null when there is none */
  get(key: string): { rule: TunnelRequestConfig; handler: FunctionHandler } | null {
    const rule = this.#rules.get(key)
    // set() put the one beside the other
    return rule === undefined ? null : { rule, handler: this.#handlers.get(rule)! }
  }

  /** Put this rule, answered by this handler, in place of the one with its key if there is one.
   *  Its ctx.state stays, as a script's stays when its rule changes: only a reset clears it */
  set(rule: TunnelRequestConfig, handler: FunctionHandler): void {
    this.#rules.set(rule.request_key, rule)
    this.#handlers.set(rule, handler)
  }

  /** Remove the function rule with this key; whether there was one. Its ctx.state stays */
  delete(key: string): boolean {
    return this.#rules.delete(key)
  }

  /** Remove every function rule */
  clear(): void {
    this.#rules.clear()
  }

  /** Whether this rule, the object, is one set() was given: the core asks before it runs a
   *  `script` rule here rather than in the worker */
  owns(rule: TunnelRequestConfig): boolean {
    return this.#handlers.has(rule)
  }

  /** Answer one request with the handler of this rule, which owns(rule) says is one of these.
   *  Never rejects: whatever goes wrong is a Response, in ScriptRunner's words — 500 text
   *  "The script failed:\n<stack>", 500 text "The script timed out after <seconds> seconds",
   *  500 text "The script runner was closed" */
  run(request: Request, rule: TunnelRequestConfig, currentSession: string): Promise<Response> {
    // Made before the call, as a script's bucket is, so that a reset names a rule that ran
    // whatever its handler did
    const key = rule.request_key
    let bucket = this.#state.get(key)
    if (bucket === undefined) {
      bucket = { state: {} }
      this.#state.set(key, bucket)
    }
    const reader = new RecordingReader(this.#store, request, rule, currentSession)
    // The ctx a script is handed, made by the same function, but for these two, which read on this
    // thread and hand back promises
    const ctx: FunctionContext = handlerContext(scriptRequest(request), bucket.state, {
      // Arrow functions, as the worker's are. Each Recorded is made afresh from JSON, as the
      // worker makes it, so that what one call changes in it no other sees, and a big integer in
      // it is a BigInt. No query asks for the request's own as it came, not for ctx.query as the
      // handler may have left it, as in the worker
      recorded: async (options = {}) => {
        const found = await reader.one({
          query: options.query ?? request.query,
          key: options.key ?? null,
          session: options.session ?? null,
        })
        if (found === null) return null
        return new Recorded(parseScriptJson(JSON.stringify(found)) as object)
      },
      recordings: async (options = {}) => {
        const found = await reader.all({
          key: options.key ?? null,
          session: options.session ?? null,
        })
        const each = parseScriptJson(JSON.stringify(found)) as object[]
        return each.map((fields) => new Recorded(fields))
      },
    })
    const answered = Promise.withResolvers<Response>()
    const call: Call = {
      key,
      ctx,
      bucket,
      seen: bucket.state,
      resolve: answered.resolve,
      timer: undefined,
      timedOut: false,
    }
    let value: unknown
    let thenable: boolean
    try {
      // owns(rule) said yes before the core called this
      value = this.#handlers.get(rule)!(ctx)
      // A promise, or anything else with a then() to wait for, as the worker tells one
      thenable = typeof (value as { then?: unknown } | null)?.then === 'function'
    } catch (error) {
      this.#failed(call, error)
      return answered.promise
    }
    // Anything else is the answer now, with no timer to stop
    if (!thenable) {
      this.#returned(call, value, rule)
      return answered.promise
    }
    // Not unref'd, as the worker's is not: on 22.18, node:test records a test that waits on
    // nothing but an unref'd timer as cancelled (core.ts, waitedItOut)
    call.timer = setTimeout(() => this.#timedOut(call), this.timeoutMs)
    this.#running.add(call)
    Promise.resolve(value).then(
      (returned: unknown) => {
        if (this.#running.has(call)) this.#returned(call, returned, rule)
        // Answered already, by its timer or by close(): what it comes to now goes nowhere, but what
        // it put in ctx.state's place counts, as it would have had it ended in time
        else this.#keepState(call)
      },
      (error: unknown) => {
        if (this.#running.has(call)) {
          this.#failed(call, error)
          return
        }
        this.#keepState(call)
        // The timer answered the request, and this line is all anyone sees of what came after
        if (call.timedOut) log.error(`Script failed after it timed out: ${key}\n${stackOf(error)}`)
      },
    )
    return answered.promise
  }

  /** ScriptRunner.resetState for these buckets: no key clears every one and returns their keys
   *  sorted; a key drops that one and returns [key] when there was one, else []. A rule whose
   *  bucket went is handed a new {} by its next call */
  resetState(requestKey?: string | null): string[] {
    if (requestKey === undefined || requestKey === null) {
      const cleared = [...this.#state.keys()].sort()
      this.#state.clear()
      return cleared
    }
    return this.#state.delete(requestKey) ? [requestKey] : []
  }

  /** Answer every call still waiting for its handler's promise 500 text "The script runner was
   *  closed", as ScriptRunner.close() answers its, and stop their timers, which would otherwise
   *  keep the process for the rest of their time. The promises go on; what they come to is
   *  nobody's to hear */
  close(): void {
    for (const call of [...this.#running]) {
      this.#settle(call, textResponse('The script runner was closed', 500))
    }
  }

  /** What the handler returned, or its promise resolved with, made into the answer. A value that
   *  makes none — a circular object, a recording whose headers it set to null — is the handler's
   *  failure as much as a throw in it is */
  #returned(call: Call, value: unknown, rule: TunnelRequestConfig): void {
    let response: Response
    try {
      response = scriptResponse(toReturn(value), rule)
    } catch (error) {
      this.#failed(call, error)
      return
    }
    this.#settle(call, response)
  }

  /** What the handler threw, or its promise rejected with: the stack goes back in a 500 and into
   *  the line a script's failure is logged with */
  #failed(call: Call, error: unknown): void {
    const stack = stackOf(error)
    log.error(`Script failed: ${call.key}\n${stack}`)
    this.#settle(call, textResponse(`The script failed:\n${stack}`, 500))
  }

  /** The call's timer went off before its promise settled. Nothing stops the handler, which goes
   *  on: what it does to ctx.state from here on counts, an object it puts in its place once its
   *  promise settles, where a script's run that times out takes its changes with it. A promise
   *  that never settles has its changes to the object counted, as they are made, and no other */
  #timedOut(call: Call): void {
    call.timedOut = true
    this.#settle(
      call,
      textResponse(`The script timed out after ${this.timeoutMs / 1000} seconds`, 500),
    )
    log.error(`Script timed out: ${call.key}`)
  }

  /** The call's one answer. Its timer stops, and what it put in ctx.state's place is kept */
  #settle(call: Call, response: Response): void {
    clearTimeout(call.timer)
    this.#running.delete(call)
    this.#keepState(call)
    call.resolve(response)
  }

  /** A plain object the handler put in ctx.state's place since this last looked becomes its
   *  rule's ctx.state: each call that ends makes its own so, and so of calls that overlap, the one
   *  that ends last has the last word. It goes into the bucket the call began with, which
   *  nobody reads once a reset has dropped it: nothing comes back from before a reset, as a
   *  script's run writes nothing back into a bucket a reset dropped. Anything else is not taken, as
   *  a script's is not: the next call's ctx.state has to be an object to put things on */
  #keepState(call: Call): void {
    const { state } = call.ctx
    if (state === call.seen || !isPlainObject(state)) return
    call.seen = state
    call.bucket.state = state
  }
}
