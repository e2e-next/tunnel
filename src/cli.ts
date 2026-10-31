#!/usr/bin/env node
// The tunnel command line: where a coding agent or a test script configures the mocks.
//
// Most subcommands go through the /__admin__ management API, so nothing has to be restarted:
// what you change is what the next request gets. The server is expected at
// http://127.0.0.1:8000, which --base or TUNNEL_BASE overrides; a background server on another
// port is found through its pid file.
//
// This module is the entry point and the command table, the one place the 44 help pages are
// written; the commands live in the cli-*.ts modules. main() takes its streams and its outside world as arguments and
// returns the exit code rather than exiting, so the tests run it in process.
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type Args,
  type CommandSpec,
  createParser,
  helpWidth,
  type Parsed,
  type Parser,
  UsageError,
} from './cli-args.ts'
import { cmdCaExport, cmdCaInfo, cmdCaInstall, cmdCaReset } from './cli-ca.ts'
import {
  type CliDeps,
  CliError,
  type CliIo,
  type CommandHandler,
  DEFAULT_ADMIN_PORT,
  defaultBase,
  defaultDeps,
  print,
  printError,
} from './cli-common.ts'
import {
  cmdApply,
  cmdExport,
  cmdLs,
  cmdMode,
  cmdPack,
  cmdReset,
  cmdRm,
  cmdSession,
  cmdSet,
  cmdSslAdd,
  cmdSslExcludeAdd,
  cmdSslExcludeRm,
  cmdSslLs,
  cmdSslRm,
  cmdSslSwitch,
} from './cli-rules.ts'
import { cmdServe, cmdStatus, cmdStop } from './cli-server.ts'
import {
  cmdCheck,
  cmdRecordingsExport,
  cmdRecordingsImport,
  cmdRecordingsLs,
  cmdRecordingsRm,
  cmdRecordingsShow,
  cmdRecordStart,
  cmdRecordStatus,
  cmdRecordStop,
  cmdRequests,
  cmdRequestsShow,
  cmdWait,
} from './cli-traffic.ts'
import { PROJECT_DIR_NAME } from './config.ts'
import { UserError } from './errors.ts'
import { buildTools, serveStdio } from './mcp.ts'
import { AGENTS_GUIDE, VERSION } from './package-info.ts'
import { DEFAULT_PROXY_HOST, DEFAULT_PROXY_PORT } from './proxy.ts'

/**
 * Runs one tunnel command and resolves with its exit code. What io and deps leave out is the
 * process's own: process.stdin, stdout and stderr, and defaultDeps(). It never calls
 * process.exit().
 */
export async function main(
  argv: readonly string[],
  io?: Partial<CliIo>,
  deps?: Partial<CliDeps>,
): Promise<number> {
  const given = complete(io, deps)
  let parsed: Parsed<CommandHandler>
  try {
    parsed = buildParser(given.deps, given.io).parse(argv)
  } catch (error) {
    // The usage of the level that failed and the parser's sentence, never JSON (README: a misspelt
    // flag is still the argument parser's own usage message)
    if (!(error instanceof UsageError)) throw error
    given.io.stderr.write(error.text())
    return 1
  }
  if (parsed.kind !== 'run') {
    given.io.stdout.write(parsed.text)
    return 0
  }
  try {
    return (await parsed.handler(parsed.args, given.io, given.deps)) ?? 0
  } catch (error) {
    // Anything else is a bug, and goes out the top as a stack trace
    if (!(error instanceof UserError)) throw error
    printError(given.io, error, parsed.args.json === true)
    return error instanceof CliError ? error.exitCode : 1
  }
}

/**
 * The whole command table. The default of --base, and the "(default …)" its help shows, is
 * defaultBase() as it stands now; the pages are laid out in the width helpWidth() finds. main()
 * builds one for each command.
 */
export function buildParser(deps?: Partial<CliDeps>, io?: Partial<CliIo>): Parser<CommandHandler> {
  const given = complete(io, deps)
  const width = helpWidth(given.deps.env, given.io.stdout)
  return createParser(commandTable(defaultBase(given.deps)), { width })
}

/** What main() and buildParser() were not handed, taken from the process: the one place the
 *  command reads process.stdin, stdout, stderr, env and cwd */
function complete(
  io: Partial<CliIo> = {},
  deps: Partial<CliDeps> = {},
): { io: CliIo; deps: CliDeps } {
  return {
    io: {
      stdin: io.stdin ?? process.stdin,
      stdout: io.stdout ?? process.stdout,
      stderr: io.stderr ?? process.stderr,
    },
    deps: { ...defaultDeps(), ...deps },
  }
}

