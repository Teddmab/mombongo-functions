import { describe, it, expect, vi, beforeEach } from 'vitest'

const users: Record<string, { role?: string } | undefined> = {}
const invoices: Record<string, Record<string, unknown> | undefined> = {}
const offers: Record<string, Record<string, unknown> | undefined> = {}

vi.mock('../../lib/admin', () => ({
  db: {
    collection: (name: string) => {
      if (name === 'users') return { doc: (id: string) => ({ get: async () => ({ data: () => users[id] }) }) }
      if (name === 'external_invoices') return { doc: (id: string) => ({ get: async () => ({ exists: invoices[id] !== undefined }) }) }
      if (name === 'harvest_offers') return { doc: (id: string) => ({ get: async () => ({ exists: offers[id] !== undefined, data: () => offers[id] }) }) }
      throw new Error(`unexpected collection ${name}`)
    },
  },
  functions: {
    region: vi.fn(() => ({ https: { onCall: vi.fn((h: unknown) => h) } })),
    https: { HttpsError: class extends Error { constructor(public code: string, msg: string) { super(msg) } } },
    logger: { info: vi.fn() },
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

type Handler = (data: unknown, context: { auth?: { uid: string } }) => Promise<unknown>

describe('adminRetryPartnerNotification — kind dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const k of Object.keys(users)) delete users[k]
    for (const k of Object.keys(invoices)) delete invoices[k]
    for (const k of Object.keys(offers)) delete offers[k]
    users['admin1'] = { role: 'admin' }
    invoices['inv1'] = { status: 'paid' }
  })

  it('defaults to notifyPartnerPaymentComplete when kind is not given (existing admin console behavior)', async () => {
    await (adminRetryPartnerNotification as unknown as Handler)({ invoiceId: 'inv1' }, { auth: { uid: 'admin1' } })
    expect(paymentCompleteMock).toHaveBeenCalledWith('inv1', expect.anything())
    expect(invoiceIssuedMock).not.toHaveBeenCalled()
  })

  it('calls notifyPartnerInvoiceIssued when kind is invoice_issued', async () => {
    await (adminRetryPartnerNotification as unknown as Handler)(
      { invoiceId: 'inv1', kind: 'invoice_issued' },
      { auth: { uid: 'admin1' } },
    )
    expect(invoiceIssuedMock).toHaveBeenCalledWith('inv1')
    expect(paymentCompleteMock).not.toHaveBeenCalled()
  })

  it('rejects a non-admin caller', async () => {
    users['u1'] = { role: 'merchant' }
    await expect(
      (adminRetryPartnerNotification as unknown as Handler)({ invoiceId: 'inv1' }, { auth: { uid: 'u1' } }),
    ).rejects.toThrow('Admin only')
  })

  it('calls notifyPartnerOfferStatusChanged with the offer\'s own current status when kind is offer_status_changed', async () => {
    offers['o1'] = { status: 'declined' }
    await (adminRetryPartnerNotification as unknown as Handler)(
      { invoiceId: 'o1', kind: 'offer_status_changed' },
      { auth: { uid: 'admin1' } },
    )
    expect(offerStatusChangedMock).toHaveBeenCalledWith('o1', 'declined')
    expect(paymentCompleteMock).not.toHaveBeenCalled()
    expect(invoiceIssuedMock).not.toHaveBeenCalled()
  })

  it('rejects offer_status_changed retry for an unknown offer id', async () => {
    await expect(
      (adminRetryPartnerNotification as unknown as Handler)(
        { invoiceId: 'nope', kind: 'offer_status_changed' },
        { auth: { uid: 'admin1' } },
      ),
    ).rejects.toThrow('Offer not found')
  })

  it('rejects offer_status_changed retry for an offer still pending (no resolved status to notify)', async () => {
    offers['o1'] = { status: 'pending' }
    await expect(
      (adminRetryPartnerNotification as unknown as Handler)(
        { invoiceId: 'o1', kind: 'offer_status_changed' },
        { auth: { uid: 'admin1' } },
      ),
    ).rejects.toThrow('no resolved status')
  })
})
