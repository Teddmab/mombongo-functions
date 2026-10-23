import { describe, it, expect, vi, beforeEach } from 'vitest'

const partners: Record<string, Record<string, unknown> | undefined> = {}
const invoiceUpdateMock = vi.fn()

vi.mock('../../lib/admin', () => ({
  db: { collection: (name: string) => { if (name !== 'partners') throw new Error(name); return { doc: (id: string) => ({ get: async () => ({ data: () => partners[id] }) }) } } },
  functions: {
    region: vi.fn(() => ({ firestore: { document: vi.fn(() => ({ onUpdate: vi.fn((h: unknown) => h) })) } })),
    logger: { error: vi.fn() },
  },
}))
vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: vi.fn(() => 'SERVER_TIMESTAMP') } }))

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }))
vi.mock('../sendSignedPartnerWebhook', () => ({ sendSignedPartnerWebhook: sendMock }))

import { notifyPartnerPaymentComplete } from '../notifyPartnerPaymentComplete'

describe('notifyPartnerPaymentComplete (refactored onto sendSignedPartnerWebhook)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const k of Object.keys(partners)) delete partners[k]
  })

  it('does nothing when the partner has no webhookUrl/outboundHmacSecret', async () => {
    partners['arom'] = {}
    const invoiceSnap = { data: () => ({ partnerId: 'arom', status: 'paid', amountUsd: 10, externalInvoiceId: 'ext1' }), ref: { update: invoiceUpdateMock } } as unknown as FirebaseFirestore.DocumentSnapshot
    await notifyPartnerPaymentComplete('inv1', invoiceSnap)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('delegates to sendSignedPartnerWebhook with kind payment_complete', async () => {
    partners['arom'] = { webhookUrl: 'https://arom.cd/hook', outboundHmacSecret: 'secret' }
    const invoiceSnap = { data: () => ({ partnerId: 'arom', status: 'paid', amountUsd: 10, externalInvoiceId: 'ext1' }), ref: { update: invoiceUpdateMock } } as unknown as FirebaseFirestore.DocumentSnapshot
    await notifyPartnerPaymentComplete('inv1', invoiceSnap)
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ webhookUrl: 'https://arom.cd/hook', kind: 'payment_complete', partnerId: 'arom', invoiceId: 'inv1' }),
    )
  })

  it('onSuccess still updates notifiedAt on the invoice', async () => {
    partners['arom'] = { webhookUrl: 'https://arom.cd/hook', outboundHmacSecret: 'secret' }
    const invoiceSnap = { data: () => ({ partnerId: 'arom', status: 'paid', amountUsd: 10, externalInvoiceId: 'ext1' }), ref: { update: invoiceUpdateMock } } as unknown as FirebaseFirestore.DocumentSnapshot
    await notifyPartnerPaymentComplete('inv1', invoiceSnap)
    const { onSuccess } = sendMock.mock.calls[0][0]
    await onSuccess()
    expect(invoiceUpdateMock).toHaveBeenCalledWith(expect.objectContaining({ notifiedAt: 'SERVER_TIMESTAMP' }))
  })
})

describe('notifyPartnerPaymentComplete — final status guard (retry P0)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const k of Object.keys(partners)) delete partners[k]
    partners['arom'] = { webhookUrl: 'https://arom.cd/hook', outboundHmacSecret: 'secret' }
  })

  it.each(['pending', 'checkout_created'])('never sends payment_complete for a %s invoice', async (status) => {
    const invoiceSnap = { data: () => ({ partnerId: 'arom', status, amountUsd: 10 }), ref: { update: invoiceUpdateMock } } as unknown as FirebaseFirestore.DocumentSnapshot
    await expect(notifyPartnerPaymentComplete('inv1', invoiceSnap)).resolves.toBe(false)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it.each(['paid', 'failed'])('still sends payment_complete for a %s invoice (existing behaviour)', async (status) => {
    sendMock.mockResolvedValue(true)
    const invoiceSnap = { data: () => ({ partnerId: 'arom', status, amountUsd: 10, externalInvoiceId: 'ext1' }), ref: { update: invoiceUpdateMock } } as unknown as FirebaseFirestore.DocumentSnapshot
    await expect(notifyPartnerPaymentComplete('inv1', invoiceSnap)).resolves.toBe(true)
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'payment_complete', payload: expect.objectContaining({ status, externalInvoiceId: 'ext1' }) }))
  })
})
