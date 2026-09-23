import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../lib/admin', () => ({
  admin: { firestore: { FieldValue: { increment: vi.fn() } } },
  db: {
    collection: () => {
      throw new Error('business logic must not run when signature verification fails')
    },
  },
  functions: {
    runWith: vi.fn(() => ({
      region: vi.fn(() => ({ https: { onRequest: vi.fn((h: unknown) => h) } })),
    })),
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

const ORIGINAL_SECRET = process.env.PAWAPAY_WEBHOOK_SECRET

describe('pawapayWebhook — signature enforcement (fail closed, real wiring)', () => {
  beforeEach(() => {
    process.env.PAWAPAY_WEBHOOK_SECRET = 'real-secret'
  })
  afterEach(() => {
    process.env.PAWAPAY_WEBHOOK_SECRET = ORIGINAL_SECRET
  })

  it('rejects a request with no signature header at all, never reaching business logic', async () => {
    const req = { headers: {}, body: { depositId: 'dep1', status: 'COMPLETED' } }
    const res = fakeRes()
    await (pawapayWebhook as unknown as Handler)(req, res)
    expect(res.statusCode).toBe(401)
  })

  it('rejects a request with an incorrect signature', async () => {
    const req = { headers: { 'x-pawapay-signature': 'not-the-right-hmac' }, body: { depositId: 'dep1', status: 'COMPLETED' } }
    const res = fakeRes()
    await (pawapayWebhook as unknown as Handler)(req, res)
    expect(res.statusCode).toBe(401)
  })

  it('rejects even when the webhook secret is unset, regardless of signature header', async () => {
    delete process.env.PAWAPAY_WEBHOOK_SECRET
    const req = { headers: { 'x-pawapay-signature': 'anything' }, body: { depositId: 'dep1', status: 'COMPLETED' } }
    const res = fakeRes()
    await (pawapayWebhook as unknown as Handler)(req, res)
    expect(res.statusCode).toBe(401)
  })
})
