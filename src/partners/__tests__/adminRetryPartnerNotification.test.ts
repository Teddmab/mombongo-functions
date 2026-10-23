import { describe, it, expect, vi, beforeEach } from 'vitest'

const users: Record<string, { role?: string } | undefined> = {}
const invoices: Record<string, Record<string, unknown> | undefined> = {}
const offers: Record<string, Record<string, unknown> | undefined> = {}
const failures: Record<string, Record<string, unknown>> = {}

const snapOf = (store: Record<string, Record<string, unknown> | undefined>, id: string) => ({
  exists: store[id] !== undefined,
  data: () => store[id],
})

vi.mock('../../lib/admin', () => ({
  db: {
    collection: (name: string) => {
      if (name === 'users') return { doc: (id: string) => ({ get: async () => ({ data: () => users[id] }) }) }
      if (name === 'external_invoices') return { doc: (id: string) => ({ get: async () => snapOf(invoices, id) }) }
      if (name === 'harvest_offers') return { doc: (id: string) => ({ get: async () => snapOf(offers, id) }) }
      if (name === 'outbound_notification_failures') {
        return {
          doc: (id: string) => ({ get: async () => snapOf(failures, id) }),
          where: (field: string, _op: string, value: unknown) => ({
            limit: () => ({
              get: async () => ({
                docs: Object.values(failures).filter((f) => f[field] === value).map((f) => ({ data: () => f })),
              }),
            }),
          }),
        }
      }
      throw new Error(`unexpected collection ${name}`)
    },
  },
  functions: {
    region: vi.fn(() => ({ https: { onCall: vi.fn((h: unknown) => h) } })),
    https: { HttpsError: class extends Error { constructor(public code: string, msg: string) { super(msg) } } },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  },
}))

const { paymentCompleteMock, invoiceIssuedMock, offerStatusChangedMock } = vi.hoisted(() => ({
  paymentCompleteMock: vi.fn(),
  invoiceIssuedMock: vi.fn(),
  offerStatusChangedMock: vi.fn(),
}))
vi.mock('../notifyPartnerPaymentComplete', () => ({ notifyPartnerPaymentComplete: paymentCompleteMock }))
vi.mock('../notifyPartnerInvoiceIssued', () => ({ notifyPartnerInvoiceIssued: invoiceIssuedMock }))
vi.mock('../notifyPartnerOfferStatusChanged', () => ({ notifyPartnerOfferStatusChanged: offerStatusChangedMock }))

import { adminRetryPartnerNotification } from '../adminRetryPartnerNotification'
import { functions } from '../../lib/admin'

type Handler = (data: unknown, context: { auth?: { uid: string } }) => Promise<{ success: boolean; delivered: boolean; kind: string }>
const retry = (data: unknown, uid = 'admin1') =>
  (adminRetryPartnerNotification as unknown as Handler)(data, { auth: { uid } })
const at = (ms: number) => ({ toMillis: () => ms })

