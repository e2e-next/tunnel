// The tunnel configuration manager: which directories tunnel works out of, and
// the settings it reads from and writes back to config.json.
//
// What resolving the directories reads from the process (the environment, the
// cwd, the platform, the home directory) comes in as a PathContext, each part
// defaulting to the real one, so that tests pass their own rather than change
// the process.
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { reasonOf } from './errors.ts'
import { isJsonObject, parseJson } from './json.ts'
import { getLogger } from './log.ts'
import {
  DEFAULT_MODES,
  DEFAULT_SESSION,
  makeTunnelConfig,
  makeTunnelRequestConfig,
  parseTunnelConfig,
  parseTunnelRequestConfig,
  type TunnelConfig,
  type TunnelRequestConfig,
} from './models.ts'

const log = getLogger('config')

export const APP_NAME = 'tunnel'
export const PROJECT_DIR_NAME = '.tunnel'

/** What resolving the directories reads from the process. Each one missing defaults to the real value. */
export interface PathContext {
  /** tunnel serve --config-dir: first of all when non-empty */
  configDir?: string
  env: Readonly<Record<string, string | undefined>> // process.env
  cwd: string // process.cwd()
  platform: NodeJS.Platform // process.platform
  home: string // os.homedir(); read only when needed
}

/**
 * The three kinds of files tunnel owns, and nothing else. Frozen.
 *
 * config is long lived and worth keeping (the mock rules and the CA identity),
 * state is throwaway runtime bookkeeping, data is recorded traffic. They are
 * three separate directories at the user level so that a wipe of the state
 * directory never takes the CA with it; inside a project's `.tunnel/` they all
 * collapse into that one directory, which is what makes it easy to delete.
 *
 * The directories are stored fields, under the names health reports them by;
 * the files in them are worked out by camelCase getters.
 */
export class Paths {
  readonly config_dir: string
  readonly state_dir: string
  readonly data_dir: string

  constructor(dirs: { config_dir: string; state_dir: string; data_dir: string }) {
    this.config_dir = dirs.config_dir
    this.state_dir = dirs.state_dir
    this.data_dir = dirs.data_dir
    Object.freeze(this)
  }

  /**
   * All three in one directory, made absolute and with symlinks resolved: an
   * explicit --config-dir, or .tunnel/.
   *
   * Made absolute here: these paths are reported by health, by `tunnel ls` and
   * in the startup log, and a relative --config-dir would be read in the CLI's
   * working directory rather than the server's.
   */
  static inOneDirectory(
    directory: string,
    context: Partial<Pick<PathContext, 'cwd' | 'home'>> = {},
  ): Paths {
    const absolute = resolve(context.cwd ?? process.cwd(), expandUser(directory, context))
    const resolved = realpathOfExisting(absolute)
    return new Paths({ config_dir: resolved, state_dir: resolved, data_dir: resolved })
  }

  get configFile(): string {
    return join(this.config_dir, 'config.json')
  }

  /** The CA certificate devices install; certs.ts creates it on first use */
  get caFile(): string {
    return join(this.config_dir, 'ca.pem')
  }

  get caKeyFile(): string {
    return join(this.config_dir, 'ca-key.pem')
  }

  /** The request log, one JSON exchange per line, appended to as they arrive */
  get exchangesFile(): string {
    return join(this.state_dir, 'requests.jsonl')
  }

  /** What `tunnel serve --background` left behind: its pid and its two ports */
  get pidFile(): string {
    return join(this.state_dir, 'tunnel.pid')
  }

  /** Where a server started in the background writes what it would have printed */
  get logFile(): string {
    return join(this.state_dir, 'tunnel.log')
  }

  /** mkdir -p for config, state and data, in that order */
  create(): void {
    for (const directory of [this.config_dir, this.state_dir, this.data_dir]) {
      mkdirSync(directory, { recursive: true })
    }
  }

  /** Shape reported by `GET /__admin__/health` and printed by `tunnel ls` */
  describe(): { config_dir: string; state_dir: string; data_dir: string } {
    return { config_dir: this.config_dir, state_dir: this.state_dir, data_dir: this.data_dir }
  }
}

/**
 * `~` expanded in the forms a shell leaves behind: `~` alone, or `~/` (or `~`
 * and the platform's separator) at the start, becomes the home directory, which
 * is read only then. `~user/` stays as it is; a shell has usually expanded it
 * already, when the variable was set.
 */