/** set --script's help */
const SCRIPT_HELP = 'a JavaScript or TypeScript file defining handler(ctx), run per request'

/** The 44 pages. The order matters: a help page lists arguments in the order they are added */
function commandTable(base: string): CommandSpec<CommandHandler> {
  return {
    name: 'tunnel',
    description:
      'tunnel: a local proxy and mock server — configure what each endpoint answers, watch ' +
      'the traffic, replay what was recorded',
    options: [
      // On either side of the subcommand (`tunnel --json ls` and `tunnel ls --json`); only this
      // level has their defaults, or a subcommand would write its own back over the value read
      // here
      {
        flags: ['--base'],
        default: base,
        help: `where the admin API answers (default ${base})`,
        everyLevel: true,
      },
      {
        flags: ['--json'],
        action: 'store_true',
        help: 'print raw JSON, errors included, for piping into jq',
        everyLevel: true,
      },
      { flags: ['--version'], action: 'version', version: `tunnel ${VERSION}` },
    ],
    // What --base would have been had nobody given one: `tunnel mcp` looks the address up again
    // on every tool call unless the command line pinned it
    defaults: { _base_default: base },
    subcommands: { dest: 'command', required: true, commands: COMMANDS },
  }
}

const KEY_HELP = 'only this rule key, e.g. GET:api.example.com/api/feed'
const HOST_HELP = 'only this host; * is a wildcard'
const OUT_HELP = 'output file; prints to stdout when not given'

