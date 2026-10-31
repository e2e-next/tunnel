// The script runner's worker: where a script rule's handler(ctx) runs, one request at a time, for
// ScriptRunner in script.ts. It is a worker entry and nothing else: script.ts starts it with
// new Worker(), and importing it on the main thread throws.
//
// What crosses between the threads is plain data, the types script.ts declares: the request with
// its body as bytes of its own, and ctx.state as JSON text, in which an integer past 2^53 is its
// digits. Here such an integer is a BigInt, and JSON.stringify writes a BigInt as its digits once
// BigInt.prototype.toJSON says so. That patch is the one change this module makes to its realm,
// where scripts run and nothing of tunnel's would be surprised by it.
//
// The recordings stay on the main thread, which reads them from disk. ctx.recorded() and
// ctx.recordings() ask it on a port of their own and wait for the answer, blocked, so that a
// script calls them without await. A recording comes as JSON text too and becomes a Recorded
// here, which is how a handler that returns one is told from one that returns any other object.
import { createRequire } from 'node:module'
import {
  isMainThread,
  parentPort,
  receiveMessageOnPort,
  workerData,
  type MessagePort,
} from 'node:worker_threads'
import { reasonOf } from './errors.ts'
import { prepareScript, type CompiledScript } from './script-compile.ts'
import {
  handlerContext,
  parseScriptJson,
  RAW_JSON,
  Recorded,
  stackOf,
  toReturn,
  type RecordedOptions,
} from './script-context.ts'
import type {
  LookupMessage,
  LookupReply,
  ReadyMessage,
  ResultMessage,
  RunMessage,
  UncaughtMessage,
} from './script.ts'

if (isMainThread || parentPort === null) {
  throw new Error("script-worker.ts is the script runner's worker entry; import script.ts instead")
}
/** The main thread's end: runs come in on it, results go back on it */
const parent = parentPort
/** The lookup channel's end, and the flag this thread waits on while the main thread answers on it
 *  (lookup()) */
const { lookupPort, flag } = workerData as { lookupPort: MessagePort; flag: Int32Array }

// JSON.stringify refuses a BigInt; with this it writes one as its digits, in what a handler
// returns, in ctx.state and in whatever a script stringifies itself
Object.defineProperty(BigInt.prototype, 'toJSON', {
  value(this: bigint) {
    return RAW_JSON.rawJSON(this.toString())
  },
  writable: true,
  configurable: true,
})

/** The require a script is given: Node's built-in modules are what it promises (node:crypto and
 *  the like); anything else is looked for where tunnel is installed */
const require = createRequire(import.meta.url)

/** Each rule's compiled script with the source it was compiled from, by rule key. By key rather
 *  than by source, because the key is in the filename a script is compiled under, which its
 *  stacks name: two rules with one script are two entries. A rule whose script changed compiles
 *  again, and a script that does not compile is not kept, so each request of its rule reports it
 *  again. Rules are few; past 128 keys the map starts over all the same */
const compiled = new Map<string, { source: string; script: CompiledScript }>()

/** The rule's script compiled, or the one compiled before from the same source. Throws
 *  ScriptSyntaxError */
function compile(key: string, source: string): CompiledScript {
  const cached = compiled.get(key)
  if (cached?.source === source) return cached.script
  const script = prepareScript(source, `script:${key}`)
  if (compiled.size >= 128 && !compiled.has(key)) compiled.clear()
  compiled.set(key, { source, script })
  return script
}

/** The id of the run in progress, from the start of onRun until just before its result is posted;
 *  null between runs */
let running: number | null = null

/** What a lookup for any run but the one in progress throws in the script */
const NOT_RUNNING =
  'ctx.recorded() and ctx.recordings() work only while their own request is being answered'

/** Ask the main thread, which holds the recordings, and wait for its answer: the JSON it sent,
 *  read, or the message of what the lookup threw, thrown here, in the script. The main thread
 *  answers on the port first and raises the flag after, and this looks at the port before it
 *  waits, so an answer quicker than the wait is not waited for. A wait that is never answered is
 *  the run's timer's to end, as any other run that never returns is */
function lookup(message: LookupMessage): unknown {
  // A ctx used after its request was answered: by a timer or a promise its handler left behind,
  // or kept on globalThis by a run before this one. The main thread reads with the reader of the
  // request it is answering and answers no other, so the wait would never end, and the runs
  // behind it would wait too. Thrown before anything is posted, where the script called it
  if (message.id !== running) throw new Error(NOT_RUNNING)
  Atomics.store(flag, 0, 0)
  lookupPort.postMessage(message)
  for (;;) {
    const got = receiveMessageOnPort(lookupPort)
    if (got !== undefined) {
      const reply = got.message as LookupReply
      // A key that does not read, say: the script's own error, which it may catch
      if (!reply.ok) throw new Error(reply.message)
      return parseScriptJson(reply.json)
    }
    // 'ok' when notified, 'not-equal' when the answer beat us here
    Atomics.wait(flag, 0, 0)
    Atomics.store(flag, 0, 0)
  }
}