function expandUser(path: string, context: Partial<Pick<PathContext, 'home'>>): string {
  if (path === '~' || path.startsWith('~/') || path.startsWith(`~${sep}`)) {
    return (context.home ?? homedir()) + path.slice(1)
  }
  return path
}

/**
 * The absolute path with symlinks resolved in the part of it that exists, and
 * the rest put back on the end, for a path that does not exist yet.
 * realpathSync rather than realpathSync.native: the native one changes the
 * letter case to the one on disk (casedir becomes CaseDir on macOS), where this
 * keeps the case the caller gave.
 *
 * Two rare cases: a dangling symlink is left as the link, not followed to the
 * missing target; and a `..` after a symlink is taken literally (path.resolve
 * has already removed it), not applied after the link is resolved.
 */
function realpathOfExisting(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    // Any error, not only ENOENT: past a symlink loop (ELOOP) or a directory that may not be
    // searched (EACCES), the rest is kept as written. Whoever then makes the directory
    // (Paths.create) meets the same error and throws it
    const parent = dirname(path)
    if (parent === path) return path
    return join(realpathOfExisting(parent), basename(path))
  }
}

/** Whether path is a directory: follows symlinks, and any error counts as "not a directory" */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Walk up from start looking for a .tunnel/, the way git looks for a .git
 *
 * Upwards rather than in the current directory alone: started from a
 * subdirectory of the project, tunnel would otherwise quietly begin a
 * second configuration of its own.
 */
function findProjectDir(start: string): string | null {
  for (let directory = start; ; directory = dirname(directory)) {
    const candidate = join(directory, PROJECT_DIR_NAME)
    if (isDirectory(candidate)) return candidate
    if (dirname(directory) === directory) return null
  }
}

/** $<variable>/tunnel, or ~/<fallback>/tunnel when the variable is unset or empty. Not
 *  resolved: a relative one stays relative. join does fold a `..` away (here and in APPDATA);
 *  it is the same directory either way */
function xdgDir(
  env: PathContext['env'],
  variable: string,
  fallback: string,
  context: Partial<Pick<PathContext, 'home'>>,
): string {
  const base = env[variable] || join(context.home ?? homedir(), fallback)
  return join(expandUser(base, context), APP_NAME)
}

/**
 * User-level locations, split the way the platform splits them.
 *
 * Windows keeps roaming configuration in %APPDATA% and machine-local state in
 * %LOCALAPPDATA%. macOS and Linux both follow the XDG base directories, so
 * tunnel lands in ~/.config, ~/.local/state and ~/.local/share. macOS
 * deliberately skips ~/Library/Application Support: that is the convention for
 * GUI applications with a bundle identifier, while command line tools (git, gh
 * and friends) live in ~/.config there just as they do on Linux.
 */
function userPaths(
  env: PathContext['env'],
  platform: NodeJS.Platform,
  context: Partial<Pick<PathContext, 'home'>>,
): Paths {
  if (platform === 'win32') {
    const roaming = env.APPDATA
    const local = env.LOCALAPPDATA || roaming
    if (roaming && local) {
      return new Paths({
        config_dir: join(roaming, APP_NAME),
        state_dir: join(local, APP_NAME),
        data_dir: join(local, APP_NAME),
      })
    }
  }

  return new Paths({
    config_dir: xdgDir(env, 'XDG_CONFIG_HOME', '.config', context),
    state_dir: xdgDir(env, 'XDG_STATE_HOME', '.local/state', context),
    data_dir: xdgDir(env, 'XDG_DATA_HOME', '.local/share', context),
  })
}

/**
 * Explicitly given > the project's .tunnel/ > the user-level directories
 *
 * User level by default, so an install finds the same configuration wherever
 * it is started from. A project that wants a set of its own runs `tunnel
 * init` in its root — as with git, the global one answers until a project
 * marks itself.
 *
 * Explicitly given is context.configDir (`tunnel serve --config-dir`), then
 * TUNNEL_CONFIG_DIR; all four levels are in this one function. An empty
 * configDir or variable counts as not given, all the way down to the user
 * level.
 */
export function resolvePaths(context: Partial<PathContext> = {}): Paths {
  if (context.configDir) return Paths.inOneDirectory(context.configDir, context)

  const env = context.env ?? process.env
  const explicit = env.TUNNEL_CONFIG_DIR
  if (explicit) return Paths.inOneDirectory(explicit, context)

  const project = findProjectDir(context.cwd ?? process.cwd())
  if (project !== null) return Paths.inOneDirectory(project, context)

  return userPaths(env, context.platform ?? process.platform, context)
}