/** Every subcommand, in the order the help lists them */
const COMMANDS: readonly CommandSpec<CommandHandler>[] = [
  {
    name: 'serve',
    help: 'start the admin port (127.0.0.1) and the proxy port',
    options: [
      {
        flags: ['--admin-port', '--port'],
        dest: 'admin_port',
        type: 'int',
        default: DEFAULT_ADMIN_PORT,
        metavar: 'PORT',
        help: `panel and admin API, on 127.0.0.1 (default ${DEFAULT_ADMIN_PORT})`,
      },
      {
        flags: ['--proxy-port'],
        dest: 'proxy_port',
        type: 'int',
        default: DEFAULT_PROXY_PORT,
        metavar: 'PORT',
        help: `the port devices proxy through (default ${DEFAULT_PROXY_PORT})`,
      },
      {
        flags: ['--proxy-host'],
        dest: 'proxy_host',
        default: DEFAULT_PROXY_HOST,
        metavar: 'HOST',
        help: `address the proxy port binds (default ${DEFAULT_PROXY_HOST}, every interface)`,
      },
      {
        flags: ['--config-dir'],
        dest: 'config_dir',
        metavar: 'DIR',
        help:
          'put config, state and data in this one directory (default: the nearest .tunnel/, ' +
          'else the user directories)',
      },
      {
        flags: ['--background'],
        action: 'store_true',
        help:
          'start it in a process of its own and return once it answers; `tunnel status` and ' +
          '`tunnel stop` follow it',
      },
    ],
    // The file the background child runs is this one: dist/cli.js installed, src/cli.ts in a test
    handler: (args, io, deps) => cmdServe(args, io, deps, import.meta.filename),
  },
  {
    name: 'status',
    help: 'whether a background server is running, and where',
    handler: cmdStatus,
  },
  {
    name: 'stop',
    help: 'stop the server started with `serve --background`',
    handler: cmdStop,
  },
  {
    name: 'init',
    help: 'create .tunnel/ here so this project keeps its own config, state and recordings',
    handler: cmdInit,
  },
  {
    name: 'agents',
    help: 'print the guide for coding agents, for the version installed',
    handler: cmdAgents,
  },
  {
    name: 'mcp',
    help: 'speak MCP on stdin and stdout, so a coding agent drives tunnel with typed tools',
    handler: cmdMcp,
  },
  { name: 'ls', help: 'list the configured mocks', handler: cmdLs },
  {
    name: 'requests',
    help: 'what the client actually called, aggregated or one by one',
    options: [
      {
        flags: ['--each'],
        action: 'store_true',
        help: 'one row per request instead of the aggregate',
      },
      { flags: ['--key'], metavar: 'KEY', help: KEY_HELP },
      { flags: ['--host'], metavar: 'HOST', help: HOST_HELP },
      { flags: ['--since'], type: 'int', metavar: 'SEQ', help: 'only what arrived after this seq' },
      { flags: ['--last'], type: 'int', metavar: 'N', help: 'only the last N entries' },
      { flags: ['--unmatched'], action: 'store_true', help: 'only requests no rule answered' },
      {
        flags: ['--encrypted'],
        action: 'store_true',
        help: 'only tunnels that were not decrypted',
      },
      {
        flags: ['-q', '--keyword'],
        dest: 'q',
        metavar: 'TEXT',
        help: 'keyword: matches host, path, query, status and rule',
      },
      // No --raw here: these two views print no header or body values, and a flag spelled the
      // same on both would be swallowed by the subcommand's own
    ],
    handler: cmdRequests,
    subcommands: {
      dest: 'requests_command',
      required: false,
      commands: [
        {
          name: 'show',
          help: 'one request and its response in full',
          positionals: [
            { dest: 'seq', type: 'int', help: 'the seq from `tunnel requests --each`' },
          ],
          options: [
            {
              flags: ['--raw'],
              action: 'store_true',
              help: 'print header values instead of [REDACTED]',
            },
          ],
          handler: cmdRequestsShow,
        },
      ],
    },
  },
  {
    name: 'wait',
    help: 'block until the client has made this request (exit 3 on timeout)',
    positionals: [
      { dest: 'method', help: 'HTTP method, e.g. POST' },
      {
        dest: 'path',
        help:
          'a path (/api/pay) or a host and path (api.example.com/api/pay); * is a wildcard in ' +
          'both',
      },
    ],
    options: [
      {
        flags: ['--count'],
        type: 'int',
        default: 1,
        metavar: 'N',
        help: 'how many of them to wait for (default 1)',
      },
      {
        flags: ['--timeout'],
        type: 'float',
        default: 10,
        metavar: 'SECONDS',
        help: 'give up after this long and exit 3 (default 10)',
      },
      {
        flags: ['--since'],
        type: 'int',
        metavar: 'SEQ',
        help:
          'only count what arrived after this seq; without it the whole log counts, including ' +
          'calls made before the wait',
      },
      {
        flags: ['-q', '--query'],
        action: 'append',
        metavar: 'K=V',
        help: 'only count requests whose query carries this value, repeatable',
      },
    ],
    handler: cmdWait,
  },
  {
    name: 'set',
    help: 'configure one endpoint; only the fields you pass change',
    positionals: [
      { dest: 'method', help: 'HTTP method, e.g. GET' },
      {
        dest: 'path',
        help:
          'a path (/api/feed) or a host and path (api.example.com/api/feed); * is a wildcard in ' +
          'both',
      },
    ],
    options: [
      {
        flags: ['-d', '--data'],
        dest: 'json_body',
        metavar: 'JSON',
        help: 'the JSON to answer with: literal, or @file',
      },
      { flags: ['--script'], metavar: 'FILE', help: SCRIPT_HELP },
      {
        flags: ['--target'],
        metavar: 'URL',
        help: "pass through to this base URL or full URL instead of the request's own origin",
      },
      {
        flags: ['--replay'],
        action: 'store_true',
        help: 'answer from the recordings instead of the real server',
      },
      {
        flags: ['--strategy'],
        choices: ['match', 'sequence', 'last'],
        help:
          'which recording replay picks: the one whose query matches (default), the next one in ' +
          'order, or the newest',
      },
      {
        flags: ['--session'],
        metavar: 'NAME',
        help:
          'pin this endpoint to one recorded session; left out it follows the current session, ' +
          "and --session '' unpins it",
      },
      {
        flags: ['--merge'],
        metavar: 'JSON',
        help:
          'deep merge this object into the JSON that comes back, in passthrough and replay; ' +
          'literal JSON or @file',
      },
      {
        flags: ['-H', '--header'],
        action: 'append',
        metavar: "'Name: value'",
        help:
          "response header, repeatable; these replace the rule's headers rather than adding to " +
          'them',
      },
      {
        flags: ['--content-type'],
        dest: 'content_type',
        metavar: 'TYPE',
        help: 'override the content-type of the response',
      },
      {
        flags: ['--fault'],
        choices: ['none', 'hang', 'garbage', 'close'],
        help:
          'answer with a fault instead: hang until fault_seconds then 504, garbage that does not ' +
          'parse as the JSON it claims, or close the connection with no answer at all',
      },
      {
        flags: ['--fault-seconds'],
        dest: 'fault_seconds',
        type: 'float',
        metavar: 'SECONDS',
        help:
          'how long --fault hang holds the request before it answers 504 (default 3600, longer ' +
          "than any client's timeout)",
      },
      {
        flags: ['--mode'],
        choices: ['json', 'passthrough', 'script', 'replay'],
        help: 'set the mode explicitly',
      },
      { flags: ['--status'], type: 'int', help: 'the status code to answer with' },
      {
        flags: ['--delay'],
        type: 'float',
        metavar: 'SECONDS',
        help: 'hold the answer back this long',
      },
      { flags: ['--desc'], help: 'a note, shown by `tunnel ls`' },
      { flags: ['--enable'], dest: 'enabled', action: 'store_true', default: null },
      { flags: ['--disable'], dest: 'enabled', action: 'store_false', default: null },
    ],
    handler: cmdSet,
  },
  {
    name: 'rm',
    help: "delete one endpoint's rule",
    positionals: [{ dest: 'method' }, { dest: 'path' }],
    handler: cmdRm,
  },
  {
    name: 'apply',
    help: 'apply a scenario file: a group of mocks, all or nothing',
    positionals: [{ dest: 'file', help: 'the scenario JSON file' }],
    options: [
      {
        flags: ['--replace'],
        action: 'store_true',
        help: 'clear the rules that are configured now first',
      },
    ],
    handler: cmdApply,
  },
  {
    name: 'export',
    help: 'export the configured mocks as a scenario file',
    options: [
      { flags: ['-o', '--out'], help: OUT_HELP },
      {
        flags: ['--with-config'],
        dest: 'with_config',
        action: 'store_true',
        help: 'export the global settings as well',
      },
    ],
    handler: cmdExport,
  },
  {
    name: 'pack',
    help: "inline a scenario's script_file and json_file, for a test bundle to apply on its own",
    positionals: [{ dest: 'file', help: 'the scenario JSON file to read' }],
    options: [{ flags: ['-o', '--out'], help: OUT_HELP }],
    handler: cmdPack,
  },
  {
    name: 'reset',
    help: 'clear what one test case leaves for the next',
    positionals: [
      { dest: 'method', nargs: '?', help: "only this endpoint's state" },
      { dest: 'path', nargs: '?' },
    ],
    options: [
      {
        flags: ['--state'],
        action: 'store_true',
        help: 'clear script ctx.state and the replay counters (the default)',
      },
      { flags: ['--requests'], action: 'store_true', help: 'clear the request log' },
    ],
    handler: cmdReset,
  },
  {
    name: 'mode',
    help: 'how endpoints with no rule of their own are answered',
    positionals: [
      {
        dest: 'mode',
        nargs: '?',
        choices: ['passthrough', 'replay'],
        help: 'leave it out to print the mode as it stands',
      },
    ],
    options: [
      {
        flags: ['--session'],
        metavar: 'NAME',
        help:
          'switch the current session in the same call, so that `mode replay --session acct_a` ' +
          'is one command',
      },
    ],
    handler: cmdMode,
  },
  {
    name: 'session',
    help: 'the session this run records into and replays from',
    positionals: [
      {
        dest: 'name',
        nargs: '?',
        metavar: 'NAME',
        help: 'switch to this session; leave it out to print the one in hand and what else is on disk',
      },
    ],
    handler: cmdSession,
  },
  {
    name: 'record',
    help: 'record the calls that pass through to the real server',
    subcommands: {
      dest: 'record_command',
      required: true,
      commands: [
        {
          name: 'start',
          help: 'keep every passthrough call from here on',
          options: [
            {
              flags: ['--session'],
              metavar: 'NAME',
              help:
                'file the calls under this session, switching the run onto it; without it they ' +
                'go into the session in hand',
            },
          ],
          handler: cmdRecordStart,
        },
        {
          name: 'stop',
          help: 'stop recording; what is on disk stays',
          handler: cmdRecordStop,
        },
        {
          name: 'status',
          help: 'whether recording is on, and how much is recorded',
          handler: cmdRecordStatus,
        },
      ],
    },
  },
  {
    name: 'recordings',
    help: 'the recorded calls: list, export, import and delete them',
    subcommands: {
      dest: 'recordings_command',
      required: true,
      commands: [
        {
          name: 'ls',
          help: 'one row per recorded call',
          options: [
            { flags: ['--session'], metavar: 'NAME', help: 'only this session (default: all)' },
            { flags: ['--key'], metavar: 'KEY', help: KEY_HELP },
            { flags: ['--host'], metavar: 'HOST', help: HOST_HELP },
          ],
          handler: cmdRecordingsLs,
        },
        {
          name: 'show',
          help: 'one recorded call in full',
          positionals: [{ dest: 'seq', type: 'int', help: 'the seq from `tunnel recordings ls`' }],
          options: [
            {
              flags: ['--session'],
              metavar: 'NAME',
              help: 'which session (default: the one being recorded)',
            },
            {
              flags: ['--raw'],
              action: 'store_true',
              help: 'print header values instead of [REDACTED]',
            },
          ],
          handler: cmdRecordingsShow,
        },
        {
          name: 'export',
          help: 'write the recordings out as a directory to commit',
          options: [
            {
              flags: ['-o', '--out'],
              required: true,
              metavar: 'DIR',
              help: 'where to write the tree; it is the one `import` reads',
            },
            { flags: ['--session'], metavar: 'NAME', help: 'only this session (default: all)' },
            {
              flags: ['--raw'],
              action: 'store_true',
              help: 'keep header values instead of [REDACTED]',
            },
          ],
          handler: cmdRecordingsExport,
        },
        {
          name: 'import',
          help: 'read a directory of recordings back into the server',
          positionals: [
            { dest: 'dir', metavar: 'DIR', help: 'a directory `tunnel recordings export` wrote' },
          ],
          options: [
            {
              flags: ['--replace'],
              action: 'store_true',
              help: 'empty each session before importing into it',
            },
          ],
          handler: cmdRecordingsImport,
        },
        {
          name: 'rm',
          help: 'delete recordings',
          options: [
            {
              flags: ['--session'],
              metavar: 'NAME',
              help: 'only this session (default: every session)',
            },
          ],
          handler: cmdRecordingsRm,
        },
      ],
    },
  },
  {
    name: 'ssl',
    help: 'which hosts tunnel decrypts (Charles calls these SSL Proxying Locations)',
    subcommands: {
      dest: 'ssl_command',
      required: true,
      commands: [
        { name: 'ls', help: 'show both lists and the switch', handler: cmdSslLs },
        {
          name: 'add',
          help: 'decrypt these hosts',
          positionals: [
            {
              dest: 'patterns',
              nargs: '+',
              metavar: 'PATTERN',
              help: 'host[:port]; * is a wildcard and no port means any port',
            },
          ],
          handler: cmdSslAdd,
        },
        {
          name: 'rm',
          help: 'stop decrypting these hosts',
          positionals: [{ dest: 'patterns', nargs: '+', metavar: 'PATTERN' }],
          handler: cmdSslRm,
        },
        {
          name: 'on',
          help: 'decrypt the included hosts again',
          defaults: { enabled: true },
          handler: cmdSslSwitch,
        },
        {
          name: 'off',
          help: 'tunnel every HTTPS connection through undecrypted',
          defaults: { enabled: false },
          handler: cmdSslSwitch,
        },
        {
          name: 'exclude',
          help: 'hosts never to decrypt, whatever the include list says',
          subcommands: {
            dest: 'exclude_command',
            required: true,
            commands: [
              {
                name: 'add',
                help: 'never decrypt these hosts',
                positionals: [{ dest: 'patterns', nargs: '+', metavar: 'PATTERN' }],
                handler: cmdSslExcludeAdd,
              },
              {
                name: 'rm',
                help: 'drop these from the exclude list',
                positionals: [{ dest: 'patterns', nargs: '+', metavar: 'PATTERN' }],
                handler: cmdSslExcludeRm,
              },
            ],
          },
        },
      ],
    },
  },
  {
    name: 'check',
    help: 'send one request through the proxy port and print the answer',
    positionals: [
      { dest: 'method', help: 'HTTP method, e.g. GET' },
      { dest: 'url', help: 'the full URL, e.g. https://api.example.com/api/feed' },
    ],
    options: [
      {
        flags: ['-q', '--query'],
        action: 'append',
        metavar: 'K=V',
        help: 'query parameter, repeatable',
      },
      {
        flags: ['-d', '--data'],
        metavar: 'BODY',
        help: 'request body: literal JSON, @file, or plain text',
      },
    ],
    handler: cmdCheck,
  },
  {
    name: 'ca',
    help: 'the CA certificate devices install so tunnel can decrypt HTTPS',
    subcommands: {
      dest: 'ca_command',
      required: true,
      commands: [
        {
          name: 'export',
          help: 'write the CA certificate to a file',
          options: [{ flags: ['-o', '--out'], help: OUT_HELP }],
          handler: cmdCaExport,
        },
        {
          name: 'info',
          help: 'fingerprint, validity and where the CA lives',
          handler: cmdCaInfo,
        },
        {
          name: 'reset',
          help: 'generate a new CA; every device has to install it again',
          handler: cmdCaReset,
        },
        {
          name: 'install',
          help: "install the CA with the platform's own tool",
          exclusive: [
            {
              required: true,
              options: [
                {
                  flags: ['--ios-simulator'],
                  dest: 'target',
                  action: 'store_const',
                  const: 'ios-simulator',
                  help: 'xcrun simctl keychain booted add-root-cert',
                },
                {
                  flags: ['--android'],
                  dest: 'target',
                  action: 'store_const',
                  const: 'android',
                  help: "adb push, then install it from the device's settings",
                },
                {
                  flags: ['--macos'],
                  dest: 'target',
                  action: 'store_const',
                  const: 'macos',
                  help: 'security add-trusted-cert; asks for an administrator password',
                },
              ],
            },
          ],
          handler: cmdCaInstall,
        },
      ],
    },
  },
]