describe('adminRetryPartnerNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const s of [users, invoices, offers, failures]) for (const k of Object.keys(s)) delete s[k]
    users['admin1'] = { role: 'admin' }
    paymentCompleteMock.mockResolvedValue(true)
    invoiceIssuedMock.mockResolvedValue(true)
    offerStatusChangedMock.mockResolvedValue(true)
  })

  describe('event kind resolution (the P0 bug)', () => {
    it('retries a failed invoice_issued as invoice_issued when the admin console sends only invoiceId', async () => {
      invoices['inv1'] = { status: 'pending', partnerId: 'arom' }
      failures['f1'] = { invoiceId: 'inv1', partnerId: 'arom', kind: 'invoice_issued', failedAt: at(1) }
      const res = await retry({ invoiceId: 'inv1' })
      expect(invoiceIssuedMock).toHaveBeenCalledWith('inv1')
      expect(paymentCompleteMock).not.toHaveBeenCalled()
      expect(res).toMatchObject({ success: true, delivered: true, kind: 'invoice_issued' })
    })

    it('retries a failed payment_complete as payment_complete', async () => {
      invoices['inv1'] = { status: 'paid', partnerId: 'arom' }
      failures['f1'] = { invoiceId: 'inv1', partnerId: 'arom', kind: 'payment_complete', failedAt: at(1) }
      const res = await retry({ invoiceId: 'inv1' })
      expect(paymentCompleteMock).toHaveBeenCalledWith('inv1', expect.anything())
      expect(invoiceIssuedMock).not.toHaveBeenCalled()
      expect(res.kind).toBe('payment_complete')
    })

    it('uses the kind of the specific failure record when failureId is given', async () => {
      invoices['inv1'] = { status: 'paid', partnerId: 'arom' }
      failures['old'] = { invoiceId: 'inv1', partnerId: 'arom', kind: 'invoice_issued', failedAt: at(1) }
      failures['new'] = { invoiceId: 'inv1', partnerId: 'arom', kind: 'payment_complete', failedAt: at(2) }
      await retry({ invoiceId: 'inv1', failureId: 'old' })
      expect(invoiceIssuedMock).toHaveBeenCalledWith('inv1')
      expect(paymentCompleteMock).not.toHaveBeenCalled()
    })

    it('picks the most recent applicable failure when several exist', async () => {
      invoices['inv1'] = { status: 'paid', partnerId: 'arom' }
      failures['old'] = { invoiceId: 'inv1', partnerId: 'arom', kind: 'invoice_issued', failedAt: at(1) }
      failures['new'] = { invoiceId: 'inv1', partnerId: 'arom', kind: 'payment_complete', failedAt: at(2) }
      await retry({ invoiceId: 'inv1' })
      expect(paymentCompleteMock).toHaveBeenCalledOnce()
      expect(invoiceIssuedMock).not.toHaveBeenCalled()
    })

    it('treats a legacy kind-less failure as payment_complete, but never for a non-final invoice', async () => {
      invoices['inv1'] = { status: 'pending', partnerId: 'arom' }
      failures['f1'] = { invoiceId: 'inv1', partnerId: 'arom', failedAt: at(1) }
      await expect(retry({ invoiceId: 'inv1' })).rejects.toThrow('No failed partner notification')
      expect(paymentCompleteMock).not.toHaveBeenCalled()
    })

    it('refuses an explicit payment_complete for an invoice that is not paid/failed (no status:"pending" event)', async () => {
      invoices['inv1'] = { status: 'pending', partnerId: 'arom' }
      await expect(retry({ invoiceId: 'inv1', kind: 'payment_complete' })).rejects.toThrow('Cannot send payment_complete')
      expect(paymentCompleteMock).not.toHaveBeenCalled()
    })

    it('keeps the historical default for a final invoice with no dead-letter record (TransactionDetail path)', async () => {
      invoices['inv1'] = { status: 'paid', partnerId: 'arom' }
      await retry({ invoiceId: 'inv1' })
      expect(paymentCompleteMock).toHaveBeenCalledWith('inv1', expect.anything())
    })

    it('still honours an explicit invoice_issued kind', async () => {
      invoices['inv1'] = { status: 'checkout_created', partnerId: 'arom' }
      await retry({ invoiceId: 'inv1', kind: 'invoice_issued' })
      expect(invoiceIssuedMock).toHaveBeenCalledWith('inv1')
    })
  })

  describe('access and integrity', () => {
    it('rejects an unauthenticated caller', async () => {
      await expect(
        (adminRetryPartnerNotification as unknown as Handler)({ invoiceId: 'inv1' }, {}),
      ).rejects.toThrow('Login required')
    })

    it('rejects a non-admin caller', async () => {
      users['u1'] = { role: 'merchant' }
      invoices['inv1'] = { status: 'paid', partnerId: 'arom' }
      await expect(retry({ invoiceId: 'inv1' }, 'u1')).rejects.toThrow('Admin only')
      expect(paymentCompleteMock).not.toHaveBeenCalled()
    })

    it('rejects a failure record that belongs to another invoice', async () => {
      invoices['inv1'] = { status: 'pending', partnerId: 'arom' }
      failures['f2'] = { invoiceId: 'inv2', partnerId: 'arom', kind: 'invoice_issued', failedAt: at(1) }
      await expect(retry({ invoiceId: 'inv1', failureId: 'f2' })).rejects.toThrow('does not belong to this invoice')
      expect(invoiceIssuedMock).not.toHaveBeenCalled()
    })

    it('rejects a failure record that belongs to another partner', async () => {
      invoices['inv1'] = { status: 'pending', partnerId: 'arom' }
      failures['f1'] = { invoiceId: 'inv1', partnerId: 'other', kind: 'invoice_issued', failedAt: at(1) }
      await expect(retry({ invoiceId: 'inv1' })).rejects.toThrow('another partner')
      expect(invoiceIssuedMock).not.toHaveBeenCalled()
    })

    it('rejects an unknown invoice and an invoice with no partner', async () => {
      await expect(retry({ invoiceId: 'nope' })).rejects.toThrow('Invoice not found')
      invoices['inv1'] = { status: 'paid', partnerId: null }
      await expect(retry({ invoiceId: 'inv1' })).rejects.toThrow('no partner')
    })

    it('rejects an unknown kind', async () => {
      invoices['inv1'] = { status: 'paid', partnerId: 'arom' }
      await expect(retry({ invoiceId: 'inv1', kind: 'invoice_paid' })).rejects.toThrow('Unknown kind')
    })
  })

  describe('outcome visibility and logging', () => {
    it('reports delivered:false when the retry is itself exhausted (a new dead-letter doc keeps it visible)', async () => {
      invoices['inv1'] = { status: 'pending', partnerId: 'arom' }
      failures['f1'] = { invoiceId: 'inv1', partnerId: 'arom', kind: 'invoice_issued', failedAt: at(1) }
      invoiceIssuedMock.mockResolvedValue(false)
      const res = await retry({ invoiceId: 'inv1' })
      expect(res).toMatchObject({ success: false, delivered: false, kind: 'invoice_issued' })
    })

    it('logs only the caller, the record id and the kind — no payload or secret', async () => {
      invoices['inv1'] = { status: 'pending', partnerId: 'arom', amountUsd: 1425, farmerId: 'f9' }
      failures['f1'] = { invoiceId: 'inv1', partnerId: 'arom', kind: 'invoice_issued', failedAt: at(1) }
      await retry({ invoiceId: 'inv1' })
      const logged = JSON.stringify(vi.mocked(functions.logger.info).mock.calls)
      expect(logged).toContain('inv1')
      expect(logged).toContain('kind=invoice_issued')
      expect(logged).not.toMatch(/1425|f9|secret|hmac/i)
    })
  })

  describe('offer_status_changed (unchanged behaviour)', () => {
    it('re-notifies with the offer\'s own current status', async () => {
      offers['o1'] = { status: 'declined' }
      await retry({ invoiceId: 'o1', kind: 'offer_status_changed' })
      expect(offerStatusChangedMock).toHaveBeenCalledWith('o1', 'declined')
      expect(paymentCompleteMock).not.toHaveBeenCalled()
      expect(invoiceIssuedMock).not.toHaveBeenCalled()
    })

    it('rejects an unknown offer id', async () => {
      await expect(retry({ invoiceId: 'nope', kind: 'offer_status_changed' })).rejects.toThrow('Offer not found')
    })

    it('rejects an offer still pending (no resolved status to notify)', async () => {
      offers['o1'] = { status: 'pending' }
      await expect(retry({ invoiceId: 'o1', kind: 'offer_status_changed' })).rejects.toThrow('no resolved status')
    })
  })
})
