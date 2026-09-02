import { describe, it, expect, vi, beforeEach } from 'vitest'

const invoiceDocs = [
  { id: 'inv-2', data: () => ({ merchantId: 'merchant-1', origin: 'harvest_sale', amountUsd: 42, status: 'pending', farmerId: 'farmer-1' }) },
  { id: 'inv-1', data: () => ({ merchantId: 'merchant-1', origin: 'admin_assisted', amountUsd: 10, status: 'paid', farmers: [{ farmerId: 'farmer-1', contributedKg: 60 }, { farmerId: 'farmer-2', contributedKg: 40 }] }) },
]

const users: Record<string, Record<string, unknown> | undefined> = {}

const orderByMock = vi.fn(() => ({ get: async () => ({ docs: invoiceDocs }) }))
const whereMock2 = vi.fn(() => ({ orderBy: orderByMock }))
const whereMock1 = vi.fn(() => ({ where: whereMock2 }))

vi.mock('../../lib/admin', () => ({
  db: {
    collection: (name: string) => {
      if (name === 'external_invoices') return { where: whereMock1 }
      if (name === 'users') {
        return { doc: (id: string) => ({ get: async () => ({ id, exists: users[id] !== undefined, data: () => users[id] }) }) }
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

type Handler = (data: unknown, context: { auth?: { uid: string } }) => Promise<{
  invoices: { id: string; farmerNames: string[]; [key: string]: unknown }[]
}>
const call = getMyHarvestInvoices as unknown as Handler

describe('getMyHarvestInvoices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const k of Object.keys(users)) delete users[k]
    users['farmer-1'] = { fullName: 'Jean Kalonji' }
    users['farmer-2'] = { fullName: 'Marie Tshisekedi' }
  })

  it('rejects an unauthenticated caller', async () => {
    await expect(call({}, {})).rejects.toThrow('Login required')
  })

  it("returns the caller's own invoices across harvest_sale and admin_assisted (not partner_api), with farmer names resolved", async () => {
    const result = await call({}, { auth: { uid: 'merchant-1' } })
    expect(result.invoices).toEqual([
      { id: 'inv-2', merchantId: 'merchant-1', origin: 'harvest_sale', amountUsd: 42, status: 'pending', farmerId: 'farmer-1', farmerNames: ['Jean Kalonji'] },
      {
        id: 'inv-1', merchantId: 'merchant-1', origin: 'admin_assisted', amountUsd: 10, status: 'paid',
        farmers: [{ farmerId: 'farmer-1', contributedKg: 60 }, { farmerId: 'farmer-2', contributedKg: 40 }],
        farmerNames: ['Jean Kalonji', 'Marie Tshisekedi'],
      },
    ]);
    expect(whereMock1).toHaveBeenCalledWith('merchantId', '==', 'merchant-1')
    expect(whereMock2).toHaveBeenCalledWith('origin', 'in', ['harvest_sale', 'admin_assisted'])
    expect(orderByMock).toHaveBeenCalledWith('createdAt', 'desc')
  })

  it('falls back to a generic label when a farmer profile is missing', async () => {
    delete users['farmer-2']
    const result = await call({}, { auth: { uid: 'merchant-1' } })
    expect(result.invoices[1].farmerNames).toEqual(['Jean Kalonji', 'Agriculteur'])
  })
})