/** One run: the script from the top, its handler on this request's ctx, then what the handler
 *  returned or threw, and ctx.state as the run left it, back to the main thread */
async function onRun(message: RunMessage): Promise<void> {
  const { id, key, source, request } = message
  running = id
  // What a script's handler(ctx) is handed, the ctx a function handler is handed too, but for
  // ctx.recorded() and ctx.recordings(), which wait here for the main thread's answer
  const ctx = handlerContext(request, parseScriptJson(message.stateJson), {
    // Arrow functions, which a script may take off ctx (const { recorded } = ctx) and still call.
    //
    // The recording replay would answer this call with, or null. The sample is chosen exactly as
    // the `match` strategy chooses it — the newest recording whose query is the one asked for,
    // else the newest of that endpoint — so a script can take the real answer and edit it.
    // `query` asks for a different one, `key` for a different endpoint and `session` for a
    // different batch
    recorded: (options: RecordedOptions = {}): Recorded | null => {
      const found = lookup({
        id,
        op: 'one',
        query: options.query ?? null,
        key: options.key ?? null,
        session: options.session ?? null,
      })
      return found === null ? null : new Recorded(found as object)
    },
    // Every recording of this endpoint, oldest first
    recordings: (options: Omit<RecordedOptions, 'query'> = {}): Recorded[] => {
      const found = lookup({
        id,
        op: 'all',
        query: null,
        key: options.key ?? null,
        session: options.session ?? null,
      })
      return (found as object[]).map((fields) => new Recorded(fields))
    },
  })
  let outcome: ResultMessage['outcome']
  try {
    // Every run runs the whole script from the top
    const handler = compile(key, source)(require)
    if (typeof handler !== 'function') throw new Error('the script must define handler(ctx)')
    let result: unknown = handler(ctx)
    // An async handler's promise, or anything else with a then() to wait for
    if (typeof (result as { then?: unknown } | null)?.then === 'function') result = await result
    outcome = { kind: 'returned', value: toReturn(result) }
  } catch (error) {
    outcome = { kind: 'threw', stack: stackOf(error, source) }
  }
  // ctx.state goes back as the run left it, thrown or not, or as another object a script put in its
  // place. Anything whose JSON is not an object (null, a number, an array, a Date) is not taken:
  // the next run's ctx.state has to be an object to put things on, so the state stays as it came
  let stateJson = message.stateJson
  try {
    const text: string | undefined = JSON.stringify(ctx.state)
    if (text?.startsWith('{')) stateJson = text
  } catch (error) {
    outcome = {
      kind: 'threw',
      stack: `TypeError: ctx.state could not be saved: ${reasonOf(error)}`,
    }
  }
  // Returned bytes, and bytes a returned recording holds, are toBody's copy, the worker's own, so
  // they move rather than being copied
  const body = outcome.kind === 'returned' ? outcome.value.body : null
  const bytes =
    body?.kind === 'bytes' ? body.bytes : body?.kind === 'recorded' ? body.bodyBytes : null
  const moved = bytes === null ? [] : [bytes.buffer as ArrayBuffer]
  // Over from here: a lookup this run's ctx makes now throws (lookup())
  running = null
  parent.postMessage({ type: 'result', id, stateJson, outcome } satisfies ResultMessage, moved)
}

/** Hand an error that no script caught to the main thread, which logs it */
function reportUncaught(error: unknown): void {
  parent.postMessage({ type: 'uncaught', stack: stackOf(error) } satisfies UncaughtMessage)
}

// An error a script throws, or rejects a promise with, where nothing catches it: in a timer, a
// listener or a promise its handler left behind, during its run or after. Node's default would end
// this thread, and the main thread would answer the request it was running with the crash, which
// need not be the one whose script left the error behind: most often it is the next one, posted the
// moment the culprit's own answer came back. Instead this thread goes on, and the main thread logs
// it (UncaughtMessage) and answers no request with it
process.on('uncaughtException', reportUncaught)
process.on('unhandledRejection', reportUncaught)

parent.on('message', (message: RunMessage) => {
  onRun(message).catch((error: unknown) => {
    // A failure of onRun's own, such as a returned value that will not clone (a Proxy among
    // ctx.reply's headers): the run's request is answered with it as with anything the script
    // threw, rather than left to its timer while the handlers above log it
    running = null
    parent.postMessage({
      type: 'result',
      id: message.id,
      stateJson: message.stateJson,
      outcome: { kind: 'threw', stack: stackOf(error, message.source) },
    } satisfies ResultMessage)
  })
})
// Last: the main thread posts the first run when this arrives, so that loading this module is not
// charged to that run's timeout
parent.postMessage({ type: 'ready' } satisfies ReadyMessage)
