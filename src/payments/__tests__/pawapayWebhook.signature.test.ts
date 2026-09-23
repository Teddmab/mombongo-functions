import { describe, it, expect, vi, beforeEach } from 'vitest'

const { verifyMock } = vi.hoisted(() => ({ verifyMock: vi.fn() }))

vi.mock('../verifyPawapayCallbackSignature', () => ({
  verifyPawapayCallbackSignature: verifyMock,
}))

vi.mock('../../lib/admin', () => ({
  admin: { firestore: { FieldValue: { increment: vi.fn() } } },
  db: {
    // Throws unconditionally so tests can detect "business logic was
    // reached" purely from this side effect, regardless of whether that's
    // the expected (verification failed) or unexpected (verification
    // succeeded) outcome for a given test.
    collection: () => {
      throw new Error('BUSINESS_LOGIC_REACHED')
    },
  },
  functions: {
    region: vi.fn(() => ({ https: { onRequest: vi.fn((h: unknown) => h) } })),
    logger: { error: vi.fn() },
  },
}))

vi.mock('../../partners/markExternalInvoicePaid', () => ({
  markExternalInvoicePaid: vi.fn(),
  markExternalInvoiceFailed: vi.fn(),
}))

import { pawapayWebhook } from '../pawapayWebhook'

type Handler = (req: unknown, res: unknown) => Promise<void>

function fakeRes() {
  const res = { statusCode: 0, body: undefined as unknown, status(c: number) { this.statusCode = c; return this }, send(b: unknown) { this.body = b }, json(b: unknown) { this.body = b } }
  return res
}

function fakeReq(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    path: '/pawapayWebhook',
    headers: { host: 'europe-west1-mombongo-dev.cloudfunctions.net' },
    body: { depositId: 'dep1', status: 'COMPLETED' },
    rawBody: Buffer.from(JSON.stringify({ depositId: 'dep1', status: 'COMPLETED' })),
    ...overrides,
  }
}

describe('pawapayWebhook — RFC 9421 signature enforcement (fail closed, real wiring)', () => {
  beforeEach(() => {
    verifyMock.mockReset()
  })

  it('rejects the request when verification fails, never reaching business logic', async () => {
    verifyMock.mockResolvedValue(false)
    const res = fakeRes()
    await (pawapayWebhook as unknown as Handler)(fakeReq(), res)
    expect(res.statusCode).toBe(401)
  })

  it('passes method, authority, path and the raw body Buffer to the verifier — not JSON.stringify(req.body)', async () => {
    verifyMock.mockResolvedValue(false)
    const req = fakeReq()
    await (pawapayWebhook as unknown as Handler)(req, fakeRes())
    expect(verifyMock).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      authority: 'europe-west1-mombongo-dev.cloudfunctions.net',
      path: '/pawapayWebhook',
      rawBody: req.rawBody,
    }))
  })

  it('rejects when rawBody is missing entirely (e.g. req.rawBody unavailable), never reaching business logic', async () => {
    verifyMock.mockResolvedValue(false)
    const res = fakeRes()
    await (pawapayWebhook as unknown as Handler)(fakeReq({ rawBody: undefined }), res)
    expect(res.statusCode).toBe(401)
  })

  it('proceeds to business logic once verification succeeds', async () => {
    verifyMock.mockResolvedValue(true)
    const res = fakeRes()
    await expect((pawapayWebhook as unknown as Handler)(fakeReq(), res)).rejects.toThrow('BUSINESS_LOGIC_REACHED')
  })
})
