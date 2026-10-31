// The CA tunnel signs with, and the per host certificates it mints.
//
// The point of every assertion here is one thing: a device that installed ca.pem
// accepts what tunnel serves, and keeps accepting it. So the central test is a
// real TLS handshake over a loopback socket, with the client trusting nothing but
// the file a phone would have installed.
//
// That holds for a CA tunnel did not make as well: the one in
// tests/fixtures/certs is loaded as it is and goes on signing, and what tunnel
// makes has the structure of the certificates there. The tests that use it work
// on a copy in a temp dir, never on the fixtures themselves.
import assert from 'node:assert/strict'
import { X509Certificate, createPrivateKey, generateKeyPairSync } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer, isIP, type AddressInfo, type Socket } from 'node:net'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { TLSSocket, checkServerIdentity, connect, type SecureVersion } from 'node:tls'
import {
  OID,
  bitString,
  childrenOf,
  extension,
  keyIdentifier,
  name,
  objectIdentifier,
  octetString,
  readTlv,
  sequence,
  signCertificate,
  tbsFields,
} from '../src/certs-der.ts'
import {
  CA_VALIDITY_MS,
  CLOCK_SKEW_MS,
  CertificateAuthority,
  KEY_SIZE,
  LEAF_VALIDITY_MS,
  caCommonName,
  type TlsServerOptions,
} from '../src/certs.ts'
import { Paths } from '../src/config.ts'
import { captureLogs } from './support/logs.ts'
import { tmpDir } from './support/tmp.ts'

const fixture = (file: string) => readFileSync(new URL(`./fixtures/certs/${file}`, import.meta.url))
const hex = (bytes: Uint8Array | null) =>
  bytes === null ? 'null' : Buffer.from(bytes).toString('hex')

// What info() said of the fixture CA, less the two paths
const fixtureInfo = JSON.parse(fixture('info.json').toString('utf8'))

/** A CA for a fresh directory, nothing written yet */
function makeCa(t: TestContext): CertificateAuthority {
  return new CertificateAuthority(Paths.inOneDirectory(tmpDir(t)))
}

/** A CA for a fresh directory holding a copy of the fixture CA's two files. Never one for
 *  tests/fixtures/certs itself, which a test that writes would change. git does not keep a
 *  file's mode, so the key is made private here */
function fixtureCa(t: TestContext): CertificateAuthority {
  const dir = tmpDir(t)
  writeFileSync(join(dir, 'ca.pem'), fixture('ca.pem'))
  writeFileSync(join(dir, 'ca-key.pem'), fixture('ca-key.pem'), { mode: 0o600 })
  return new CertificateAuthority(Paths.inOneDirectory(dir))
}

/** The fixture's ca.pem made anew: tbs puts the fields of its TBSCertificate together again, and
 *  the fixture's key signs them. Loading looks at what a certificate holds, not at what signed
 *  it */
function rebuildFixtureCa(tbs: (fields: Uint8Array[]) => Uint8Array): string {
  const fields = Object.values(tbsFields(new X509Certificate(fixture('ca.pem')).raw))
  const key = createPrivateKey(fixture('ca-key.pem'))
  return new X509Certificate(
    signCertificate(tbs(fields.filter((field) => field !== null)), key),
  ).toString()
}

/** The fixture's ca.pem for another key: spki in place of its subjectPublicKeyInfo, the
 *  seventh field */
const fixtureCaFor = (spki: Uint8Array) =>
  rebuildFixtureCa((fields) => sequence(...fields.toSpliced(6, 1, spki)))

/** One TLS handshake over loopback, client trusting only caFile: the protocol ALPN settled on, and
 *  what the server said. maxVersion is the newest TLS the client speaks.
 *
 *  The server end runs alongside, on the same event loop, because a handshake needs both ends at
 *  once; whatever it fails with is passed on here so that a broken certificate shows up as a
 *  failure rather than as a hang. The client's own error comes first, as it says why it refused,
 *  and timeoutMs without an end is a failure too, which closes both ends: a socket left open would
 *  keep the test process running after the failure */
