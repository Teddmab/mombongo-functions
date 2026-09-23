import * as crypto from 'crypto'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { getKeyMock } = vi.hoisted(() => ({ getKeyMock: vi.fn() }))
vi.mock('../pawapayPublicKeys', () => ({ getPawapayPublicKey: getKeyMock }))

import { verifyPawapayCallbackSignature } from '../verifyPawapayCallbackSignature'

const ecKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
const EC_PUBLIC_PEM = ecKeyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString()

const rsaKeyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const RSA_PUBLIC_PEM = rsaKeyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString()

const METHOD = 'POST'
const AUTHORITY = 'europe-west1-mombongo-dev.cloudfunctions.net'
const PATH = '/pawapayWebhook'
const BODY = Buffer.from(JSON.stringify({ depositId: 'dep1', status: 'COMPLETED' }))
const DEFAULT_COMPONENTS = ['@method', '@authority', '@path', 'signature-date', 'content-digest', 'content-type']

interface BuildOptions {
  created?: number
  expires?: number
  keyid?: string
  alg?: 'ecdsa-p256-sha256' | 'rsa-pss-sha512'
  bodyOverride?: Buffer
  tamperSignature?: boolean
  components?: string[]
}

/**
 * Constructs a request context + real, independently-signed RFC 9421
 * headers, following the spec directly (not by calling into the module
 * under test) — so a passing test is real evidence the implementation
 * agrees with the spec, not just with itself.
 */
function buildValidRequest(opts: BuildOptions = {}) {
  const now = Math.floor(Date.now() / 1000)
  const created = opts.created ?? now - 5
  const expires = opts.expires ?? now + 55
  const keyid = opts.keyid ?? 'HTTP_EC_P256_KEY:1'
  const alg = opts.alg ?? 'ecdsa-p256-sha256'
  const components = opts.components ?? DEFAULT_COMPONENTS
  const body = opts.bodyOverride ?? BODY

  const signatureDate = new Date(created * 1000).toISOString()
  const contentDigest = `sha-512=:${crypto.createHash('sha512').update(BODY).digest('base64')}:`
  const contentType = 'application/json'

  const headerValues: Record<string, string> = {
    '@method': METHOD,
    '@authority': AUTHORITY,
    '@path': PATH,
    'signature-date': signatureDate,
    'content-digest': contentDigest,
    'content-type': contentType,
  }

  const paramsValue = `(${components.map((c) => `"${c}"`).join(' ')});alg="${alg}";keyid="${keyid}";created=${created};expires=${expires}`
  const lines = components.map((name) => `"${name}": ${headerValues[name]}`)
  lines.push(`"@signature-params": ${paramsValue}`)
  const signatureBase = Buffer.from(lines.join('\n'), 'utf8')

  const sig = alg === 'rsa-pss-sha512'
    ? crypto.sign('sha512', signatureBase, { key: rsaKeyPair.privateKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST })
    : crypto.sign('sha256', signatureBase, { key: ecKeyPair.privateKey, dsaEncoding: 'ieee-p1363' })
  const sigBytes = opts.tamperSignature ? Buffer.alloc(sig.length, 0) : sig

  return {
    method: METHOD,
    authority: AUTHORITY,
    path: PATH,
    rawBody: body,
    headers: {
      'signature-input': `sig-pp=${paramsValue}`,
      signature: `sig-pp=:${sigBytes.toString('base64')}:`,
      'content-digest': contentDigest,
      'content-type': contentType,
      'signature-date': signatureDate,
    } as Record<string, string | undefined>,
  }
}

