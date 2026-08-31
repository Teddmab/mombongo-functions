import { describe, it, expect, vi, beforeEach } from 'vitest'

const invoices: Record<string, Record<string, unknown> | undefined> = {}

vi.mock('../../lib/admin', () => ({
  db: {
    collection: (name: string) => {
      if (name !== 'external_invoices') throw new Error(`unexpected collection ${name}`)
      return {
        doc: (id: string) => ({
          id,
          get: async () => ({ exists: invoices[id] !== undefined, data: () => invoices[id] }),
        }),
      }
    },
  },
  functions: {
    region: vi.fn(() => ({ https: { onCall: vi.fn((h: unknown) => h) } })),
    https: {
      HttpsError: class extends Error {
        constructor(public code: string, msg: string) { super(msg) }
      },
    },
  },
}))

const { coreMock } = vi.hoisted(() => ({ coreMock: vi.fn() }))
vi.mock('../../partners/createCheckoutForInvoiceCore', () => ({ createCheckoutForInvoiceCore: coreMock }))

import { payHarvestInvoice } from '../payHarvestInvoice'

type Handler = (data: unknown, context: { auth?: { uid: string } }) => Promise<unknown>

describe('payHarvestInvoice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const k of Object.keys(invoices)) delete invoices[k]
  })

  it('rejects an unauthenticated caller', async () => {
    await expect((payHarvestInvoice as unknown as Handler)({ invoiceId: 'i1', method: 'card' }, {})).rejects.toThrow('Login required')
  })

  it('rejects a missing invoice', async () => {
    await expect(
      (payHarvestInvoice as unknown as Handler)({ invoiceId: 'nope', method: 'card' }, { auth: { uid: 'm1' } }),
    ).rejects.toThrow('Invoice not found')
  })

  it("rejects paying someone else's invoice", async () => {
    invoices['i1'] = { merchantId: 'm2', status: 'pending', amountUsd: 10 }
    await expect(
      (payHarvestInvoice as unknown as Handler)({ invoiceId: 'i1', method: 'card' }, { auth: { uid: 'm1' } }),
    ).rejects.toThrow('Invoice not found')
  })

  it('rejects an invoice not in pending status', async () => {
    invoices['i1'] = { merchantId: 'm1', status: 'paid', amountUsd: 10 }
    await expect(
      (payHarvestInvoice as unknown as Handler)({ invoiceId: 'i1', method: 'card' }, { auth: { uid: 'm1' } }),
    ).rejects.toThrow('Already in progress or resolved')
  })

  it('calls createCheckoutForInvoiceCore with partnerId null and merchantUid = caller uid', async () => {
    invoices['i1'] = { merchantId: 'm1', status: 'pending', amountUsd: 10 }
    coreMock.mockResolvedValueOnce({ ok: true, providerRef: 'pi_1', responseBody: { clientSecret: 'x' } })
    const result = await (payHarvestInvoice as unknown as Handler)(
      { invoiceId: 'i1', method: 'card' },
      { auth: { uid: 'm1' } },
    )
    expect(result).toEqual({ status: 'checkout_created', providerRef: 'pi_1', clientSecret: 'x' })
    expect(coreMock).toHaveBeenCalledWith(expect.objectContaining({ merchantUid: 'm1', partnerId: null, method: 'card' }))
  })

  it('surfaces a missing_phone_operator core result as invalid-argument', async () => {
    invoices['i1'] = { merchantId: 'm1', status: 'pending', amountUsd: 10 }
    coreMock.mockResolvedValueOnce({ ok: false, kind: 'missing_phone_operator' })
    await expect(
      (payHarvestInvoice as unknown as Handler)({ invoiceId: 'i1', method: 'mobile_money' }, { auth: { uid: 'm1' } }),
    ).rejects.toThrow('phone and operator required')
  })

  it('surfaces a provider_error core result as internal', async () => {
    invoices['i1'] = { merchantId: 'm1', status: 'pending', amountUsd: 10 }
    coreMock.mockResolvedValueOnce({ ok: false, kind: 'provider_error', message: 'boom' })
    await expect(
      (payHarvestInvoice as unknown as Handler)({ invoiceId: 'i1', method: 'card' }, { auth: { uid: 'm1' } }),
    ).rejects.toThrow('boom')
  })
})