function handshake(
  options: TlsServerOptions,
  caFile: string | URL,
  serverName: string,
  offeredAlpn: readonly string[] = ['h2', 'http/1.1'],
  maxVersion: SecureVersion = 'TLSv1.3',
  timeoutMs = 10_000,
): Promise<{ alpn: string | false | null; payload: string }> {
  return new Promise((resolve, reject) => {
    let serverError: Error | undefined
    // The connection the server took and the client, for the timeout to close: server.close()
    // leaves an open connection as it is
    const sockets: Socket[] = []
    const server = createServer((raw) => {
      sockets.push(raw)
      const tls = new TLSSocket(raw, { isServer: true, ...options })
      // A socket wrapped by hand says its handshake is done with 'secure', not 'secureConnect'
      tls.on('secure', () => tls.end('hello'))
      tls.on('error', (error) => {
        serverError = error
        raw.destroy()
      })
    })
    let settled = false
    const timer = setTimeout(
      () =>
        settle(() => {
          for (const socket of sockets) socket.destroy()
          reject(new Error(`no end to the handshake for ${serverName} in ${timeoutMs / 1000} s`))
        }),
      timeoutMs,
    )
    /** Ends it once, whichever way comes first */
    function settle(outcome: () => void): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.close()
      outcome()
    }

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      const client = connect({
        host: '127.0.0.1',
        port,
        ca: readFileSync(caFile),
        ALPNProtocols: offeredAlpn,
        maxVersion,
        // The socket goes to 127.0.0.1, and the certificate is checked against serverName
        checkServerIdentity: (_, certificate) => checkServerIdentity(serverName, certificate),
        // SNI carries a name, never an address (DEP0123)
        ...(isIP(serverName) === 0 ? { servername: serverName } : {}),
      })
      sockets.push(client)
      let payload = ''
      client.setEncoding('utf8').on('data', (chunk: string) => (payload += chunk))
      client.on('end', () =>
        settle(() =>
          serverError ? reject(serverError) : resolve({ alpn: client.alpnProtocol, payload }),
        ),
      )
      client.on('error', (error) => {
        client.destroy()
        settle(() => reject(error))
      })
      client.on('close', () =>
        settle(() =>
          reject(serverError ?? new Error('the connection closed before the server said hello')),
        ),
      )
    })
  })
}

/** A certificate's extensions, each one its whole TLV as it is in the DER, in order */
function extensionsOf(certificate: X509Certificate): Buffer[] {
  const block = tbsFields(certificate.raw).extensions
  assert.ok(block, 'the certificate has no extensions')
  // [3] { SEQUENCE OF Extension }
  const [list] = childrenOf(block, readTlv(block, 0))
  assert.ok(list)
  return childrenOf(block, list).map((entry) => block.subarray(entry.start, entry.end))
}

/** Both files, their bytes and their permission bits: what using a CA must leave as it was */
function snapshot(paths: Paths) {
  return [paths.caFile, paths.caKeyFile].map((file) => ({
    file,
    bytes: readFileSync(file),
    mode: statSync(file).mode & 0o777,
  }))
}

// ---------------------------------------------------------------- the handshake

// The whole point: trust ca.pem once, and every host tunnel answers for works
test('a client that installed ca.pem accepts the server', async (t) => {
  const ca = makeCa(t)
  const { alpn, payload } = await handshake(
    ca.tlsOptionsFor('localhost'),
    ca.paths.caFile,
    'localhost',
  )

  assert.equal(payload, 'hello')
  // iOS and OkHttp would otherwise negotiate HTTP/2, which the proxy does not speak
  assert.equal(alpn, 'http/1.1')
  // TLS 1.2 is the least the server takes, and not more: a device that speaks no newer, as
  // Android did before 10, is served too
  const older = await handshake(
    ca.tlsOptionsFor('localhost'),
    ca.paths.caFile,
    'localhost',
    undefined,
    'TLSv1.2',
  )
  assert.equal(older.payload, 'hello')
})

// A device configured with an IP, not a name, still gets a certificate that matches
test('an IP address host is accepted too', async (t) => {
  const ca = makeCa(t)
  const { payload } = await handshake(ca.tlsOptionsFor('127.0.0.1'), ca.paths.caFile, '127.0.0.1')

  assert.equal(payload, 'hello')
})

// The certificates are only trusted because of the CA, not because they are self signed
test('a client trusting something else refuses', async (t) => {
  const ca = makeCa(t)
  const other = new CertificateAuthority(Paths.inOneDirectory(join(ca.paths.config_dir, 'other')))
  other.ensure()

  await assert.rejects(handshake(ca.tlsOptionsFor('localhost'), other.paths.caFile, 'localhost'), {
    code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  })
})

// ---------------------------------------------------------------- what is in them

test('leaf names the host and is a server certificate', (t) => {
  const ca = makeCa(t)
  const certificate = ca.leafFor('api.example.com')

  // The whole SAN: the name, and nothing besides
  assert.equal(certificate.subjectAltName, 'DNS:api.example.com')
  // What Node calls keyUsage is the extended key usage: serverAuth alone
  assert.deepEqual(certificate.keyUsage, ['1.3.6.1.5.5.7.3.1'])
  assert.equal(certificate.ca, false)
  // ca is false without a basicConstraints as well. The leaf has one, critical (01 01 ff), holding
  // an empty SEQUENCE (04 02 30 00): CA:FALSE is the default, which DER leaves out
  const extensions = extensionsOf(certificate).map(hex)
  assert.ok(extensions.includes('300c0603551d130101ff04023000'), extensions.join('\n'))
  assert.equal(certificate.issuer, ca.certificate().subject)
  assert.ok(certificate.checkIssued(ca.certificate()))
})

