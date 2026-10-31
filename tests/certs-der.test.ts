// src/certs-der.ts: the DER that certs.ts builds its certificates from. Each
// expected encoding is written out byte by byte, or else it is in a golden file:
// the CA and the subjectAltNames in tests/fixtures/certs.
import assert from 'node:assert/strict'
import { X509Certificate, generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  OID,
  SHA256_WITH_RSA,
  bitString,
  boolean,
  childrenOf,
  explicit,
  extension,
  generalName,
  ia5String,
  integer,
  keyIdentifier,
  name,
  nullValue,
  objectIdentifier,
  octetString,
  randomSerial,
  readTlv,
  sequence,
  set,
  signCertificate,
  tbsFields,
  time,
  tlv,
  utf8String,
} from '../src/certs-der.ts'

const fixture = (file: string) => readFileSync(new URL(`./fixtures/certs/${file}`, import.meta.url))
const hex = (bytes: Uint8Array | null) =>
  bytes === null ? 'null' : Buffer.from(bytes).toString('hex')

test('a length under 128 takes one byte; longer ones 0x81, 0x82 or 0x83 and then the length', () => {
  for (const [n, header] of [
    [0, '0400'],
    [127, '047f'],
    [128, '048180'],
    [255, '0481ff'],
    [256, '04820100'],
    [65535, '0482ffff'],
    [65536, '0483010000'],
  ] as const) {
    const content = Buffer.alloc(n, 0xa5)
    const der = tlv(0x04, content)
    const headerLength = header.length / 2
    assert.equal(hex(der.subarray(0, headerLength)), header, `length ${n}`)
    assert.equal(der.length, headerLength + n, `length ${n}`)
    assert.ok(der.subarray(headerLength).equals(content), `length ${n}`)
  }
  // Several contents are counted together and follow the header in the order given
  assert.equal(hex(tlv(0x30, Buffer.from([1]), Buffer.from([2, 3]))), '3003010203')
})

test('INTEGER: the shortest form of an unsigned magnitude, with a 0x00 when the top bit is set', () => {
  for (const [magnitude, expected] of [
    [[0], '020100'],
    [[], '020100'],
    [[0x7f], '02017f'],
    [[0x80], '02020080'],
    [[0, 0, 0x12, 0x34], '02021234'],
    [[0, 0, 0x80], '02020080'],
  ] as const) {
    assert.equal(hex(integer(Buffer.from(magnitude))), expected, JSON.stringify(magnitude))
  }
})

test('OBJECT IDENTIFIER: the first two arcs share a byte, the rest go base 128', () => {
  // sha256WithRSAEncryption, subjectAltName, serverAuth
  assert.equal(hex(objectIdentifier('1.2.840.113549.1.1.11')), '06092a864886f70d01010b')
  assert.equal(hex(objectIdentifier('2.5.29.17')), '0603551d11')
  assert.equal(hex(objectIdentifier('1.3.6.1.5.5.7.3.1')), '06082b06010505070301')
})

test('UTCTime through 2049, GeneralizedTime from 2050, both cut to the whole second', () => {
  // Rounded rather than cut, the first would be 2050 and a GeneralizedTime
  assert.equal(
    hex(time(new Date('2049-12-31T23:59:59.999Z'))),
    '170d' + Buffer.from('491231235959Z', 'ascii').toString('hex'),
  )
  assert.equal(
    hex(time(new Date('2050-01-01T00:00:00Z'))),
    '180f' + Buffer.from('20500101000000Z', 'ascii').toString('hex'),
  )
})

test('BOOLEAN, NULL, BIT STRING, OCTET STRING, UTF8String, IA5String and [n]', () => {
  assert.equal(hex(boolean(true)), '0101ff')
  assert.equal(hex(boolean(false)), '010100')
  assert.equal(hex(nullValue()), '0500')
  // A BIT STRING's first content byte counts the bits left unused at its end
  assert.equal(hex(bitString(Buffer.from([0x06]), 1)), '03020106')
  assert.equal(hex(bitString(Buffer.from([0xab]))), '030200ab')
  assert.equal(hex(octetString(Buffer.from([1, 2]))), '04020102')
  // The length counts bytes, not characters: 8 characters, 9 bytes, as é takes two
  assert.equal(hex(utf8String('tunnel é')), '0c0974756e6e656c20c3a9')
  // ASCII is 0x00–0x7f; past it IA5String throws
  assert.equal(hex(ia5String('a b')), '1603612062')
  assert.equal(hex(ia5String('\x00\x7f')), '1602007f')
  assert.throws(() => ia5String('bücher.de'), /ASCII/)
  assert.throws(() => ia5String('\x80'), /ASCII/)
  assert.equal(hex(explicit(3, sequence())), 'a3023000')
  assert.equal(hex(set(nullValue())), '31020500')
})