describe('verifyPawapayCallbackSignature', () => {
  beforeEach(() => {
    getKeyMock.mockReset()
    getKeyMock.mockResolvedValue(EC_PUBLIC_PEM)
  })

  it('accepts a correctly signed request', async () => {
    expect(await verifyPawapayCallbackSignature(buildValidRequest())).toBe(true)
  })

  it('accepts a correctly signed request using RSA-PSS-SHA512', async () => {
    getKeyMock.mockResolvedValue(RSA_PUBLIC_PEM)
    expect(await verifyPawapayCallbackSignature(buildValidRequest({ alg: 'rsa-pss-sha512', keyid: 'HTTP_RSA_KEY:1' }))).toBe(true)
  })

  it('rejects when rawBody is missing (fail closed, not fail open)', async () => {
    const req = buildValidRequest()
    expect(await verifyPawapayCallbackSignature({ ...req, rawBody: undefined })).toBe(false)
  })

  it('rejects when the Signature-Input header is missing', async () => {
    const req = buildValidRequest()
    delete req.headers['signature-input']
    expect(await verifyPawapayCallbackSignature(req)).toBe(false)
  })

  it('rejects when the Signature header is missing', async () => {
    const req = buildValidRequest()
    delete req.headers.signature
    expect(await verifyPawapayCallbackSignature(req)).toBe(false)
  })

  it('rejects when the Content-Digest header is missing', async () => {
    const req = buildValidRequest()
    delete req.headers['content-digest']
    expect(await verifyPawapayCallbackSignature(req)).toBe(false)
  })

  it('rejects a tampered body whose Content-Digest no longer matches the actual bytes (replay-with-different-body)', async () => {
    const req = buildValidRequest({ bodyOverride: Buffer.from(JSON.stringify({ depositId: 'dep1', status: 'FAILED' })) })
    expect(await verifyPawapayCallbackSignature(req)).toBe(false)
  })

  it('rejects a tampered signature', async () => {
    expect(await verifyPawapayCallbackSignature(buildValidRequest({ tamperSignature: true }))).toBe(false)
  })

  it('rejects a signature verified against the wrong public key', async () => {
    const otherKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
    getKeyMock.mockResolvedValue(otherKeyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString())
    expect(await verifyPawapayCallbackSignature(buildValidRequest())).toBe(false)
  })

  it('rejects an expired signature (past its expires timestamp, beyond clock-skew tolerance)', async () => {
    const now = Math.floor(Date.now() / 1000)
    expect(await verifyPawapayCallbackSignature(buildValidRequest({ created: now - 300, expires: now - 200 }))).toBe(false)
  })

  it('rejects a not-yet-valid signature (created far in the future, beyond clock-skew tolerance)', async () => {
    const now = Math.floor(Date.now() / 1000)
    expect(await verifyPawapayCallbackSignature(buildValidRequest({ created: now + 300, expires: now + 400 }))).toBe(false)
  })

  it('accepts a signature within the clock-skew tolerance window', async () => {
    const now = Math.floor(Date.now() / 1000)
    expect(await verifyPawapayCallbackSignature(buildValidRequest({ created: now - 65, expires: now - 50 }))).toBe(true)
  })

  it('rejects an unsupported algorithm identifier', async () => {
    expect(await verifyPawapayCallbackSignature(buildValidRequest({ alg: 'made-up-alg' as never }))).toBe(false)
  })

  it('rejects when a required covered component (content-digest) is missing from the signed set', async () => {
    const req = buildValidRequest({ components: ['@method', '@authority', '@path', 'signature-date', 'content-type'] })
    expect(await verifyPawapayCallbackSignature(req)).toBe(false)
  })

  it('rejects an unknown keyid the public-key endpoint has no record of', async () => {
    getKeyMock.mockResolvedValue(null)
    expect(await verifyPawapayCallbackSignature(buildValidRequest())).toBe(false)
  })

  it('looks up the key by keyid exactly once per verification — key rotation itself is handled inside getPawapayPublicKey (see pawapayPublicKeys.test.ts), not by retrying here', async () => {
    getKeyMock.mockResolvedValue(EC_PUBLIC_PEM)
    expect(await verifyPawapayCallbackSignature(buildValidRequest({ keyid: 'HTTP_EC_P256_KEY:2' }))).toBe(true)
    expect(getKeyMock).toHaveBeenCalledTimes(1)
    expect(getKeyMock).toHaveBeenCalledWith('HTTP_EC_P256_KEY:2')
  })

  it('rejects a malformed Signature-Input header instead of throwing', async () => {
    const req = buildValidRequest()
    req.headers['signature-input'] = 'not-a-valid-structured-field'
    expect(await verifyPawapayCallbackSignature(req)).toBe(false)
  })

  it('rejects a malformed Content-Digest header instead of throwing', async () => {
    const req = buildValidRequest()
    req.headers['content-digest'] = 'sha-512=not-valid-base64-wrapper'
    expect(await verifyPawapayCallbackSignature(req)).toBe(false)
  })
})