// A DNS entry holding an IP literal is not matched by anything
test('an IP host goes in the SAN as an IP', (t) => {
  const san = makeCa(t).leafFor('192.168.1.23').subjectAltName

  // The whole SAN: the address, and so no DNS entry
  assert.equal(san, 'IP Address:192.168.1.23')
})

// Anything longer than 398 days is rejected outright by Safari and Chrome
test('leaf validity stays within what devices accept', (t) => {
  const certificate = makeCa(t).leafFor('api.example.com')

  const lifetime = certificate.validToDate.getTime() - certificate.validFromDate.getTime()
  assert.ok(lifetime <= 398 * 86_400_000 + 10 * 60_000, `${lifetime} ms`)
  assert.ok(certificate.validToDate.getTime() > Date.now() + LEAF_VALIDITY_MS / 2)
})

test('the CA is a ten-year signing certificate', (t) => {
  const certificate = makeCa(t).certificate()

  assert.equal(certificate.ca, true)
  // Node reads no KeyUsage bits out, so this is the whole extension: keyUsage (06 03 55 1d 0f),
  // critical (01 01 ff), and a BIT STRING of one byte, its last bit unused (03 02 01 06), where
  // 0x06 is keyCertSign and cRLSign, and the top bit, digitalSignature, is not set
  const extensions = extensionsOf(certificate).map(hex)
  assert.ok(extensions.includes('300e0603551d0f0101ff040403020106'), extensions.join('\n'))
  const lifetime = certificate.validToDate.getTime() - certificate.validFromDate.getTime()
  assert.ok(lifetime >= CA_VALIDITY_MS, `${lifetime} ms`)
  // The name is what a device lists among its trusted certificates
  assert.match(certificate.subject, /^CN=tunnel CA /m)
})

// ---------------------------------------------------------------- the files

test(
  'the private key is readable by nobody else',
  { skip: process.platform === 'win32' && 'permission bits are a POSIX thing' },
  (t) => {
    const ca = makeCa(t)
    ca.ensure()

    const mode = statSync(ca.paths.caKeyFile).mode & 0o777
    assert.equal(mode, 0o600, mode.toString(8))
  },
)

// Constructing one next to the config manager must not create a CA on its own
test('nothing is written until the CA is used', (t) => {
  const paths = Paths.inOneDirectory(tmpDir(t))

  const authority = new CertificateAuthority(paths)

  assert.ok(!existsSync(paths.caFile))
  authority.ensure()
  assert.ok(existsSync(paths.caFile) && existsSync(paths.caKeyFile))
})

// Devices install the CA once; regenerating it on every start would undo that
test('a restart keeps the CA the devices trust', (t) => {
  const ca = makeCa(t)
  ca.ensure()
  const pem = readFileSync(ca.paths.caFile)

  const afterRestart = new CertificateAuthority(ca.paths)

  assert.equal(afterRestart.fingerprint(), ca.fingerprint())
  assert.deepEqual(readFileSync(afterRestart.paths.caFile), pem)
})

// ---------------------------------------------------------------- caching and reset

// Generating an RSA key per host would be felt on every CONNECT
test('every host shares one leaf key', (t) => {
  const ca = makeCa(t)
  const first = ca.leafFor('a.example.com').publicKey
  const second = ca.leafFor('b.example.com').publicKey

  assert.ok(first.equals(second))
})

test('a host is signed once', (t) => {
  const ca = makeCa(t)

  assert.equal(ca.leafFor('a.example.com'), ca.leafFor('a.example.com'))
  assert.equal(ca.tlsOptionsFor('a.example.com'), ca.tlsOptionsFor('a.example.com'))
  // Every connection to the host shares the one object, so it is frozen, and its ALPN list too:
  // no caller can change them for the others
  const options = ca.tlsOptionsFor('a.example.com')
  assert.ok(Object.isFrozen(options) && Object.isFrozen(options.ALPNProtocols))
})

test('reset invalidates everything signed by the old CA', async (t) => {
  const ca = makeCa(t)
  const oldLeaf = ca.leafFor('api.example.com')
  const oldPem = join(ca.paths.config_dir, 'old-ca.pem')
  writeFileSync(oldPem, readFileSync(ca.paths.caFile))
  const oldFingerprint = ca.fingerprint()

  ca.reset()

  assert.notEqual(ca.fingerprint(), oldFingerprint)
  assert.notEqual(ca.leafFor('api.example.com').serialNumber, oldLeaf.serialNumber)
  // A device that has not installed the new CA yet can no longer connect ...
  await assert.rejects(handshake(ca.tlsOptionsFor('localhost'), oldPem, 'localhost'), {
    code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  })
  // ... and one that has, can
  const { payload } = await handshake(ca.tlsOptionsFor('localhost'), ca.paths.caFile, 'localhost')
  assert.equal(payload, 'hello')
})