/**
 * A truth value for what JSON holds: null, false, 0, '' and an empty array or
 * object are false, the rest true. JS takes an empty array or object as true.
 * A RawJson is a number that is not zero, so it is true.
 */
function nonEmpty(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (isJsonObject(value)) return Object.keys(value).length > 0
  return Boolean(value)
}

/**
 * A value as the upgrade's log lines show it: a string as it is, anything else
 * as JSON. A RawJson comes out as its digits, where a template literal would
 * throw.
 */
function shown(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * Bring a config file written by an older tunnel up to today's shape. It
 * rewrites data in place and logs what it changed; anything not of the shape
 * it looks for is left as it is, for parseTunnelConfig to refuse.
 *
 * Two response modes are gone. `file` cannot be migrated to anything, since
 * the server reads no user files any more, so those entries are dropped with
 * a warning. `proxy` was only renamed `passthrough` when the reverse proxy
 * became a forward one, so those entries are carried over, and with them the
 * per-rule upstream address under its new name. A `default_mode` the server
 * no longer offers falls back rather than taking the whole config file down.
 *
 * The session the recording switch used to carry is now the global one that
 * replay reads as well, so it moves there; and a rule that stored the literal
 * `default` is set to follow that session instead, which is what a rule
 * written before this said without ever meaning to.
 */
export function upgradeOldConfig(data: Record<string, unknown>): void {
  // Missing and null get through: the model gives the one its default and refuses the other
  const offered: readonly unknown[] = DEFAULT_MODES
  const mode = data.default_mode
  if (mode !== undefined && mode !== null && !offered.includes(mode)) {
    log.warning(
      `Global default_mode "${shown(mode)}" is no longer offered; falling back to "passthrough"`,
    )
    delete data.default_mode
  }

  const recording = data.recording
  if (isJsonObject(recording) && Object.hasOwn(recording, 'session')) {
    const session = recording.session
    delete recording.session
    // A session already at the top stays
    if (!Object.hasOwn(data, 'session')) data.session = session
    log.info(
      `Session "${shown(session)}" was the recording switch's; it is the current ` +
        'session now, which replay reads as well',
    )
  }

  const configs = data.request_configs
  if (!isJsonObject(configs)) return

  const following: string[] = []
  for (const [key, entry] of Object.entries(configs)) {
    if (!isJsonObject(entry)) continue
    if (entry.mode === 'file') {
      log.warning(
        `Skipping ${key}: response mode "file" was removed. ` +
          'Serve the payload with `tunnel set -d @file` instead.',
      )
      delete configs[key]
      continue
    }
    if (entry.mode === 'proxy') entry.mode = 'passthrough'
    const target = entry.custom_proxy_target ?? null
    delete entry.custom_proxy_target
    if (nonEmpty(target) && !nonEmpty(entry.target)) entry.target = target
    if (entry.replay_session === DEFAULT_SESSION) {
      entry.replay_session = ''
      following.push(key)
    }
  }

  if (following.length > 0) {
    log.info(
      'These rules replayed the default session because that is ' +
        'what was stored in them; they follow the current session ' +
        `now, and \`--session ${DEFAULT_SESSION}\` pins one back: ${following.join(', ')}`,
    )
  }
}

/** The fields given, less those whose value is undefined. update* leaves such a field as it is,
 *  where the model would take undefined as not given and put the default back */
function withoutUndefined<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Partial<T>
}

/**
 * Reads config.json, hands out the settings, writes changes back. All of it synchronous: the
 * file is a few KB, and two changes in a row cannot reach the disk out of order.
 *
 * It must be given its paths: working out the directories belongs at the edge, in `tunnel
 * serve`, as resolvePaths({ configDir }).
 */
export class TunnelConfigManager {
  readonly paths: Paths
  #config: TunnelConfig

  /** Makes the three directories (anything wrong there is thrown), then loads config.json */
  constructor(paths: Paths) {
    this.paths = paths
    this.paths.create()
    this.#config = this.#load()
  }

