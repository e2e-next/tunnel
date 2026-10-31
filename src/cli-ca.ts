// The CA commands (ca export, info, reset and install): the certificate a device has to install
// so tunnel can decrypt its HTTPS, read from the running server when there is one and from the
// config directory when there is not, so that setting a device up does not depend on the order
// things are done in, and handed to the platform's own tool. cli.ts's command table names each
// handler, which takes (args, io, deps); asking the server, or else the files, is done by
// cli-common.ts's caCall, caPem and localCa, which check uses as well.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CaInfo } from './certs.ts'
import type { Args } from './cli-args.ts'
import {
  api,
  caCall,
  caPem,
  type CliDeps,
  CliError,
  type CliIo,
  localCa,
  print,
  stripSpace,
  userPath,
} from './cli-common.ts'

/** The name the certificate is handed over under, to a tool or to a phone */
export const CA_FILE_NAME = 'tunnel-ca.pem'
/** Where `ca install --android` puts it on the device, for the settings to install it from */
export const ANDROID_REMOTE_PATH = '/sdcard/Download/tunnel-ca.pem'

/** What `ca install` was told to install into: its one required flag */
export type InstallTarget = 'ios-simulator' | 'android' | 'macos'

/** What `ca install` prints once the tool has done its part: what is left for a person to do */
export const INSTALL_NOTES: Readonly<Record<InstallTarget, readonly string[]>> = {
  'ios-simulator': ['Installed into the booted simulator; there is nothing to confirm on it.'],
  android: [
    `Pushed the certificate to ${ANDROID_REMOTE_PATH}.`,
    'On the device: Settings > Security > Encryption & credentials > ' +
      'Install a certificate > CA certificate, then pick tunnel-ca.pem.',
    'Android 7 and later only trust user CAs in apps that opt in: the test build ' +
      'needs <certificates src="user"/> in its network_security_config.',
  ],
  macos: ['Added to the system keychain as a trusted root.'],
}

/** What the running server says of its CA, else the CA in the config directory, made there when
 *  there is none yet */
function caInfo(deps: CliDeps, base: string): Promise<CaInfo> {
  return caCall(
    deps,
    'GET',
    api(base, '/ca'),
    (response) => response.json() as Promise<CaInfo>,
    () => localCa(deps).info(),
  )
}

/** A new CA in the config directory, for when no server answers. It is not read first, so this
 *  works when the old files are damaged */
function resetLocalCa(deps: CliDeps): CaInfo {
  const ca = localCa(deps)
  ca.reset()
  return ca.info()
}

/**
 * One of the platform's tools, run to its end with what it prints kept, since what it says is the
 * error worth passing on. A tool that is not there is one line, and so is one that failed, with
 * what it wrote to stderr, else to stdout, stripped with stripSpace; killed by a signal it has failed
 * too, with nothing after the colon. Any other error from the system is thrown as it is.
 */
function runTool(deps: CliDeps, command: readonly string[]): void {
  const result = deps.run(command)
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliError(`${command[0]} was not found on PATH`)
    }
    throw result.error
  }
  if (result.status !== 0) {
    // Both are strings once the tool has run, though RunResult does not say so
    const said = stripSpace(result.stderr || result.stdout || '')
    throw new CliError(`${command.join(' ')} failed: ${said}`)
  }
}

/** The platform's own tool, given the certificate in pemFile */
export function installCommand(target: InstallTarget, pemFile: string): string[] {
  if (target === 'ios-simulator') {
    return ['xcrun', 'simctl', 'keychain', 'booted', 'add-root-cert', pemFile]
  }
  if (target === 'android') return ['adb', 'push', pemFile, ANDROID_REMOTE_PATH]
  return [
    'security',
    'add-trusted-cert',
    '-d',
    '-r',
    'trustRoot',
    '-k',
    '/Library/Keychains/System.keychain',
    pemFile,
  ]
}

/** tunnel ca export: the certificate a device has to install, into a file (relative to deps.cwd)
 *  or onto stdout as it is, no newline added and no JSON either way. The line that says where it
 *  went names the file as it was typed */
export async function cmdCaExport(args: Args, io: CliIo, deps: CliDeps): Promise<void> {
  const pem = await caPem(deps, args.base as string)
  if (args.out) {
    writeFileSync(userPath(deps, args.out as string), pem)
    io.stdout.write(`Wrote the CA certificate to ${args.out as string}\n`)
  } else {
    io.stdout.write(pem.toString('utf8'))
  }
}

/** tunnel ca info: the CA's subject, its fingerprint, how long it is valid and its two files */
export async function cmdCaInfo(args: Args, io: CliIo, deps: CliDeps): Promise<void> {
  const info = await caInfo(deps, args.base as string)
  print(io, { ...info }, args.json === true, [
    `subject:     ${info.subject}`,
    `fingerprint: ${info.fingerprint}`,
    `valid until: ${info.not_after}`,
    `certificate: ${info.ca_file}`,
    `private key: ${info.ca_key_file}`,
  ])
}

/** tunnel ca reset: a new CA, made by the running server, else in the config directory */
export async function cmdCaReset(args: Args, io: CliIo, deps: CliDeps): Promise<void> {
  const info = await caCall(
    deps,
    'POST',
    api(args.base as string, '/ca/reset'),
    (response) => response.json() as Promise<CaInfo>,
    () => resetLocalCa(deps),
  )
  print(io, { ...info }, args.json === true, [
    `Generated a new CA: ${info.fingerprint}`,
    'Every device that trusted the old certificate has to install this one, ' +
      'or its HTTPS requests will fail.',
  ])
}

/**
 * tunnel ca install: hands the certificate to the platform's own tool, the way Charles does. The
 * tool is given a file in a directory of its own, which is removed again whether the tool did its
 * part or not; what is left for a person to do is printed after.
 */
export async function cmdCaInstall(args: Args, io: CliIo, deps: CliDeps): Promise<void> {
  const target = args.target as InstallTarget
  const pem = await caPem(deps, args.base as string)
  if (target === 'macos' && args.json !== true) {
    io.stdout.write('macOS asks for an administrator password before it trusts a new root.\n')
  }
  const directory = mkdtempSync(join(tmpdir(), 'tunnel-'))
  let command: string[]
  try {
    const pemFile = join(directory, CA_FILE_NAME)
    writeFileSync(pemFile, pem)
    command = installCommand(target, pemFile)
    runTool(deps, command)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  print(io, { success: true, target, command }, args.json === true, INSTALL_NOTES[target])
}