test('reset leaves the key file private', (t) => {
  const ca = makeCa(t)
  ca.ensure()
  chmodSync(ca.paths.caKeyFile, 0o644)

  ca.reset()

  const key = createPrivateKey(readFileSync(ca.paths.caKeyFile))
  assert.equal(key.asymmetricKeyDetails?.modulusLength, 2048)
  if (process.platform !== 'win32') {
    const mode = statSync(ca.paths.caKeyFile).mode & 0o777
    assert.equal(mode, 0o600, mode.toString(8))
  }
})

test('info reports the fingerprint, validity and paths', (t) => {
  const ca = makeCa(t)
  const info = ca.info()

  assert.equal(info.fingerprint, ca.fingerprint())
  assert.equal(info.ca_file, ca.paths.caFile)
  assert.equal(info.ca_key_file, ca.paths.caKeyFile)
  assert.ok(new Date(info.not_after) > new Date())
  assert.equal(new X509Certificate(ca.certificatePem()).subject, ca.certificate().subject)
})

// ---------------------------------------------------------------- against the fixtures

test('reads the fixture CA: info() and certificatePem() say what info.json and ca.pem say', (t) => {
  const ca = fixtureCa(t)

  const { ca_file, ca_key_file, ...info } = ca.info()

  // The subject, the fingerprint devices show and both times, character for character
  assert.deepEqual(info, fixtureInfo)
  assert.equal(ca_file, ca.paths.caFile)
  assert.equal(ca_key_file, ca.paths.caKeyFile)
  // In this key order, which JSON keeps
  assert.deepEqual(Object.keys(ca.info()), [
    'subject',
    'fingerprint',
    'not_before',
    'not_after',
    'ca_file',
    'ca_key_file',
  ])
  // What a device downloads is the fixture's ca.pem, byte for byte
  assert.deepEqual(ca.certificatePem(), fixture('ca.pem'))
  // Read once and kept: the same certificate every time
  assert.equal(ca.certificate(), ca.certificate())

  // Serialised anew rather than read back: a ca.pem written another way loads all the same, and
  // comes out as the fixture's
  const pem = fixture('ca.pem').toString('utf8')
  for (const [way, content] of [
    // as a Windows checkout would have it
    ['with CRLF line ends', pem.replaceAll('\n', '\r\n')],
    // as openssl pkcs12 -nokeys writes one
    ['with text before BEGIN', `Bag Attributes\n    friendlyName: tunnel CA\n${pem}`],
    // the first is the CA
    ['with a second certificate after it', pem + fixture('leaf-dns.pem').toString('utf8')],
    ['in DER', new X509Certificate(pem).raw],
  ] as const) {
    const other = fixtureCa(t)
    writeFileSync(other.paths.caFile, content)
    assert.equal(other.fingerprint(), fixtureInfo.fingerprint, way)
    assert.deepEqual(other.certificatePem(), fixture('ca.pem'), way)
  }
})

test('keeps signing with the fixture CA: a client trusting only that ca.pem connects', async (t) => {
  const ca = fixtureCa(t)
  // The client trusts the fixture's ca.pem, as every device that installed it does: not the copy
  // in the config directory, which a CA made here in its place would have written over
  const trusted = new URL('./fixtures/certs/ca.pem', import.meta.url)

  for (const host of ['api.example.com', '192.168.1.23']) {
    const { alpn, payload } = await handshake(ca.tlsOptionsFor(host), trusted, host)

    assert.equal(payload, 'hello', host)
    assert.equal(alpn, 'http/1.1', host)
  }
})

