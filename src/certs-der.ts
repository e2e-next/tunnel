// DER, written by hand: what certs.ts builds its certificates from. node:crypto
// makes keys, reads certificates (X509Certificate) and signs, but cannot build
// a certificate. The two libraries that can, @peculiar/x509 and node-forge,
// would each take the install past its budget, in bytes and in packages, and
// would save little: a certificate here has to come out byte for byte as the
// golden ones in tests/fixtures/certs do, so each part would be set up and
// checked by hand all the same.
//
// It does only as much DER as tunnel's certificates need: tags of one byte, and
// lengths in the definite form, the shortest one, as DER requires.
//
// The module is certs.ts's own. Other modules use what certs.ts exports and do
// not import this one.
import { createHash, randomBytes, sign, type KeyObject } from 'node:crypto'
import { isIP } from 'node:net'

// ---- Writing ----

/** A definite length in the shortest form: under 128 one byte; otherwise 0x80 plus the count of the
 *  big-endian bytes that follow, then those bytes */
function definiteLength(n: number): number[] {
  if (n < 0x80) return [n]
  const bytes: number[] = []
  for (let rest = n; rest > 0; rest = Math.floor(rest / 0x100)) bytes.unshift(rest % 0x100)
  return [0x80 | bytes.length, ...bytes]
}

/** One TLV: a one-byte tag, the length of all the contents together, then the contents in order */
export function tlv(tag: number, ...contents: Uint8Array[]): Buffer {
  const content = Buffer.concat(contents)
  return Buffer.concat([Buffer.from([tag, ...definiteLength(content.length)]), content])
}

export function sequence(...contents: Uint8Array[]): Buffer {
  return tlv(0x30, ...contents)
}

/** Only ever wraps a single attribute, as each attribute here is an RDN of its own, so DER's rule
 *  that the elements of a SET OF go in sorted order never comes into play */
export function set(...contents: Uint8Array[]): Buffer {
  return tlv(0x31, ...contents)
}

export function boolean(value: boolean): Buffer {
  return tlv(0x01, Buffer.from([value ? 0xff : 0x00]))
}

export function nullValue(): Buffer {
  return tlv(0x05)
}

/** An unsigned big-endian magnitude as the shortest INTEGER: the leading zero bytes go, and one 0x00
 *  comes back when nothing is left (zero) or the top bit is set (it would read as negative) */
export function integer(magnitude: Uint8Array): Buffer {
  let start = 0
  while (magnitude[start] === 0) start++
  const digits = magnitude.subarray(start)
  const top = digits[0]
  return top === undefined || top >= 0x80 ? tlv(0x02, Buffer.from([0]), digits) : tlv(0x02, digits)
}

/** The first content byte counts the bits left unused at the end of the last byte */
export function bitString(bytes: Uint8Array, unusedBits = 0): Buffer {
  return tlv(0x03, Buffer.from([unusedBits]), bytes)
}

export function octetString(bytes: Uint8Array): Buffer {
  return tlv(0x04, bytes)
}

/** From dotted arcs. The first two share one subidentifier, 40 × first + second, and every
 *  subidentifier goes base 128, most significant group first, the top bit set on all its bytes but
 *  the last */
export function objectIdentifier(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number)
  const bytes: number[] = []
  for (const subidentifier of [40 * first + second, ...rest]) {
    const groups = [subidentifier % 0x80]
    for (let high = Math.floor(subidentifier / 0x80); high > 0; high = Math.floor(high / 0x80)) {
      groups.unshift(0x80 | (high % 0x80))
    }
    bytes.push(...groups)
  }
  return tlv(0x06, Buffer.from(bytes))
}

export function utf8String(text: string): Buffer {
  return tlv(0x0c, Buffer.from(text, 'utf8'))
}

/** text's bytes, for a type that holds ASCII only: an IA5String, which a dNSName is too */
function ascii(text: string): Buffer {
  if (!/^[\x00-\x7f]*$/.test(text)) {
    throw new Error(`An IA5String holds ASCII only, not ${JSON.stringify(text)}`)
  }
  return Buffer.from(text, 'ascii')
}

export function ia5String(text: string): Buffer {
  return tlv(0x16, ascii(text))
}

/** UTCTime YYMMDDHHMMSSZ through 2049 and GeneralizedTime YYYYMMDDHHMMSSZ from 2050 on, as RFC 5280
 *  4.1.2.5 asks. Cut to the whole second first, and the year read from that, so that
 *  2049-12-31T23:59:59.999Z stays a UTCTime */