/** What init writes into .tunnel/ every time: the directory ignores itself in git, so captured
 *  traffic and the CA private key cannot be committed by accident */
const PROJECT_GITIGNORE = '# Created by tunnel. Everything here is local state.\n*\n'

/** tunnel init: creates .tunnel/ here so this project keeps its own config, state and recordings */
function cmdInit(args: Args, io: CliIo, deps: CliDeps): void {
  const directory = join(deps.cwd, PROJECT_DIR_NAME)
  // Whether it is a directory: stat follows a symlink, and whatever it fails with is a no
  let existed: boolean
  try {
    existed = statSync(directory).isDirectory()
  } catch {
    existed = false
  }
  mkdirSync(directory, { recursive: true })
  // Rewritten every time: that is what makes init idempotent on an existing directory
  writeFileSync(join(directory, '.gitignore'), PROJECT_GITIGNORE)

  const action = existed ? 'Updated' : 'Created'
  print(io, { success: true, directory, created: !existed }, args.json === true, [
    `${action} ${directory}`,
    'tunnel started from here keeps config, state and recordings in it; ' +
      'the directory ignores itself in git.',
  ])
}

/**
 * tunnel agents: prints the guide written for coding agents, the copy this version ships, rather
 * than whatever is on the default branch today. Printed as it is, with no wrapper and no newline
 * added: it is meant to be redirected into a file another tool reads. What goes into another
 * project is one line telling its agent to run this, not a copy of what it prints, which would
 * sit in every prompt and freeze at the version it was pasted from.
 */
