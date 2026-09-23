import { describe, it, expect, vi, beforeEach } from 'vitest'

const { verifyMock } = vi.hoisted(() => ({ verifyMock: vi.fn() }))

vi.mock('../verifyPawapayCallbackSignature', () => ({
  verifyPawapayCallbackSignature: verifyMock,
}))

vi.mock('../../lib/admin', () => ({
  admin: { firestore: { FieldValue: { increment: vi.fn(), serverTimestamp: vi.fn() } } },
  db: {
    collection: () => {
      throw new Error('BUSINESS_LOGIC_REACHED')
    },
  },
  functions: {
    region: vi.fn(() => ({ https: { onRequest: vi.fn((h: unknown) => h) } })),
    logger: { error: vi.fn() },
  },
}))

import { pawapayRefundWebhook } from '../pawapayRefundWebhook'

type Handler = (req: unknown, res: unknown) => Promise<void>

function fakeRes() {
  const res = { statusCode: 0, body: undefined as unknown, status(c: number) { this.statusCode = c; return this }, send(b: unknown) { this.body = b } }
  return res
}

function fakeReq(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    path: '/pawapayRefundWebhook',
    headers: { host: 'europe-west1-mombongo-dev.cloudfunctions.net' },
    body: { refundId: 'ref1', depositId: 'dep1', status: 'COMPLETED' },
    rawBody: Buffer.from(JSON.stringify({ refundId: 'ref1', depositId: 'dep1', status: 'COMPLETED' })),
    ...overrides,
  }
}

describe('pawapayRefundWebhook — RFC 9421 signature enforcement', () => {
  beforeEach(() => verifyMock.mockReset())

  it('rejects the request when verification fails, never reaching business logic', async () => {
    verifyMock.mockResolvedValue(false)
    const res = fakeRes()
    await (pawapayRefundWebhook as unknown as Handler)(fakeReq(), res)
    expect(res.statusCode).toBe(401)
  })

  it('passes the raw body Buffer, not JSON.stringify(req.body), to the verifier', async () => {
    verifyMock.mockResolvedValue(false)
    const req = fakeReq()
    await (pawapayRefundWebhook as unknown as Handler)(req, fakeRes())
    expect(verifyMock).toHaveBeenCalledWith(expect.objectContaining({ rawBody: req.rawBody }))
  })

  it('proceeds to business logic once verification succeeds', async () => {
    verifyMock.mockResolvedValue(true)
    await expect((pawapayRefundWebhook as unknown as Handler)(fakeReq(), fakeRes())).rejects.toThrow('BUSINESS_LOGIC_REACHED')
  })
})