export function time(date: Date): Buffer {
  const second = new Date(Math.floor(date.getTime() / 1000) * 1000)
  const digits = second.toISOString().replace(/\D/g, '').slice(0, 14) // YYYYMMDDHHMMSS
  return second.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`, 'ascii'))
    : tlv(0x18, Buffer.from(`${digits}Z`, 'ascii'))
}

/** An explicit [n] (context-specific, constructed) around the contents: in a TBSCertificate, the
 *  version's [0] and the extensions' [3] */
export function explicit(n: number, ...contents: Uint8Array[]): Buffer {
  return tlv(0xa0 | n, ...contents)
}

// ---- Reading ----
//
// Only as far as taking a certificate apart: certs.ts copies the CA's subject out of the CA
// certificate byte for byte, to be the issuer of every leaf, and the tests compare certificates
// field by field. What certs.ts reads is a certificate X509Certificate has parsed already, so
// nothing here checks more than that each TLV is in a form it reads and stays inside the bytes.

/** Where one TLV sits in the bytes it was read from: the offsets of its tag and of its contents,
 *  and the offset just past its last byte */
export interface Tlv {
  tag: number
  start: number
  contentStart: number
  end: number
}

/** The TLV at offset, whose length is in the definite form and in at most 4 bytes. Throws, naming
 *  the offset, when the length is in any other form or the bytes run out */
export function readTlv(der: Uint8Array, offset: number): Tlv {
  const tag = der[offset]
  const first = der[offset + 1]
  if (tag === undefined || first === undefined) {
    throw new Error(`No tag and length at offset ${offset}: the DER ends at ${der.length}`)
  }
  let contentStart = offset + 2
  let length = first
  if (first >= 0x80) {
    const count = first & 0x7f
    if (count === 0) {
      throw new Error(
        `The TLV at offset ${offset} has an indefinite length, which DER does not allow`,
      )
    }
    if (count > 4) {
      throw new Error(`The TLV at offset ${offset} has ${count} length bytes; at most 4 are read`)
    }
    const lengthBytes = der.subarray(contentStart, contentStart + count)
    if (lengthBytes.length < count) {
      throw new Error(
        `The length of the TLV at offset ${offset} is cut off: the DER ends at ${der.length}`,
      )
    }
    length = lengthBytes.reduce((value, byte) => value * 0x100 + byte, 0)
    contentStart += count
  }
  const end = contentStart + length
  if (end > der.length) {
    throw new Error(
      `The TLV at offset ${offset} runs to ${end}, past the end of the DER at ${der.length}`,
    )
  }
  return { tag, start: offset, contentStart, end }
}

/** The TLVs inside parent, in order. Each one has to end inside parent too */
export function childrenOf(der: Uint8Array, parent: Tlv): Tlv[] {
  const children: Tlv[] = []
  for (let offset = parent.contentStart; offset < parent.end;) {
    const child = readTlv(der, offset)
    if (child.end > parent.end) {
      throw new Error(
        `The TLV at offset ${offset} runs to ${child.end}, past the end of the one it is in at ${parent.end}`,
      )
    }
    children.push(child)
    offset = child.end
  }
  return children
}

/** The fields of a certificate's TBSCertificate, each one its whole TLV as it is in the DER */
export interface TbsFields {
  version: Buffer | null
  serialNumber: Buffer
  signature: Buffer
  issuer: Buffer
  validity: Buffer
  subject: Buffer
  subjectPublicKeyInfo: Buffer
  extensions: Buffer | null
}

/** A certificate's TBSCertificate taken apart into its eight fields. version and extensions are
 *  null when the certificate leaves them out, as a v1 certificate does. The fields are cut from a
 *  copy of the DER, so they stay as they are whatever becomes of the bytes passed in */
export function tbsFields(certificateDer: Uint8Array): TbsFields {
  const der = Buffer.from(certificateDer)
  const tbs = childrenOf(der, readTlv(der, 0))[0]
  const fields = tbs === undefined ? [] : childrenOf(der, tbs)
  const bytes = (field: Tlv | undefined) => {
    if (field === undefined) {
      throw new Error(`A TBSCertificate has at least 6 fields, and this one has ${fields.length}`)
    }
    return der.subarray(field.start, field.end)
  }
  // The version is [0], and a v1 certificate leaves it out. After subjectPublicKeyInfo may come
  // the issuer's and the subject's unique IDs, [1] and [2], and then the extensions, [3]
  const at = fields[0]?.tag === 0xa0 ? 1 : 0
  const extensions = fields.slice(at + 6).find((field) => field.tag === 0xa3)
  return {
    version: at === 1 ? bytes(fields[0]) : null,
    serialNumber: bytes(fields[at]),
    signature: bytes(fields[at + 1]),
    issuer: bytes(fields[at + 2]),
    validity: bytes(fields[at + 3]),
    subject: bytes(fields[at + 4]),
    subjectPublicKeyInfo: bytes(fields[at + 5]),
    extensions: extensions === undefined ? null : bytes(extensions),
  }
}

// ---- X.509 parts ----

/** The object identifiers in tunnel's certificates, dotted */
export const OID = Object.freeze({
  commonName: '2.5.4.3',
  organizationName: '2.5.4.10',
  subjectKeyIdentifier: '2.5.29.14',
  keyUsage: '2.5.29.15',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  authorityKeyIdentifier: '2.5.29.35',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  sha256WithRSAEncryption: '1.2.840.113549.1.1.11',
})

/** The AlgorithmIdentifier of sha256WithRSAEncryption, its NULL parameters included: the
 *  signature field of a TBSCertificate, and the signatureAlgorithm that follows it. A Buffer
 *  cannot be frozen, so nothing may write to these bytes */
export const SHA256_WITH_RSA: Buffer = sequence(
  objectIdentifier(OID.sha256WithRSAEncryption),
  nullValue(),
)

/** A Name, each attribute an RDN of its own, in the order given, each value a UTF8String */
export function name(attributes: ReadonlyArray<readonly [oid: string, value: string]>): Buffer {
  return sequence(
    ...attributes.map(([oid, value]) => set(sequence(objectIdentifier(oid), utf8String(value)))),
  )
}

/** An Extension: its OID, the critical flag only when it is set (DER leaves a default out), and
 *  the value's DER in an OCTET STRING */
export function extension(oid: string, critical: boolean, value: Uint8Array): Buffer {
  return critical
    ? sequence(objectIdentifier(oid), boolean(true), octetString(value))
    : sequence(objectIdentifier(oid), octetString(value))
}

/** The GeneralName for a host in a leaf's subjectAltName. An IP literal has to go in the SAN as an
 *  IPAddress, not as a DNS name: an iPAddress [7] of 4 or 16 bytes. Any other host is a
 *  dNSName [2], as it is. A dNSName holds ASCII only, so a host with any other character throws.
 *  Both tags are implicit: they stand in place of OCTET STRING's and IA5String's.
 *
 *  net.isIP does not take an IPv6 zone with a character outside [0-9A-Za-z.:-], such as
 *  fe80::1%en 0, for an address. A zone names an interface on the sender's own machine, so a
 *  device's CONNECT never has one. */
export function generalName(host: string): Buffer {
  switch (isIP(host)) {
    case 4:
      return tlv(0x87, Buffer.from(host.split('.').map(Number)))
    case 6:
      return tlv(0x87, ipv6Bytes(host))
    default:
      return tlv(0x82, ascii(host))
  }
}

/** The 16 bytes of an IPv6 literal net.isIP has taken: the zone dropped first, as it may hold
 *  dots and colons of its own; :: filled with zero bytes; and a dotted IPv4 at the end, its 4
 *  bytes */
function ipv6Bytes(literal: string): Buffer {
  const [head = '', tail] = literal.replace(/%.*$/s, '').split('::')
  const front = groupBytes(head)
  const back = tail === undefined ? [] : groupBytes(tail)
  return Buffer.from([
    ...front,
    ...new Array<number>(16 - front.length - back.length).fill(0),
    ...back,
  ])
}

/** The bytes of some colon-separated groups of an IPv6 literal: two for a group of hex digits,
 *  four for the dotted IPv4 that may end it */
function groupBytes(groups: string): number[] {
  if (groups === '') return []
  return groups.split(':').flatMap((group) => {
    if (group.includes('.')) return group.split('.').map(Number)
    const value = parseInt(group, 16)
    return [value >> 8, value & 0xff]
  })
}

/** RFC 5280 4.2.1.2's method (1) for a key identifier: the SHA-1 of the RSAPublicKey DER, which
 *  is what subjectPublicKeyInfo's BIT STRING holds */
export function keyIdentifier(publicKey: KeyObject): Buffer {
  return createHash('sha1')
    .update(publicKey.export({ type: 'pkcs1', format: 'der' }))
    .digest()
}

/** A serial number, a whole INTEGER: 159 random bits, so positive and at most 20 content bytes, as
 *  RFC 5280 4.1.2.2 asks. Once in 2^159 all of them come out zero, and a serial has to be
 *  positive, so then it is 1 */
export function randomSerial(): Buffer {
  const bytes = randomBytes(20)
  bytes[0] = bytes.readUInt8(0) & 0x7f
  if (bytes.every((byte) => byte === 0)) bytes[19] = 1
  return integer(bytes)
}

/** A whole Certificate: the TBSCertificate, sha256WithRSAEncryption, and in a BIT STRING the key's
 *  signature over the TBSCertificate's bytes (RSASSA-PKCS1-v1_5, which is what crypto.sign does
 *  with an RSA key) */
export function signCertificate(tbs: Uint8Array, key: KeyObject): Buffer {
  return sequence(tbs, SHA256_WITH_RSA, bitString(sign('sha256', tbs, key)))
}