test('leaves match the fixture leaves byte for byte but for serial, validity, key and signature', (t) => {
  const ca = fixtureCa(t)
  const authority = ca.certificate()
  const lifetime = (of: X509Certificate) => of.validToDate.getTime() - of.validFromDate.getTime()
  const serials = new Set<string>()

  for (const [host, file] of [
    ['api.example.com', 'leaf-dns.pem'],
    ['192.168.1.23', 'leaf-ipv4.pem'],
    ['::1', 'leaf-ipv6.pem'],
    // A CN cut to 64 characters, and the whole name in the SAN
    [`${'x'.repeat(90)}.example.com`, 'leaf-long.pem'],
  ] as const) {
    const leaf = ca.leafFor(host)
    const fixtureLeaf = new X509Certificate(fixture(file))
    const fields = tbsFields(leaf.raw)
    const fixtureFields = tbsFields(fixtureLeaf.raw)

    // v3, sha256WithRSAEncryption, the CA's subject as issuer, the host as CN, and the extensions:
    // their order, their critical flags and their values
    for (const field of ['version', 'signature', 'issuer', 'subject', 'extensions'] as const) {
      assert.equal(hex(fields[field]), hex(fixtureFields[field]), `${host}: ${field}`)
    }
    // Valid as long as the fixture leaf: 398 days, and the 5 minutes notBefore is back-dated by.
    // And with a key as large
    assert.equal(lifetime(leaf), LEAF_VALIDITY_MS + CLOCK_SKEW_MS, host)
    assert.equal(lifetime(leaf), lifetime(fixtureLeaf), host)
    assert.deepEqual(
      leaf.publicKey.asymmetricKeyDetails,
      fixtureLeaf.publicKey.asymmetricKeyDetails,
      host,
    )
    // Signed with the key of the fixture CA, which the devices that installed it trust
    assert.ok(leaf.checkIssued(authority), host)
    assert.ok(leaf.verify(authority.publicKey), host)
    serials.add(leaf.serialNumber)
  }
  // A serial of its own for each: a client may refuse two certificates from one issuer that share
  // a serial
  assert.equal(serials.size, 4)
})

test('a CA made here has the structure of the fixture CA', (t) => {
  const ca = makeCa(t)
  const certificate = ca.certificate()
  const fixtureCertificate = new X509Certificate(fixture('ca.pem'))
  const fields = tbsFields(certificate.raw)
  const fixtureFields = tbsFields(fixtureCertificate.raw)

  // v3, signed with sha256WithRSAEncryption
  assert.equal(hex(fields.version), hex(fixtureFields.version))
  assert.equal(hex(fields.signature), hex(fixtureFields.signature))
  // O and CN, and its own issuer. notBefore is back-dated by the clock skew, so adding that back
  // gives the second it was made, and so the day in its name
  const madeAt = new Date(certificate.validFromDate.getTime() + CLOCK_SKEW_MS)
  const subject = name([
    [OID.organizationName, 'tunnel'],
    [OID.commonName, caCommonName(hostname(), madeAt)],
  ])
  assert.equal(hex(fields.subject), hex(subject))
  assert.equal(hex(fields.issuer), hex(subject))
  // basicConstraints and keyUsage as in the fixture CA, then the SKI, which goes with the key
  assert.deepEqual(extensionsOf(certificate).map(hex), [
    ...extensionsOf(fixtureCertificate).slice(0, 2).map(hex),
    hex(
      extension(OID.subjectKeyIdentifier, false, octetString(keyIdentifier(certificate.publicKey))),
    ),
  ])
  // As long-lived as the fixture CA, and with a key as large: KEY_SIZE bits, which signed it
  const lifetime = (of: X509Certificate) => of.validToDate.getTime() - of.validFromDate.getTime()
  assert.equal(lifetime(certificate), CA_VALIDITY_MS + CLOCK_SKEW_MS)
  assert.equal(lifetime(certificate), lifetime(fixtureCertificate))
  assert.deepEqual(
    certificate.publicKey.asymmetricKeyDetails,
    fixtureCertificate.publicKey.asymmetricKeyDetails,
  )
  assert.equal(certificate.publicKey.asymmetricKeyDetails?.modulusLength, KEY_SIZE)
  assert.ok(certificate.verify(certificate.publicKey))

  // Both files: the certificate in PEM, and its key in PKCS#8 PEM, unencrypted
  assert.equal(readFileSync(ca.paths.caFile, 'utf8'), certificate.toString())
  const key = readFileSync(ca.paths.caKeyFile, 'utf8')
  assert.ok(key.startsWith('-----BEGIN PRIVATE KEY-----\n'), key.slice(0, 40))
  assert.equal(key, createPrivateKey(key).export({ type: 'pkcs8', format: 'pem' }))
  assert.ok(certificate.checkPrivateKey(createPrivateKey(key)))
})

test('using a CA leaves both files as they were: ensure, warm, leafFor, info', (t) => {
  const ca = fixtureCa(t)
  const before = snapshot(ca.paths)

  for (const [call, use] of [
    ['ensure', () => ca.ensure()],
    ['warm', () => ca.warm()],
    ['leafFor', () => ca.leafFor('api.example.com')],
    ['info', () => ca.info()],
  ] as const) {
    use()
    assert.deepEqual(snapshot(ca.paths), before, call)
  }
})

test('a PKCS#1 key loads as well', (t) => {
  const ca = fixtureCa(t)
  // The same key in the form for RSA alone, which `openssl genrsa` wrote before OpenSSL 3
  const pkcs1 = String(
    createPrivateKey(fixture('ca-key.pem')).export({ type: 'pkcs1', format: 'pem' }),
  )
  assert.ok(pkcs1.startsWith('-----BEGIN RSA PRIVATE KEY-----\n'), pkcs1.slice(0, 40))
  writeFileSync(ca.paths.caKeyFile, pkcs1)

  assert.equal(ca.fingerprint(), fixtureInfo.fingerprint)
  assert.ok(ca.leafFor('api.example.com').verify(ca.certificate().publicKey))
  // and the key is left in its form
  assert.equal(readFileSync(ca.paths.caKeyFile, 'utf8'), pkcs1)
})