  /**
   * Load the configuration file. A file that is not there gets the defaults, written out at
   * once. One that is there is upgraded and checked in memory only: the file itself changes when
   * something is next saved.
   *
   * Anything that goes wrong on the way, from reading the bytes to the model refusing a field,
   * is one warning and the defaults, with the file left as it is. A single field the model
   * refuses takes the whole file with it. The next change saved then writes the defaults over it.
   *
   * Decoding is strict, so that bytes that are not UTF-8 count as unreadable, rather than coming
   * back as U+FFFD and being written back like that. A BOM at the start is skipped. parseJson
   * keeps the integers past 2^53 in the mock bodies digit for digit.
   */
  #load(): TunnelConfig {
    let bytes: Buffer
    try {
      bytes = readFileSync(this.paths.configFile)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Nothing there yet: write the defaults out so the file exists
        const config = makeTunnelConfig()
        this.#save(config)
        return config
      }
      // There but not readable: a directory, say, or a file without read permission
      log.warning(`Could not read the config file: ${reasonOf(error)}`)
      return makeTunnelConfig()
    }

    try {
      const data = parseJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      if (!isJsonObject(data)) throw new Error('it does not hold a JSON object')
      upgradeOldConfig(data)
      return parseTunnelConfig(data)
    } catch (error) {
      log.warning(`Could not read the config file: ${reasonOf(error)}`)
      return makeTunnelConfig()
    }
  }

  /**
   * Save the configuration to its file: JSON indented by two spaces, with no newline at the end.
   * Written over in place, through a symlink if config.json is one, rather than replaced by a
   * rename, which would turn the link into a file. A write that fails is logged and nothing
   * more: the change holds in memory.
   */
  #save(config: TunnelConfig): void {
    try {
      writeFileSync(this.paths.configFile, JSON.stringify(config, null, 2))
    } catch (error) {
      log.error(`Could not write the config file: ${reasonOf(error)}`)
    }
  }

  /** The configuration as it stands: the object itself, to read. Changes go through update* */
  getConfig(): TunnelConfig {
    return this.#config
  }

  /**
   * Update the configuration with the fields given, and save it. A nested value (ssl_proxying,
   * recording) replaces the one there whole, and every rule is checked and built afresh along
   * with the rest. A field given as undefined is left as it is.
   *
   * Throws ValidationError for a value the model refuses, a null included, and then nothing has
   * changed, in memory or on disk.
   */
  updateConfig(fields: Partial<TunnelConfig>): TunnelConfig {
    const config = parseTunnelConfig({ ...this.#config, ...withoutUndefined(fields) })
    this.#config = config
    this.#save(config)
    return config
  }

  /** The rule configured for this key, or a default one when there is none. A rule that is there
   *  is handed out itself, to read, as getConfig() hands out the configuration */
  getRequestConfig(requestKey: string): TunnelRequestConfig {
    const configs = this.#config.request_configs
    const rule = Object.hasOwn(configs, requestKey) ? configs[requestKey] : undefined
    if (rule !== undefined) return rule
    // No rule for this key: the global default mode answers it. Made afresh, and not stored
    return makeTunnelRequestConfig({ request_key: requestKey, mode: this.#config.default_mode })
  }

  /**
   * Update one rule with the fields given, and save. The fields go on top of what
   * getRequestConfig hands out, so a rule created without a mode takes the default_mode of that
   * moment, and keeps it once stored. A nested value (json_response, merge_json, headers)
   * replaces the one there whole. A rule already there keeps its place among the others; a new
   * one goes last. A field given as undefined is left as it is.
   *
   * Throws ValidationError for a value the model refuses, a null included, and then nothing has
   * changed, in memory or on disk.
   */
  updateRequestConfig(
    requestKey: string,
    fields: Partial<Omit<TunnelRequestConfig, 'request_key'>>,
  ): TunnelRequestConfig {
    const rule = parseTunnelRequestConfig({
      ...this.getRequestConfig(requestKey),
      ...withoutUndefined(fields),
    })
    // A plain assignment is safe: the caller has normalised the key first (normaliseKey), so it
    // is METHOD:…, with a colon in it, and never __proto__
    this.#config.request_configs[requestKey] = rule
    this.#save(this.#config)
    return rule
  }

  /** Delete one rule, in place, and save; true when there was one to delete. When there was none,
   *  nothing is saved */
  deleteRequestConfig(requestKey: string): boolean {
    const configs = this.#config.request_configs
    if (!Object.hasOwn(configs, requestKey)) return false
    delete configs[requestKey]
    this.#save(this.#config)
    return true
  }

  /** Delete every rule, in place, and save; the request log is left alone */
  clearConfiguredRequests(): boolean {
    const configs = this.#config.request_configs
    for (const key of Object.keys(configs)) delete configs[key]
    this.#save(this.#config)
    return true
  }
}