function cmdAgents(_args: Args, io: CliIo): number {
  let guide: string
  try {
    guide = readFileSync(AGENTS_GUIDE, 'utf8')
  } catch (error) {
    // Nothing there, or no file: only a broken install
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') {
      throw new CliError(`this install is missing ${AGENTS_GUIDE}; reinstall tunnel-use`)
    }
    throw error
  }
  io.stdout.write(guide)
  return 0
}

/**
 * tunnel mcp: speaks MCP on stdin and stdout, so an agent drives tunnel with typed tools, where
 * `tunnel agents` hands it what tunnel knows. It connects to a server and never starts one. From
 * here on stdout is the JSON-RPC channel, which nothing else writes to.
 */
function cmdMcp(args: Args, io: CliIo, deps: CliDeps): Promise<number> {
  // Whether --base was on the command line: args.base always has a value, defaultBase() as the
  // parser found it when none was given, so comparing it with that default is the way left to
  // tell. An explicit --base that happens to equal it reads as not pinned, which costs nothing:
  // looking again on each tool call finds that same server, or one started since
  const pinned = args.base !== args._base_default
  const resolveBase = pinned ? () => String(args.base) : () => defaultBase(deps)
  const mcp = deps.mcp ?? { buildTools, serveStdio } // a test's own pair, else this module's
  return mcp.serveStdio(mcp.buildTools(resolveBase, deps), io.stdin, io.stdout)
}

// Run as the tunnel command, rather than imported: a test imports main() and calls it. argv[1]
// through realpath, since import.meta.filename has its symlinks resolved and the path the
// command was started by may not
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === import.meta.filename) {
  // A reader that leaves early, as in `tunnel requests | head -1`, makes the writes after it fail
  // with EPIPE, which Node would turn into a stack trace and exit 1: the command finishes quietly
  // instead, what it writes from then on going nowhere. Other errors are thrown as before
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error
  })
  process.exitCode = await main(process.argv.slice(2))
}
