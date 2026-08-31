import { describe, it, expect, vi, beforeEach } from 'vitest'

const { markPaidMock } = vi.hoisted(() => ({ markPaidMock: vi.fn() }))
vi.mock('../../partners/markExternalInvoicePaid', () => ({ markExternalInvoicePaid: markPaidMock }))

vi.mock('firebase-admin', () => ({
  firestore: Object.assign(
    vi.fn(() => ({ collection: () => ({ doc: (id: string) => ({ id }) }) })),
    { FieldValue: { serverTimestamp: vi.fn() } },
  ),
}))

vi.mock('firebase-functions', () => ({
  region: vi.fn(() => ({ https: { onRequest: vi.fn((h: unknown) => h) } })),
}))

let cannedEvent: { type: string; data: { object: Record<string, unknown> } }
vi.mock('stripe', () => ({
  default: class {
    webhooks = { constructEvent: () => cannedEvent }
  },
}))

import { stripeWebhook } from '../stripeWebhook'

type Handler = (req: unknown, res: unknown) => Promise<void>

function fakeRes() {
  const res = { statusCode: 0, body: undefined as unknown, status(c: number) { this.statusCode = c; return this }, send(b: unknown) { this.body = b } }
  return res
}

function paymentIntentEvent(metadata: Record<string, string>) {
  return {
    type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_1', amount: 5000, metadata } },
  }
}

describe('stripeWebhook — external_invoice completion, partnerId requirement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test'
    process.env.STRIPE_SECRET_KEY = 'sk_test'
  })

  it('marks an in-app (no partnerId) invoice paid — this is the bug this PR fixes', async () => {
    cannedEvent = paymentIntentEvent({ kind: 'external_invoice', invoiceId: 'inv1', merchantUid: 'm1' })
    const req = { headers: { 'stripe-signature': 'sig' }, body: {} }
    const res = fakeRes()
    await (stripeWebhook as unknown as Handler)(req, res)
    expect(markPaidMock).toHaveBeenCalledWith(
      expect.objectContaining({ merchantUid: 'm1', partnerId: null, amountUsd: 50 }),
    )
    expect(res.statusCode).toBe(200)
  })

  it('still marks a partner-originated invoice paid, with partnerId set', async () => {
    cannedEvent = paymentIntentEvent({ kind: 'external_invoice', invoiceId: 'inv2', merchantUid: 'm2', partnerId: 'arom' })
    const req = { headers: { 'stripe-signature': 'sig' }, body: {} }
    const res = fakeRes()
    await (stripeWebhook as unknown as Handler)(req, res)
    expect(markPaidMock).toHaveBeenCalledWith(
      expect.objectContaining({ merchantUid: 'm2', partnerId: 'arom' }),
    )
  })

  it('still fails closed when merchantUid itself is missing', async () => {
    cannedEvent = paymentIntentEvent({ kind: 'external_invoice', invoiceId: 'inv3' })
    const req = { headers: { 'stripe-signature': 'sig' }, body: {} }
    const res = fakeRes()
    await (stripeWebhook as unknown as Handler)(req, res)
    expect(markPaidMock).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(200)
  })
})