test('reading gives back what was written, and refuses truncated, indefinite and over-long lengths', () => {
  // 30 81 d3 { 02 01 05, 30 81 cd { 04 81 c8 <200 bytes>, 05 00 } }: 214 bytes in all
  const content = Buffer.alloc(200, 0xa5)
  const der = sequence(integer(Buffer.from([5])), sequence(octetString(content), nullValue()))
  assert.equal(der.length, 214)
  const outer = readTlv(der, 0)
  assert.deepEqual(outer, { tag: 0x30, start: 0, contentStart: 3, end: 214 })
  assert.deepEqual(childrenOf(der, outer), [
    { tag: 0x02, start: 3, contentStart: 5, end: 6 },
    { tag: 0x30, start: 6, contentStart: 9, end: 214 },
  ])
  assert.deepEqual(childrenOf(der, readTlv(der, 6)), [
    { tag: 0x04, start: 9, contentStart: 12, end: 212 },
    { tag: 0x05, start: 212, contentStart: 214, end: 214 },
  ])
  assert.ok(der.subarray(12, 212).equals(content))

  // A byte short, the outer TLV runs past the end of the input, and so does its second child
  const short = der.subarray(0, -1)
  assert.throws(() => readTlv(short, 0), /offset 0\b.*past the end/)
  assert.throws(() => childrenOf(short, outer), /offset 6\b.*past the end/)
  // A child may not run past the end of its parent either, though the input goes on
  const overrun = Buffer.from('300304050102030405', 'hex')
  assert.throws(() => childrenOf(overrun, readTlv(overrun, 0)), /offset 2\b.*past the end/)
  // The indefinite form, 5 length bytes (for a length of 1), a length cut off, a tag alone, and
  // nothing at all
  assert.throws(() => readTlv(Buffer.from('30800000', 'hex'), 0), /offset 0\b.*indefinite/)
  assert.throws(() => readTlv(Buffer.from('3085000000000100', 'hex'), 0), /offset 0\b.*5 length/)
  assert.throws(() => readTlv(Buffer.from('048201', 'hex'), 0), /offset 0\b.*cut off/)
  assert.throws(() => readTlv(Buffer.from('30', 'hex'), 0), /offset 0\b/)
  assert.throws(() => readTlv(der, 214), /offset 214\b/)
})

test('tbsFields: the eight fields of a certificate built from these parts, and null for those it lacks', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const fields = [
    'version',
    'serialNumber',
    'signature',
    'issuer',
    'validity',
    'subject',
    'subjectPublicKeyInfo',
    'extensions',
  ] as const
  const parts = {
    version: explicit(0, integer(Buffer.from([2]))),
    serialNumber: randomSerial(),
    signature: SHA256_WITH_RSA,
    issuer: name([[OID.commonName, 'parts']]),
    validity: sequence(
      time(new Date('2026-10-23T00:00:00Z')),
      time(new Date('2027-10-23T00:00:00Z')),
    ),
    subject: name([[OID.commonName, 'parts']]),
    subjectPublicKeyInfo: publicKey.export({ type: 'spki', format: 'der' }),
    extensions: explicit(
      3,
      sequence(extension(OID.basicConstraints, true, sequence(boolean(true)))),
    ),
  }

  // v3: all eight
  const der = signCertificate(sequence(...fields.map((field) => parts[field])), privateKey)
  const certificate = new X509Certificate(der)
  assert.ok(certificate.verify(publicKey))
  assert.equal(certificate.subject, 'CN=parts')
  assert.equal(certificate.ca, true)
  const v3 = tbsFields(der)
  der.fill(0) // what tbsFields gave back is its own copy
  assert.deepEqual(Object.keys(v3), fields)
  for (const field of fields) assert.equal(hex(v3[field]), hex(parts[field]), field)
  // SEQUENCE { OID sha256WithRSAEncryption, NULL }, as in the fixture certificates
  assert.equal(hex(SHA256_WITH_RSA), '300d06092a864886f70d01010b0500')

  // The issuer's and the subject's unique IDs, [1] and [2], may come before the extensions
  const uniqueIds = [tlv(0x81, Buffer.from([0x00, 0xab])), tlv(0x82, Buffer.from([0x00, 0xcd]))]
  const withIds = [...fields.slice(0, -1).map((field) => parts[field]), ...uniqueIds]
  const found = tbsFields(signCertificate(sequence(...withIds, parts.extensions), privateKey))
  assert.equal(hex(found.extensions), hex(parts.extensions))

  // v1: neither the version nor the extensions
  const v1Der = signCertificate(
    sequence(...fields.slice(1, -1).map((field) => parts[field])),
    privateKey,
  )
  const v1Certificate = new X509Certificate(v1Der)
  assert.ok(v1Certificate.verify(publicKey))
  assert.equal(v1Certificate.subject, 'CN=parts')
  const v1 = tbsFields(v1Der)
  for (const field of fields) {
    const absent = field === 'version' || field === 'extensions'
    assert.equal(hex(v1[field]), absent ? 'null' : hex(parts[field]), field)
  }
})