// ---------------------------------------------------------------- files and errors

test('with only one of the two files, a new pair is made', (t) => {
  for (const kept of ['ca.pem', 'ca-key.pem']) {
    const dir = tmpDir(t)
    const path = join(dir, kept)
    writeFileSync(path, fixture(kept))
    // Readable by all, so that the key written over it has to make it private again
    chmodSync(path, 0o644)
    const ca = new CertificateAuthority(Paths.inOneDirectory(dir))

    ca.ensure()

    assert.notEqual(ca.fingerprint(), fixtureInfo.fingerprint, kept)
    assert.notDeepEqual(readFileSync(ca.paths.caFile), fixture('ca.pem'), kept)
    assert.notDeepEqual(readFileSync(ca.paths.caKeyFile), fixture('ca-key.pem'), kept)
    // The two files hold the new CA, and its key
    const written = new X509Certificate(readFileSync(ca.paths.caFile))
    assert.equal(written.fingerprint256, ca.fingerprint(), kept)
    assert.ok(written.checkPrivateKey(createPrivateKey(readFileSync(ca.paths.caKeyFile))), kept)
    if (process.platform !== 'win32') {
      assert.equal(statSync(ca.paths.caKeyFile).mode & 0o777, 0o600, kept)
    }
  }
})

test('a damaged CA stops ensure() and is left as it was', (t) => {
  const encrypted = createPrivateKey(fixture('ca-key.pem')).export({
    type: 'pkcs8',
    format: 'pem',
    cipher: 'aes-256-cbc',
    passphrase: 'x',
  })
  for (const [label, file, content] of [
    ['a ca.pem that is not PEM', 'ca.pem', 'not a certificate\n'],
    ['an empty ca-key.pem', 'ca-key.pem', ''],
    ['a ca-key.pem with a passphrase', 'ca-key.pem', encrypted],
    // Two certificates X509Certificate takes, but no leaf can be made from. One whose
    // TBSCertificate has BER's indefinite length, 30 80 … 00 00, which DER does not allow, so the
    // subject cannot be cut out of it
    [
      'a ca.pem in BER',
      'ca.pem',
      rebuildFixtureCa((fields) =>
        Buffer.concat([Buffer.from([0x30, 0x80]), ...fields, Buffer.from([0, 0])]),
      ),
    ],
    // And one for a key of an algorithm OpenSSL does not know, from the arc kept for examples
    [
      'a ca.pem for a key OpenSSL does not know',
      'ca.pem',
      fixtureCaFor(sequence(sequence(objectIdentifier('2.999.1')), bitString(Buffer.from([1])))),
    ],
  ] as const) {
    const ca = fixtureCa(t)
    const path = join(ca.paths.config_dir, file)
    writeFileSync(path, content)
    const before = snapshot(ca.paths)

    assert.throws(
      () => ca.ensure(),
      (error: unknown) => {
        // A plain Error, not a UserError: the caller passed nothing wrong
        assert.ok(error instanceof Error && error.name === 'Error', label)
        const { message } = error
        const start = `Could not load the CA in ${ca.paths.config_dir}: ${file}: `
        const end = '. `tunnel ca reset` makes a new one, which every device then has to install.'
        assert.ok(message.startsWith(start) && message.endsWith(end), `${label}: ${message}`)
        // and between the two, what Node said
        assert.notEqual(message.slice(start.length, -end.length), '', `${label}: ${message}`)
        return true
      },
    )
    assert.deepEqual(snapshot(ca.paths), before, label)

    // The failure is not remembered: with the fixture's file back, the next call loads it
    writeFileSync(path, fixture(file))
    assert.equal(ca.fingerprint(), fixtureInfo.fingerprint, label)
  }
})

test(
  'a CA file that cannot be read stops ensure() as well',
  // root reads a file whatever its mode, and Windows has no permission bits
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  (t) => {
    // Such as the key a `sudo tunnel serve` wrote: root's, and private to it
    const ca = fixtureCa(t)
    chmodSync(ca.paths.caKeyFile, 0o000)

    assert.throws(() => ca.ensure(), {
      name: 'Error',
      message:
        `Could not load the CA in ${ca.paths.config_dir}: ca-key.pem: EACCES: permission denied, ` +
        `open '${ca.paths.caKeyFile}'. \`tunnel ca reset\` makes a new one, which every device ` +
        'then has to install.',
    })
    // Left as it was, and loaded once it can be read
    assert.equal(statSync(ca.paths.caKeyFile).mode & 0o777, 0)
    chmodSync(ca.paths.caKeyFile, 0o600)
    assert.equal(ca.fingerprint(), fixtureInfo.fingerprint)
  },
)

