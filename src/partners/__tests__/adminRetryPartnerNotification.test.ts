import { describe, it, expect, vi, beforeEach } from 'vitest'

const users: Record<string, { role?: string } | undefined> = {}
const invoices: Record<string, Record<string, unknown> | undefined> = {}

vi.mock('../../lib/admin', () => ({
  db: {
    collection: (name: string) => {
      if (name === 'users') return { doc: (id: string) => ({ get: async () => ({ data: () => users[id] }) }) }
      if (name === 'external_invoices') return { doc: (id: string) => ({ get: async () => ({ exists: invoices[id] !== undefined }) }) }
      throw new Error(`unexpected collection ${name}`)
    },
  },
  functions: {
    region: vi.fn(() => ({ https: { onCall: vi.fn((h: unknown) => h) } })),
    https: { HttpsError: class extends Error { constructor(public code: string, msg: string) { super(msg) } } },
    logger: { info: vi.fn() },
  },
}))

const { paymentCompleteMock, invoiceIssuedMock } = vi.hoisted(() => ({
  paymentCompleteMock: vi.fn(),
  invoiceIssuedMock: vi.fn(),
}))
vi.mock('../notifyPartnerPaymentComplete', () => ({ notifyPartnerPaymentComplete: paymentCompleteMock }))
vi.mock('../notifyPartnerInvoiceIssued', () => ({ notifyPartnerInvoiceIssued: invoiceIssuedMock }))

import { adminRetryPartnerNotification } from '../adminRetryPartnerNotification'

type Handler = (data: unknown, context: { auth?: { uid: string } }) => Promise<unknown>

describe('adminRetryPartnerNotification — kind dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const k of Object.keys(users)) delete users[k]
    for (const k of Object.keys(invoices)) delete invoices[k]
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
})
