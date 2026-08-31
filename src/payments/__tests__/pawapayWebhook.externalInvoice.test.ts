import { describe, it, expect, vi, beforeEach } from 'vitest'

const { invoiceDocs, partners, markPaidMock, markFailedMock } = vi.hoisted(() => ({
  invoiceDocs: [] as Array<{ id: string; data: () => Record<string, unknown>; ref: unknown }>,
  partners: {} as Record<string, Record<string, unknown> | undefined>,
  markPaidMock: vi.fn(),
  markFailedMock: vi.fn(),
}))

vi.mock('../../lib/admin', () => ({
  admin: { firestore: { FieldValue: { increment: vi.fn() } } },
  db: {
    collection: (name: string) => {
      if (name === 'external_invoices') {
        return {
          where: () => ({
            limit: () => ({
              get: async () => ({ empty: invoiceDocs.length === 0, docs: invoiceDocs }),
            }),
          }),
        }
      }
      if (name === 'partners') {
        return { doc: (id: string) => ({ get: async () => ({ data: () => partners[id] }) }) }
      }
      throw new Error(`unexpected collection ${name}`)
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
  markExternalInvoicePaid: markPaidMock,
  markExternalInvoiceFailed: markFailedMock,
}))

import { pawapayWebhook } from '../pawapayWebhook'

type Handler = (req: unknown, res: unknown) => Promise<void>

function fakeRes() {
  const res = { statusCode: 0, body: undefined as unknown, status(c: number) { this.statusCode = c; return this }, send(b: unknown) { this.body = b }, json(b: unknown) { this.body = b } }
  return res
}

describe('pawapayWebhook — external_invoice completion, merchantUid resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invoiceDocs.length = 0
    for (const k of Object.keys(partners)) delete partners[k]
  })

  it('reads merchantUid directly from the invoice (in-app / SDP-03 payment, no partner)', async () => {
    invoiceDocs.push({
      id: 'inv1',
      data: () => ({ partnerId: null, merchantUid: 'merchant-direct', amountUsd: 10 }),
      ref: {},
    })
    const req = { headers: {}, body: { depositId: 'dep1', status: 'COMPLETED' } }
    const res = fakeRes()
    await (pawapayWebhook as unknown as Handler)(req, res)
    expect(markPaidMock).toHaveBeenCalledWith(expect.objectContaining({ merchantUid: 'merchant-direct', partnerId: null }))
    expect(res.statusCode).toBe(200)
  })

  it('falls back to a partner-doc lookup when merchantUid is not yet on the invoice', async () => {
    invoiceDocs.push({
      id: 'inv2',
      data: () => ({ partnerId: 'arom', amountUsd: 10 }), // no merchantUid — pre-SDP-03 checkout
      ref: {},
    })
    partners['arom'] = { merchantUid: 'merchant-from-partner' }
    const req = { headers: {}, body: { depositId: 'dep2', status: 'COMPLETED' } }
    const res = fakeRes()
    await (pawapayWebhook as unknown as Handler)(req, res)
    expect(markPaidMock).toHaveBeenCalledWith(expect.objectContaining({ merchantUid: 'merchant-from-partner', partnerId: 'arom' }))
  })

  it('fails closed (200, no payment marked) when no merchantUid is resolvable at all', async () => {
    invoiceDocs.push({
      id: 'inv3',
      data: () => ({ partnerId: null, amountUsd: 10 }), // no merchantUid, no partnerId to fall back to
      ref: {},
    })
    const req = { headers: {}, body: { depositId: 'dep3', status: 'COMPLETED' } }
    const res = fakeRes()
    await (pawapayWebhook as unknown as Handler)(req, res)
    expect(markPaidMock).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(200)
  })
})
