import { describe, it, expect, vi } from 'vitest'

const invoiceDocs = [
  { id: 'inv-2', data: () => ({ merchantId: 'merchant-1', origin: 'harvest_sale', amountUsd: 42, status: 'pending' }) },
  { id: 'inv-1', data: () => ({ merchantId: 'merchant-1', origin: 'harvest_sale', amountUsd: 10, status: 'paid' }) },
]

const orderByMock = vi.fn(() => ({ get: async () => ({ docs: invoiceDocs }) }))
const whereMock2 = vi.fn(() => ({ orderBy: orderByMock }))
const whereMock1 = vi.fn(() => ({ where: whereMock2 }))

vi.mock('../../lib/admin', () => ({
  db: {
    collection: (name: string) => {
      if (name === 'external_invoices') {
        return { where: whereMock1 }
      }
      throw new Error(`unexpected collection ${name}`)
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

import { getMyHarvestInvoices } from '../getMyHarvestInvoices'

type Handler = (data: unknown, context: { auth?: { uid: string } }) => Promise<unknown>

describe('getMyHarvestInvoices', () => {
  it('rejects an unauthenticated caller', async () => {
    await expect((getMyHarvestInvoices as unknown as Handler)({}, {})).rejects.toThrow('Login required')
  })

  it("returns the caller's own harvest-sale invoices", async () => {
    const result = await (getMyHarvestInvoices as unknown as Handler)({}, { auth: { uid: 'merchant-1' } })
    expect(result).toEqual({
      invoices: [
        { id: 'inv-2', merchantId: 'merchant-1', origin: 'harvest_sale', amountUsd: 42, status: 'pending' },
        { id: 'inv-1', merchantId: 'merchant-1', origin: 'harvest_sale', amountUsd: 10, status: 'paid' },
      ],
    })
    expect(whereMock1).toHaveBeenCalledWith('merchantId', '==', 'merchant-1')
    expect(whereMock2).toHaveBeenCalledWith('origin', '==', 'harvest_sale')
    expect(orderByMock).toHaveBeenCalledWith('createdAt', 'desc')
  })
})