test('keyIdentifier is the SHA-1 of the RSA public key: the SKI in the fixture CA', () => {
  const ca = new X509Certificate(fixture('ca.pem'))
  const block = tbsFields(ca.raw).extensions
  assert.ok(block)
  // [3] { SEQUENCE { Extension, … } }, where an Extension is SEQUENCE { OID, … }
  const [list] = childrenOf(block, readTlv(block, 0))
  assert.ok(list)
  const wanted = objectIdentifier(OID.subjectKeyIdentifier)
  const ski = childrenOf(block, list).find((entry) => {
    const [oid] = childrenOf(block, entry)
    return oid !== undefined && block.subarray(oid.start, oid.end).equals(wanted)
  })
  assert.ok(ski)
  assert.equal(
    hex(block.subarray(ski.start, ski.end)),
    hex(extension(OID.subjectKeyIdentifier, false, octetString(keyIdentifier(ca.publicKey)))),
  )
})

test("name() encodes O and CN as in the fixture CA's subject, byte for byte", () => {
  const ca = new X509Certificate(fixture('ca.pem'))
  // x509.subject has an attribute a line, in the order of the DER
  assert.match(ca.subject, /^O=tunnel\nCN=tunnel CA [^\n]+$/)
  const commonName = ca.subject.slice('O=tunnel\nCN='.length)
  const subject = name([
    [OID.organizationName, 'tunnel'],
    [OID.commonName, commonName],
  ])
  assert.equal(hex(subject), hex(tbsFields(ca.raw).subject))
})

test('a SAN for every host in san.json, byte for byte as the file has it', () => {
  // { host, san } where a SAN is made, { host, error } where it is refused
  const rows: { host: string; san?: string; error?: string }[] = JSON.parse(
    fixture('san.json').toString('utf8'),
  )
  assert.equal(rows.length, 44)
  for (const { host, san } of rows) {
    if (san === undefined) assert.throws(() => generalName(host), /ASCII/, JSON.stringify(host))
    else assert.equal(hex(sequence(generalName(host))), san, JSON.stringify(host))
  }
  // A zone may hold dots and colons, which no zone in san.json does. net.isIP takes these as IPv6,
  // and they are packed without the zone, as below, so the zone has to go before the groups are
  // read
  for (const [host, packed] of [
    ['fe80::1%a.b', 'fe800000000000000000000000000001'],
    ['fe80::1%a:b', 'fe800000000000000000000000000001'],
    ['fe80::1%a::b', 'fe800000000000000000000000000001'],
    ['::ffff:1.2.3.4%a.b', '00000000000000000000ffff01020304'],
  ] as const) {
    assert.equal(hex(sequence(generalName(host))), `30128710${packed}`, JSON.stringify(host))
  }
})

test('randomSerial: positive, at most 20 content bytes, in the shortest form', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 100; i++) {
    const serial = randomSerial()
    const message = hex(serial)
    seen.add(message)
    const { tag, contentStart, end } = readTlv(serial, 0)
    assert.equal(tag, 0x02, message)
    assert.equal(end, serial.length, message)
    const content = serial.subarray(contentStart, end)
    assert.ok(content.length >= 1 && content.length <= 20, message)
    const [first = 0, second = 0] = content
    assert.equal(first & 0x80, 0, `${message} is negative`)
    assert.ok(
      content.some((byte) => byte !== 0),
      `${message} is zero`,
    )
    // A leading 0x00 is there only to keep a set top bit from reading as a sign
    if (content.length > 1) assert.ok(first !== 0 || second >= 0x80, `${message} is too long`)
  }
  // Random: no two alike
  assert.equal(seen.size, 100)
})