test('a key that is not RSA is refused', (t) => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  for (const [file, content] of [
    ['ca-key.pem', privateKey.export({ type: 'pkcs8', format: 'pem' })],
    // A certificate for the EC key, beside the fixture's RSA key: the certificate's key is the one
    // devices check the leaves with, so it has to be RSA as well
    ['ca.pem', fixtureCaFor(publicKey.export({ type: 'spki', format: 'der' }))],
  ] as const) {
    const ca = fixtureCa(t)
    writeFileSync(join(ca.paths.config_dir, file), content)
    const before = snapshot(ca.paths)

    assert.throws(
      () => ca.ensure(),
      {
        name: 'Error',
        message:
          `Could not load the CA in ${ca.paths.config_dir}: ${file} holds an ec key, and tunnel ` +
          'signs with RSA keys only. `tunnel ca reset` makes a new one, which every device then ' +
          'has to install.',
      },
      file,
    )
    assert.deepEqual(snapshot(ca.paths), before, file)
  }
})

// Nothing checks that the key goes with the certificate: a CA whose ca-key.pem was replaced signs
// on, and no device takes what it signs
test('a key that does not go with the certificate is loaded, and signs all the same', (t) => {
  const ca = fixtureCa(t)
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: KEY_SIZE })
  writeFileSync(ca.paths.caKeyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const before = snapshot(ca.paths)

  const leaf = ca.leafFor('api.example.com')

  assert.equal(ca.fingerprint(), fixtureInfo.fingerprint)
  // It names the fixture CA as its issuer, but the key in ca-key.pem signed it
  assert.equal(leaf.issuer, ca.certificate().subject)
  assert.ok(!leaf.verify(ca.certificate().publicKey))
  assert.ok(leaf.verify(publicKey))
  assert.deepEqual(snapshot(ca.paths), before)
})

test('reset() works when both files are damaged', async (t) => {
  const ca = makeCa(t)
  writeFileSync(ca.paths.caFile, 'not a certificate\n')
  writeFileSync(ca.paths.caKeyFile, 'not a key\n')
  // What ensure() stops at, and the way out it names
  assert.throws(() => ca.ensure(), {
    message: /^Could not load the CA in .*`tunnel ca reset` makes a new one/,
  })

  ca.reset()

  // It signs, and a client that installed the new ca.pem connects
  assert.ok(ca.leafFor('api.example.com').verify(ca.certificate().publicKey))
  const { payload } = await handshake(ca.tlsOptionsFor('localhost'), ca.paths.caFile, 'localhost')
  assert.equal(payload, 'hello')
  // Both files are whole again: a restart loads the new CA
  assert.equal(new CertificateAuthority(ca.paths).fingerprint(), ca.fingerprint())
})

test('making a CA logs where it went; loading one logs nothing', (t) => {
  const logs = captureLogs(t)
  // A directory that is not there yet, which making the CA makes
  const ca = new CertificateAuthority(Paths.inOneDirectory(join(tmpDir(t), 'config')))

  ca.ensure()
  assert.equal(logs.text(), `INFO:tunnel.certs:Generated a new CA in ${ca.paths.config_dir}`)

  new CertificateAuthority(ca.paths).ensure()
  assert.equal(logs.records.length, 1)
})

// ---------------------------------------------------------------- names

test('caCommonName: the date in UTC, and at most 64 UTF-8 bytes without cutting a character', () => {
  // UTC's date, in whatever time zone this runs: a second before midnight, and a second after
  assert.equal(caCommonName('box', new Date('2026-10-11T23:59:59Z')), 'tunnel CA box 2026-10-11')
  assert.equal(caCommonName('box', new Date('2026-10-11T00:00:01Z')), 'tunnel CA box 2026-10-11')

  const now = new Date('2026-10-11T23:59:59Z')
  // 'tunnel CA ' and ' 2026-10-11' take 21 bytes, which leaves 43 for the host name
  const fits = 'h'.repeat(43)
  assert.equal(caCommonName(fits, now), `tunnel CA ${fits} 2026-10-11`)
  const cut = caCommonName('h'.repeat(60), now)
  assert.equal(cut, `tunnel CA ${fits} 2026-10-11`)
  assert.equal(Buffer.byteLength(cut), 64)
  // é takes 2 bytes: 21 of them are 42, and a 22nd would not fit
  const accented = caCommonName('é'.repeat(40), now)
  assert.equal(accented, `tunnel CA ${'é'.repeat(21)} 2026-10-11`)
  assert.equal(Buffer.byteLength(accented), 63)
  // A character past U+FFFF takes 4 bytes and two UTF-16 code units, and is not split either
  const astral = caCommonName(`ab${'😀'.repeat(20)}`, now)
  assert.equal(astral, `tunnel CA ab${'😀'.repeat(10)} 2026-10-11`)
  assert.equal(Buffer.byteLength(astral), 63)
})

