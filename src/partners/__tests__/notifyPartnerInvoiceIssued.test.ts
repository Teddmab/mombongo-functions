import { describe, it, expect, vi, beforeEach } from 'vitest'

const invoiceUpdateMock = vi.fn()
const invoices: Record<string, Record<string, unknown> | undefined> = {}
const partners: Record<string, Record<string, unknown> | undefined> = {}

vi.mock('../../lib/admin', () => ({
  db: {
    collection: (name: string) => {
      const store = { external_invoices: invoices, partners }[name]
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
    for (const s of [invoices, partners]) for (const k of Object.keys(s)) delete s[k]
  })

  it('does nothing when the invoice does not exist', async () => {
    await notifyPartnerInvoiceIssued('nope')
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('does nothing when the invoice has no partnerId', async () => {
    invoices['inv1'] = { partnerId: null, farmerId: 'f1', listingId: 'l1', amountUsd: 10, commodity: 'Manioc', quantityKg: 10 }
    await notifyPartnerInvoiceIssued('inv1')
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('does nothing when the partner has no webhookUrl/outboundHmacSecret', async () => {
    invoices['inv1'] = { partnerId: 'arom', farmerId: 'f1', listingId: 'l1', amountUsd: 10, commodity: 'Manioc', quantityKg: 10 }
    partners['arom'] = { name: 'AROM' }
    await notifyPartnerInvoiceIssued('inv1')
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('sends the invoice-issued payload with quantityKg/commodity read directly from the invoice (harvest_sale: from the offer/listing at creation time; admin_assisted: entered by the admin)', async () => {
    invoices['inv1'] = { partnerId: 'arom', farmerId: 'f1', listingId: 'l1', amountUsd: 42, quantityKg: 25, commodity: 'Manioc' }
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

  it('works for an admin-assisted cooperative invoice with no listingId at all', async () => {
    invoices['inv1'] = { partnerId: 'arom', farmerId: 'f1', listingId: null, amountUsd: 42, quantityKg: 100, commodity: 'Maïs' }
    partners['arom'] = { webhookUrl: 'https://arom.cd/hook', outboundHmacSecret: 'secret' }
    await notifyPartnerInvoiceIssued('inv1')
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ listingId: null, quantityKg: 100, commodity: 'Maïs' }),
      }),
    )
  })

  it('onSuccess updates invoiceIssuedNotifiedAt on the invoice', async () => {
    invoices['inv1'] = { partnerId: 'arom', farmerId: 'f1', listingId: 'l1', amountUsd: 42, quantityKg: 25, commodity: 'Manioc' }
    partners['arom'] = { webhookUrl: 'https://arom.cd/hook', outboundHmacSecret: 'secret' }
    await notifyPartnerInvoiceIssued('inv1')
    const { onSuccess } = sendMock.mock.calls[0][0]
    await onSuccess()
    expect(invoiceUpdateMock).toHaveBeenCalledWith(expect.objectContaining({ invoiceIssuedNotifiedAt: 'SERVER_TIMESTAMP' }))
  })
})

describe('notifyPartnerInvoiceIssued — retry safety (retry P0)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const s of [invoices, partners]) for (const k of Object.keys(s)) delete s[k]
  })

  it('a retry re-sends the same business event: same invoiceId, eventId and schemaVersion', async () => {
    invoices['inv1'] = { partnerId: 'arom', farmerId: 'f1', listingId: 'l1', amountUsd: 42, quantityKg: 25, commodity: 'Manioc' }
    partners['arom'] = { webhookUrl: 'https://arom.cd/hook', outboundHmacSecret: 'secret' }
    sendMock.mockResolvedValue(true)
    await notifyPartnerInvoiceIssued('inv1')
    await notifyPartnerInvoiceIssued('inv1')
    const [first, second] = sendMock.mock.calls.map(([input]) => input)
    expect(second.kind).toBe('invoice_issued')
    expect(second.payload.eventId).toBe(first.payload.eventId)
    expect(second.payload.invoiceId).toBe('inv1')
    expect(second.payload.schemaVersion).toBe(first.payload.schemaVersion)
  })

  it('reports whether the partner acknowledged, and false when nothing could be sent', async () => {
    invoices['inv1'] = { partnerId: 'arom', farmerId: 'f1', listingId: 'l1', amountUsd: 42, quantityKg: 25, commodity: 'Manioc' }
    partners['arom'] = { webhookUrl: 'https://arom.cd/hook', outboundHmacSecret: 'secret' }
    sendMock.mockResolvedValue(false)
    await expect(notifyPartnerInvoiceIssued('inv1')).resolves.toBe(false)
    sendMock.mockResolvedValue(true)
    await expect(notifyPartnerInvoiceIssued('inv1')).resolves.toBe(true)
    await expect(notifyPartnerInvoiceIssued('missing')).resolves.toBe(false)
  })
})
