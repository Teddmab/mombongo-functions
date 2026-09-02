import { describe, it, expect, vi, beforeEach } from 'vitest'

const invoiceDocs = [
  { id: 'inv-1', data: () => ({ origin: 'admin_assisted', merchantId: 'm1', farmerId: 'f1', farmerIds: ['f1'], commodity: 'Maïs', quantityKg: 100, amountUsd: 50, currency: 'USD', status: 'pending', createdAt: 't1', paidAt: null }) },
  {
    id: 'inv-2',
    data: () => ({
      origin: 'admin_assisted', merchantId: 'm1', farmerId: 'f1', farmerIds: ['f1', 'f2'],
      farmers: [{ farmerId: 'f1', contributedKg: 60 }, { farmerId: 'f2', contributedKg: 40 }],
      isCooperative: true, commodity: 'Manioc', quantityKg: 100, amountUsd: 80, currency: 'USD', status: 'paid', createdAt: 't2', paidAt: 't3',
    }),
  },
]

const users: Record<string, Record<string, unknown> | undefined> = { m1: { fullName: 'AROM Industries' } }

const orderByMock = vi.fn(() => ({ get: async () => ({ docs: invoiceDocs }) }))
const whereMock = vi.fn(() => ({ orderBy: orderByMock }))

vi.mock('../../lib/admin', () => ({
  db: {
    collection: (name: string) => {
      if (name === 'external_invoices') return { where: whereMock }
      if (name === 'users') {
        return { doc: (id: string) => ({ get: async () => ({ id, exists: users[id] !== undefined, data: () => users[id] }) }) }
      }
      throw new Error(`unexpected collection ${name}`)
    },
  },
  functions: {
    region: vi.fn(() => ({ https: { onCall: vi.fn((h: unknown) => h) } })),
    https: { HttpsError: class extends Error { constructor(public code: string, msg: string) { super(msg) } } },
  },
}))

import { getMyIssuedInvoices } from '../getMyIssuedInvoices'

type Handler = (data: unknown, context: { auth?: { uid: string } }) => Promise<{ invoices: Record<string, unknown>[] }>
const call = getMyIssuedInvoices as unknown as Handler

describe('getMyIssuedInvoices', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects an unauthenticated caller', async () => {
    await expect(call({}, {})).rejects.toThrow('Login required')
  })

  it('finds invoices via farmerIds array-contains, not just farmerId — so a cooperative member who is not farmers[0] still sees it', async () => {
    const result = await call({}, { auth: { uid: 'f2' } })
    expect(whereMock).toHaveBeenCalledWith('farmerIds', 'array-contains', 'f2')
    expect(orderByMock).toHaveBeenCalledWith('createdAt', 'desc')
    expect(result.invoices).toHaveLength(2) // the mock doesn't actually filter by uid, just proves the query shape
  })

  it('resolves the merchant name and this farmer\'s own contributedKg for a cooperative invoice', async () => {
    const result = await call({}, { auth: { uid: 'f2' } });
    expect(result.invoices[1]).toMatchObject({
      id: 'inv-2', merchantName: 'AROM Industries', isCooperative: true, contributedKg: 40, commodity: 'Manioc',
    });
  })

  it('uses the full quantityKg as contributedKg for a non-cooperative invoice', async () => {
    const result = await call({}, { auth: { uid: 'f1' } });
    expect(result.invoices[0]).toMatchObject({ id: 'inv-1', contributedKg: 100, isCooperative: false });
  })
})