test('an empty host or a non-ASCII name is refused, and the refusal is not cached', (t) => {
  const ca = makeCa(t)

  // Twice over: a refusal is not kept, as a certificate would be
  for (const round of ['first', 'second']) {
    assert.throws(
      () => ca.leafFor(''),
      { name: 'Error', message: 'Cannot issue a certificate for an empty host' },
      `${round} round`,
    )
    assert.throws(
      () => ca.leafFor('bücher.de'),
      {
        name: 'Error',
        message:
          'Cannot issue a certificate for "bücher.de": a DNS name has to be ASCII ' +
          '(an internationalised name goes in its xn-- form)',
      },
      `${round} round`,
    )
    // The TLS options are built from the leaf, and refused with it
    assert.throws(
      () => ca.tlsOptionsFor('bücher.de'),
      {
        name: 'Error',
        message:
          'Cannot issue a certificate for "bücher.de": a DNS name has to be ASCII ' +
          '(an internationalised name goes in its xn-- form)',
      },
      `${round} round`,
    )
  }
  // Refused before the CA is loaded or made
  assert.ok(!existsSync(ca.paths.caFile))
  // The form the refusal points to is signed
  assert.equal(ca.leafFor('xn--bcher-kva.de').subjectAltName, 'DNS:xn--bcher-kva.de')
})

// ---------------------------------------------------------------- caches and reset

test('reset() empties both caches; the new leaves come from the new CA', (t) => {
  const ca = makeCa(t)
  const host = 'api.example.com'
  const oldCa = ca.certificate()
  const oldLeaf = ca.leafFor(host)
  const oldOptions = ca.tlsOptionsFor(host)

  const newCa = ca.reset()

  // It returns the CA now in use
  assert.equal(newCa, ca.certificate())
  const newLeaf = ca.leafFor(host)
  const newOptions = ca.tlsOptionsFor(host)
  assert.notEqual(newLeaf, oldLeaf)
  assert.notEqual(newOptions, oldOptions)
  // The two CAs have one name, made on one machine on one day: the authority key identifier is
  // what tells the issuer apart
  assert.ok(newLeaf.checkIssued(newCa))
  assert.ok(!newLeaf.checkIssued(oldCa))

  // A reset that fails, here because ca.pem cannot be written, throws and leaves the CA in use as
  // it was. Both caches are emptied all the same, as reset() clears them first
  rmSync(ca.paths.caFile)
  mkdirSync(ca.paths.caFile)
  assert.throws(() => ca.reset(), { path: ca.paths.caFile })
  assert.equal(ca.certificate(), newCa)
  assert.notEqual(ca.leafFor(host), newLeaf)
  assert.notEqual(ca.tlsOptionsFor(host), newOptions)
  assert.ok(ca.leafFor(host).checkIssued(newCa))
})

test('the leaf key outlives reset()', (t) => {
  const ca = makeCa(t)
  const before = ca.leafFor('api.example.com')

  ca.reset()

  const after = ca.leafFor('api.example.com')
  // A certificate of its own, from the new CA, for the key the old one was issued for
  assert.notEqual(after, before)
  assert.ok(after.publicKey.equals(before.publicKey))
})

test('info() writes both times in ISO 8601: whole seconds and +00:00', (t) => {
  const ca = makeCa(t)

  const { not_before, not_after } = ca.info()

  for (const value of [not_before, not_after]) {
    assert.match(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/)
  }
  // and they are the certificate's
  assert.equal(new Date(not_before).getTime(), ca.certificate().validFromDate.getTime())
  assert.equal(new Date(not_after).getTime(), ca.certificate().validToDate.getTime())
})

// ---------------------------------------------------------------- the handshake helper

// handshake() fails a handshake that never ends rather than wait for it. It has to close both
// ends then as well: a socket left open would keep this file's process running after the
// failure, and npm test with it
test('a handshake that never ends fails in time, and leaves no socket open', async (t) => {
  const ca = makeCa(t)
  // A server whose SNICallback never calls back never answers the client's hello. handshake()
  // spreads the callback into the server's TLSSocket along with the rest
  const stalled = { ...ca.tlsOptionsFor('localhost'), SNICallback: () => {} }

  await assert.rejects(
    handshake(stalled, ca.paths.caFile, 'localhost', undefined, undefined, 200),
    {
      message: 'no end to the handshake for localhost in 0.2 s',
    },
  )
  // A socket takes a turn or two of the event loop to close
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(
    process.getActiveResourcesInfo().filter((resource) => resource.startsWith('TCP')),
    [],
  )
})
