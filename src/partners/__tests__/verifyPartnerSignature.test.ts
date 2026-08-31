import * as crypto from 'crypto'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock ../../lib/admin so Firebase is never initialised during unit tests
// — mirrors pawapayWebhook.test.ts's mocking shape.
const getMock = vi.fn()
vi.mock('../../lib/admin', () => ({
  admin: { firestore: vi.fn() },
  db: {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({ get: getMock })),
    })),
  },
  functions: {
    region: vi.fn(() => ({
      https: { onRequest: vi.fn((h: unknown) => h) },
    })),
    https: {
      HttpsError: class extends Error {
        constructor(public code: string, msg: string) { super(msg) }
      },
    },
  },
}))

import { verifyPartnerSignature } from '../verifyPartnerSignature'

const SECRET = 'test-partner-secret-abc123'
const BODY = Buffer.from(JSON.stringify({ externalInvoiceId: 'inv-001', amountUsd: 100, currency: 'USD' }))

function makeHmac(secret: string, body: Buffer): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex')
}

function mockPartner(data: Record<string, unknown> | null) {
  getMock.mockResolvedValue({
    exists: data !== null,
    data: () => data ?? undefined,
  })
}

describe('verifyPartnerSignature — SAI-01 fail-closed HMAC guard', () => {
  beforeEach(() => {
    getMock.mockReset()
  })

  it('returns true for a correctly-signed request from a registered, active partner', async () => {
    mockPartner({ active: true, hmacSecret: SECRET })
    const sig = makeHmac(SECRET, BODY)
    expect(await verifyPartnerSignature('arom', BODY, sig)).toBe(true)
  })

  it('returns false when partnerId is missing', async () => {
    expect(await verifyPartnerSignature(undefined, BODY, 'any-sig')).toBe(false)
    expect(getMock).not.toHaveBeenCalled()
  })

  it('returns false when rawBody is missing (e.g. req.rawBody unavailable)', async () => {
    mockPartner({ active: true, hmacSecret: SECRET })
    expect(await verifyPartnerSignature('arom', undefined, 'any-sig')).toBe(false)
  })

  it('returns false when the signature header is missing', async () => {
    expect(await verifyPartnerSignature('arom', BODY, undefined)).toBe(false)
  })

  it('returns false for an unknown partnerId (doc does not exist)', async () => {
    mockPartner(null)
    const sig = makeHmac(SECRET, BODY)
    expect(await verifyPartnerSignature('unknown', BODY, sig)).toBe(false)
  })

  it('returns false for an inactive partner', async () => {
    mockPartner({ active: false, hmacSecret: SECRET })
    const sig = makeHmac(SECRET, BODY)
    expect(await verifyPartnerSignature('arom', BODY, sig)).toBe(false)
  })

  it('returns false when the partner has no hmacSecret configured — fail closed, not "allow"', async () => {
    mockPartner({ active: true })
    const sig = makeHmac(SECRET, BODY)
    expect(await verifyPartnerSignature('arom', BODY, sig)).toBe(false)
  })

  it('returns false for a wrong signature', async () => {
    mockPartner({ active: true, hmacSecret: SECRET })
    expect(await verifyPartnerSignature('arom', BODY, 'totally-wrong-signature')).toBe(false)
  })

  it('returns false when the body has been tampered with (valid sig for a different body)', async () => {
    mockPartner({ active: true, hmacSecret: SECRET })
    const sig = makeHmac(SECRET, BODY)
    const tamperedBody = Buffer.from(JSON.stringify({ externalInvoiceId: 'inv-001', amountUsd: 999, currency: 'USD' }))
    expect(await verifyPartnerSignature('arom', tamperedBody, sig)).toBe(false)
  })

  it('returns false for a valid signature computed with the wrong secret', async () => {
    mockPartner({ active: true, hmacSecret: SECRET })
    const wrongSig = makeHmac('wrong-secret', BODY)
    expect(await verifyPartnerSignature('arom', BODY, wrongSig)).toBe(false)
  })
})
