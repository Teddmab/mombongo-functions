import { describe, it, expect, vi, beforeEach } from 'vitest'

const invoiceUpdateMock = vi.fn()
const invoices: Record<string, Record<string, unknown> | undefined> = {}
const offers: Record<string, Record<string, unknown> | undefined> = {}
const listings: Record<string, Record<string, unknown> | undefined> = {}
const partners: Record<string, Record<string, unknown> | undefined> = {}

vi.mock('../../lib/admin', () => ({
  db: {
    collection: (name: string) => {
      const store = { external_invoices: invoices, harvest_offers: offers, product_listings: listings, partners }[name]
      if (!store) throw new Error(`unexpected collection ${name}`)
      return {
        doc: (id: string) => ({
          get: async () => ({ exists: store[id] !== undefined, data: () => store[id], ref: { update: invoiceUpdateMock } }),
        }),
      }
    },
  },
  functions: { logger: { error: vi.fn() } },
}))
vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: vi.fn(() => 'SERVER_TIMESTAMP') } }))

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }))
vi.mock('../sendSignedPartnerWebhook', () => ({ sendSignedPartnerWebhook: sendMock }))

import { notifyPartnerInvoiceIssued } from '../notifyPartnerInvoiceIssued'

describe('notifyPartnerInvoiceIssued', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const s of [invoices, offers, listings, partners]) for (const k of Object.keys(s)) delete s[k]
  })

  it('does nothing when the invoice does not exist', async () => {
    await notifyPartnerInvoiceIssued('nope')
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('does nothing when the invoice has no partnerId', async () => {
    invoices['inv1'] = { partnerId: null, farmerId: 'f1', listingId: 'l1', offerId: 'o1', amountUsd: 10 }
    await notifyPartnerInvoiceIssued('inv1')
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('does nothing when the partner has no webhookUrl/outboundHmacSecret', async () => {
    invoices['inv1'] = { partnerId: 'arom', farmerId: 'f1', listingId: 'l1', offerId: 'o1', amountUsd: 10 }
    partners['arom'] = { name: 'AROM' }
    await notifyPartnerInvoiceIssued('inv1')
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('sends the invoice-issued payload with quantityKg/commodity from the offer and listing', async () => {
    invoices['inv1'] = { partnerId: 'arom', farmerId: 'f1', listingId: 'l1', offerId: 'o1', amountUsd: 42 }
    offers['o1'] = { offerQuantityKg: 25 }
    listings['l1'] = { commodity: 'Manioc' }
    partners['arom'] = { webhookUrl: 'https://arom.cd/hook', outboundHmacSecret: 'secret' }
    await notifyPartnerInvoiceIssued('inv1')
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookUrl: 'https://arom.cd/hook',
        outboundSecret: 'secret',
        kind: 'invoice_issued',
        partnerId: 'arom',
        invoiceId: 'inv1',
        payload: expect.objectContaining({ invoiceId: 'inv1', farmerId: 'f1', listingId: 'l1', amountUsd: 42, quantityKg: 25, commodity: 'Manioc' }),
      }),
    )
  })

  it('onSuccess updates invoiceIssuedNotifiedAt on the invoice', async () => {
    invoices['inv1'] = { partnerId: 'arom', farmerId: 'f1', listingId: 'l1', offerId: 'o1', amountUsd: 42 }
    offers['o1'] = { offerQuantityKg: 25 }
    listings['l1'] = { commodity: 'Manioc' }
    partners['arom'] = { webhookUrl: 'https://arom.cd/hook', outboundHmacSecret: 'secret' }
    await notifyPartnerInvoiceIssued('inv1')
    const { onSuccess } = sendMock.mock.calls[0][0]
    await onSuccess()
    expect(invoiceUpdateMock).toHaveBeenCalledWith(expect.objectContaining({ invoiceIssuedNotifiedAt: 'SERVER_TIMESTAMP' }))
  })
})
