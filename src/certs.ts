// The certificate authority tunnel uses to terminate TLS for a client.
//
// A device installs `ca.pem` once and from then on trusts the certificates this
// module mints, which is what lets the proxy read the HTTPS traffic it is asked to
// decrypt. The CA lives in the config directory because it is a long lived
// identity: wiping runtime state must not force every device to install a new one.
//
// Leaf certificates are minted per host on first use and kept in memory only. They
// all share one RSA key, the way Charles does it: generating a 2048 bit key costs
// enough to be felt on a CONNECT, and only the certificate has to name the host.
// The key is made once per CertificateAuthority, as nothing here is a mutable
// module-level singleton, and `tunnel serve` makes one.
//
// The certificates are put together by hand, out of the DER in certs-der.ts, and
// the CA in the config directory is loaded as it is, whatever made it: the devices
// that trust it go on trusting what tunnel signs.
import { X509Certificate, createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { closeSync, existsSync, fchmodSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { createSecureContext, type SecureContext } from 'node:tls'
import {
  OID,
  SHA256_WITH_RSA,
  bitString,
  boolean,
  explicit,
  extension,
  generalName,
  integer,
  keyIdentifier,
  name,
  objectIdentifier,
  octetString,
  randomSerial,
  sequence,
  signCertificate,
  tbsFields,
  time,
  tlv,
} from './certs-der.ts'
import type { Paths } from './config.ts'
import { getLogger } from './log.ts'

const log = getLogger('certs')

/** RSA modulus length of both the CA key and the shared leaf key */
export const KEY_SIZE = 2048
/** How long a CA is valid from the moment it is generated: 3650 days */
export const CA_VALIDITY_MS = 3650 * 86_400_000
/** 398 days is the longest a leaf certificate may live before Safari and Chrome reject it; iOS
 *  caps it at 825 days. Whichever device it is, this is accepted */
export const LEAF_VALIDITY_MS = 398 * 86_400_000
/** notBefore is back-dated by this much: a phone whose clock runs a few minutes slow would
 *  otherwise reject a certificate minted a moment ago as not yet valid */
export const CLOCK_SKEW_MS = 5 * 60_000
/** What a decrypted connection is offered: the proxy parses HTTP/1.1 only, and a client that wanted
 *  h2 falls back */
export const ALPN_PROTOCOLS: readonly string[] = Object.freeze(['http/1.1'])

/** Shape returned by `GET /__admin__/ca` and printed by `tunnel ca info`. All strings, keys in
 *  this order */
export interface CaInfo {
  /** RFC 4514, most specific first: 'CN=tunnel CA <host> <date>,O=tunnel' */
  subject: string
  /** The same as fingerprint() */
  fingerprint: string
  /** UTC, whole seconds, ISO 8601 with +00:00 for the zone: '2026-10-11T03:32:19+00:00' */
  not_before: string
  not_after: string
  /** paths.caFile */
  ca_file: string
  /** paths.caKeyFile */
  ca_key_file: string
}

/** What the server side of one decrypted connection is built with:
 *  new tls.TLSSocket(raw, { isServer: true, ...ca.tlsOptionsFor(host) }) */
export interface TlsServerOptions {
  /** The host's leaf, alone, with no CA in the chain, and the shared key; TLS 1.2 at least */
  readonly secureContext: SecureContext
  /** ALPN_PROTOCOLS */
  readonly ALPNProtocols: readonly string[]
}

/** The CA in use: its certificate and key, and the two things every leaf takes from it, worked out
 *  once, when it is loaded or made */
interface Identity {
  certificate: X509Certificate
  key: KeyObject
  /** The subject's DER as it is in the certificate, to be the issuer of every leaf byte for byte:
   *  a verifier may compare names as bytes, and then a name encoded anew might not match */
  subject: Buffer
  /** keyIdentifier(the CA's public key): the authority key identifier of every leaf */
  keyId: Buffer
}

/** The key every leaf is issued for: the public half, for the leaves' subjectPublicKeyInfo, and the
 *  private half as the PKCS#8 PEM a secure context is built from, exported once */
interface LeafKey {
  publicKey: KeyObject
  pem: string
}

/** [0] { INTEGER 2 }: v3, the version of every certificate here */
const VERSION_3 = explicit(0, integer(Buffer.from([2])))

/** The CA's common name: 'tunnel CA <hostname> <YYYY-MM-DD in UTC>'. The hostname is cut at a
 *  character boundary so that the whole stays within 64 UTF-8 bytes. Exported for its test;
 *  os.hostname() cannot be faked */
export function caCommonName(hostname: string, now: Date): string {
  const prefix = 'tunnel CA '
  const suffix = ` ${now.toISOString().slice(0, 10)}`
  // A common name holds 64 at most: RFC 5280 counts characters, some libraries count UTF-8
  // bytes, and counting bytes satisfies both. A host name of 44 characters or more, such as
  // EC2's ip-10-0-12-34.ap-northeast-1.compute.internal, is cut
  let room = 64 - Buffer.byteLength(prefix + suffix)
  let kept = ''
  for (const character of hostname) {
    room -= Buffer.byteLength(character)
    if (room < 0) break
    kept += character
  }
  return prefix + kept + suffix
}

/** Loads or creates the CA, and mints one server certificate per host.
 *
 *  Nothing is written until the CA is actually used, so constructing this next to a manager costs
 *  nothing; `tunnel serve` calls ensure() at startup so that the first CONNECT does not pay for a
 *  key generation. */
export class CertificateAuthority {
  readonly paths: Paths
  #identity: Identity | null = null
  #leafKey: LeafKey | null = null
  #leaves = new Map<string, X509Certificate>()
  #options = new Map<string, TlsServerOptions>()

  constructor(paths: Paths) {
    this.paths = paths
  }

  // ---- The CA itself

  /** Load ca.pem and ca-key.pem; when either is missing, generate both. Loaded once, then kept in
   *  memory. A CA that cannot be loaded throws, and is not remembered: the next call tries again */
  ensure(): void {
    this.#ensure()
  }

  /** ensure() for the methods here, which need what it loaded or made: this one returns it */
  #ensure(): Identity {
    if (this.#identity === null) {
      const existing = existsSync(this.paths.caFile) && existsSync(this.paths.caKeyFile)
      this.#identity = existing ? this.#load() : this.#create()
    }
    return this.#identity
  }

  /** ensure(), then the CA certificate devices install. The same object until reset() */
  certificate(): X509Certificate {
    return this.#ensure().certificate
  }

  /** ensure(), and generate the shared leaf key now rather than on the first CONNECT.
   *
   *  Two RSA keys are made here rather than mid-handshake: the CA's, when there is none yet, and
   *  the one every leaf certificate shares. Each takes tens of milliseconds, and blocks while it
   *  does, which a client that is waiting for its TLS handshake would feel as a stall. The proxy
   *  calls this at startup, before it listens */
  warm(): void {
    this.#ensure()
    this.#sharedLeafKey()
  }

  /** Replace the CA with a fresh one; every device has to install it again. Both files are written
   *  over and both caches emptied. The old files are not read, so this works when they are
   *  damaged. When the new CA cannot be made, that error is thrown and the CA in use stays, its
   *  caches emptied all the same */
  reset(): X509Certificate {
    this.#leaves.clear()
    this.#options.clear()
    this.#identity = this.#create()
    return this.#identity.certificate
  }

  /** The CA in the two files, which it leaves as they are. Throws when either cannot be read or
   *  parsed, or holds a key that is not RSA. It checks nothing more: not that the key goes with
   *  the certificate, that the certificate is a CA's, or that it is still valid */
  #load(): Identity {
    let certificate: X509Certificate
    let subject: Buffer
    let publicKey: KeyObject
    try {
      certificate = new X509Certificate(readFileSync(this.paths.caFile))
      // What the leaves take from it is read here too: X509Certificate takes some certificates
      // these cannot be read out of, such as one in BER or one for a key OpenSSL does not know,
      // and such a ca.pem is as unusable as one that does not parse
      subject = tbsFields(certificate.raw).subject
      publicKey = certificate.publicKey
    } catch (error) {
      throw cannotLoad(this.paths.config_dir, `ca.pem: ${messageOf(error)}`)
    }
    let key: KeyObject
    try {
      key = createPrivateKey(readFileSync(this.paths.caKeyFile))
    } catch (error) {
      throw cannotLoad(this.paths.config_dir, `ca-key.pem: ${messageOf(error)}`)
    }
    // The key that signs the leaves, and the certificate's, which devices check them with
    for (const [file, held] of [
      ['ca-key.pem', key],
      ['ca.pem', publicKey],
    ] as const) {
      if (held.asymmetricKeyType !== 'rsa') {
        throw cannotLoad(
          this.paths.config_dir,
          `${file} holds an ${held.asymmetricKeyType} key, and tunnel signs with RSA keys only`,
        )
      }
    }
    return { certificate, key, subject, keyId: keyIdentifier(publicKey) }
  }

  /** A new CA: a new key, a certificate signed with it, both files written over, and a line in the
   *  log */
  #create(): Identity {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: KEY_SIZE })
    const now = new Date()
    // The name is what a device shows in its list of trusted certificates,
    // so it says which machine and which day it came from.
    const subject = name([
      [OID.organizationName, 'tunnel'],
      [OID.commonName, caCommonName(hostname(), now)],
    ])
    const keyId = keyIdentifier(publicKey)
    const tbs = sequence(
      VERSION_3,
      randomSerial(),
      SHA256_WITH_RSA,
      subject, // the issuer: it signs itself
      sequence(
        time(new Date(now.getTime() - CLOCK_SKEW_MS)),
        time(new Date(now.getTime() + CA_VALIDITY_MS)),
      ),
      subject,
      publicKey.export({ type: 'spki', format: 'der' }),
      explicit(
        3,
        sequence(
          // CA:TRUE with a path length of 0: it signs leaves, and no CA under it
          extension(OID.basicConstraints, true, sequence(boolean(true), integer(Buffer.from([0])))),
          // keyCertSign and cRLSign, bits 5 and 6, so the last bit of the byte is unused
          extension(OID.keyUsage, true, bitString(Buffer.from([0x06]), 1)),
          extension(OID.subjectKeyIdentifier, false, octetString(keyId)),
        ),
      ),
    )
    const certificate = new X509Certificate(signCertificate(tbs, privateKey))

    this.paths.create()
    writeFileSync(this.paths.caFile, certificate.toString())
    writePrivateKey(
      this.paths.caKeyFile,
      String(privateKey.export({ type: 'pkcs8', format: 'pem' })),
    )
    log.info(`Generated a new CA in ${this.paths.config_dir}`)
    return { certificate, key: privateKey, subject, keyId }
  }

  // ---- Leaves

  /** The server certificate for one host, minted on first use and cached: the same object every
   *  time until reset(). An empty host, or one with a character past ASCII, throws before anything
   *  is loaded, made or kept */
  leafFor(host: string): X509Certificate {
    const cached = this.#leaves.get(host)
    if (cached !== undefined) return cached
    if (host === '') throw new Error('Cannot issue a certificate for an empty host')
    // net.isIP takes no spelling with a character past ASCII, so such a host would be a dNSName,
    // which holds ASCII only
    if (!/^[\x00-\x7f]*$/.test(host)) {
      throw new Error(
        `Cannot issue a certificate for ${JSON.stringify(host)}: a DNS name has to be ASCII ` +
          '(an internationalised name goes in its xn-- form)',
      )
    }

    const issuer = this.#ensure()
    const key = this.#sharedLeafKey()
    const now = new Date()
    const tbs = sequence(
      VERSION_3,
      randomSerial(),
      SHA256_WITH_RSA,
      issuer.subject,
      sequence(
        time(new Date(now.getTime() - CLOCK_SKEW_MS)),
        time(new Date(now.getTime() + LEAF_VALIDITY_MS)),
      ),
      // A common name is capped at 64 characters and nothing validates it
      // any more; the SAN below is what the client actually checks.
      name([[OID.commonName, host.slice(0, 64)]]),
      key.publicKey.export({ type: 'spki', format: 'der' }),
      explicit(
        3,
        sequence(
          extension(OID.subjectAltName, false, sequence(generalName(host))),
          // Without this a strict verifier (OpenSSL 3, for one)
          // refuses the chain outright: "Missing Authority Key Identifier".
          // It holds the keyIdentifier alone, an implicit [0].
          extension(OID.authorityKeyIdentifier, false, sequence(tlv(0x80, issuer.keyId))),
          // CA:FALSE, the default, which DER leaves out: an empty SEQUENCE
          extension(OID.basicConstraints, true, sequence()),
          // digitalSignature and keyEncipherment, bits 0 and 2, so the last 5 bits of the byte
          // are unused
          extension(OID.keyUsage, true, bitString(Buffer.from([0xa0]), 5)),
          extension(OID.extKeyUsage, false, sequence(objectIdentifier(OID.serverAuth))),
        ),
      ),
    )
    const certificate = new X509Certificate(signCertificate(tbs, issuer.key))
    this.#leaves.set(host, certificate)
    return certificate
  }

  /** leafFor(host) and the shared key as TLS server options, built on first use and cached: the
   *  same object every time until reset(), and frozen, as every connection to the host shares it.
   *  A host leafFor() refuses is refused here as well, with nothing built or kept.
   *
   *  Only HTTP/1.1 is offered: a client that would have spoken HTTP/2 falls back on its own, and
   *  the proxy parses one protocol. A Node secure context cannot hold that: ALPNProtocols is an
   *  option of a socket or a server, not of createSecureContext. So the two come back together,
   *  and the method is named for what it returns. Spread them into a TLSSocket, as
   *  TlsServerOptions shows: tls.createServer({ secureContext }) ignores the context, and a server
   *  has to hand it out from its SNICallback instead */
  tlsOptionsFor(host: string): TlsServerOptions {
    const cached = this.#options.get(host)
    if (cached !== undefined) return cached

    const leaf = this.leafFor(host)
    const options = Object.freeze({
      // The PEM goes straight in
      secureContext: createSecureContext({
        key: this.#sharedLeafKey().pem,
        cert: leaf.toString(),
        // Written out so that a Node started with --tls-min-v1.0 does not lower it
        minVersion: 'TLSv1.2',
      }),
      ALPNProtocols: ALPN_PROTOCOLS,
    })
    this.#options.set(host, options)
    return options
  }

  /** The one key every leaf certificate is issued for, made on first use: once per
   *  CertificateAuthority, and reset() keeps it */
  #sharedLeafKey(): LeafKey {
    if (this.#leafKey === null) {
      const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: KEY_SIZE })
      this.#leafKey = {
        publicKey,
        pem: String(privateKey.export({ type: 'pkcs8', format: 'pem' })),
      }
    }
    return this.#leafKey
  }

  // ---- Reporting

  /** What a device downloads: certificate() as PEM, serialised anew, which is byte for byte the
   *  ca.pem that #create() wrote */
  certificatePem(): Buffer {
    return Buffer.from(this.certificate().toString())
  }

  /** SHA-256 of the certificate's DER, upper-case hex pairs joined by ':', the way devices display
   *  it */
  fingerprint(): string {
    return this.certificate().fingerprint256
  }

  /** Shape returned by `GET /__admin__/ca` and printed by `tunnel ca info` */
  info(): CaInfo {
    const certificate = this.certificate()
    return {
      // x509.subject has an attribute a line, in the order of the DER; RFC 4514 puts the most
      // specific first
      subject: certificate.subject.split('\n').reverse().join(','),
      fingerprint: this.fingerprint(),
      not_before: isoformat(certificate.validFromDate),
      not_after: isoformat(certificate.validToDate),
      ca_file: this.paths.caFile,
      ca_key_file: this.paths.caKeyFile,
    }
  }
}

/** A UTC time in whole seconds, which is what a certificate's times are, in ISO 8601 with +00:00
 *  for the zone: 2026-10-11T03:32:19+00:00 */
function isoformat(date: Date): string {
  return `${date.toISOString().slice(0, 19)}+00:00`
}

/** 0600 before any bytes land: the private key is the whole security story. A file openSync
 *  creates is 0600 from the start, and fchmod makes one that was there 0600 before anything is
 *  written to it. writeFileSync, unlike writeSync, goes on writing to an fd until all of it is
 *  written */
function writePrivateKey(path: string, pem: string): void {
  const fd = openSync(path, 'w', 0o600)
  try {
    fchmodSync(fd, 0o600) // openSync leaves the mode of an existing file alone
    writeFileSync(fd, pem)
  } finally {
    closeSync(fd)
  }
}

/** Why the CA in directory cannot be used, and the way out, which costs every device a new
 *  install. When `tunnel serve` cannot start, this is the line a person reads */
function cannotLoad(directory: string, reason: string): Error {
  return new Error(
    `Could not load the CA in ${directory}: ${reason}. ` +
      '`tunnel ca reset` makes a new one, which every device then has to install.',
  )
}

/** What a caught error says: its message, without the name String(error) would put in front */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
