import { describe, it, expect, vi, beforeEach } from 'vitest'

const users: Record<string, Record<string, unknown> | undefined> = {}
const setMock = vi.fn()

vi.mock('../../lib/admin', () => ({
  admin: {
    firestore: Object.assign(
      () => ({
        collection: (name: string) => {
          if (name === 'users') {
            return { doc: (id: string) => ({ get: async () => ({ exists: users[id] !== undefined, data: () => users[id] }) }) }
          }
          if (name === 'product_listings') {
            return { doc: () => ({ id: 'new-listing', set: setMock }) }
          }
          throw new Error(`unexpected collection ${name}`)
        },
      }),
      { FieldValue: { serverTimestamp: vi.fn(() => 'TS') } },
    ),
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

import { createProductListing } from '../createProductListing'

type Handler = (data: unknown, context: { auth?: { uid: string } }) => Promise<{ listingId: string }>
const call = createProductListing as unknown as Handler

const VALID_INPUT = {
  commodity: 'Manioc', quantityKg: 100, quality: 'A' as const, province: 'Kinshasa',
  territory: 'Lukaya', pricePerKgCdf: 500, availableFrom: '2026-09-01', availableUntil: '2026-10-01',
}

describe('createProductListing — sellerName resolution', () => {
  beforeEach(() => {
    setMock.mockClear()
    for (const k of Object.keys(users)) delete users[k]
  })

  it('uses fullName when displayName is not set (the real-world case for every existing account)', async () => {
    users['farmer1'] = { role: 'farmer', fullName: 'Jean Mbala' }
    await call(VALID_INPUT, { auth: { uid: 'farmer1' } })
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ sellerName: 'Jean Mbala' }))
  })

  it('prefers displayName over fullName when both are set', async () => {
    users['farmer1'] = { role: 'farmer', fullName: 'Jean Mbala', displayName: 'JeanM' }
    await call(VALID_INPUT, { auth: { uid: 'farmer1' } })
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ sellerName: 'JeanM' }))
  })

  it('falls back to the generic placeholder only when neither name field is set', async () => {
    users['farmer1'] = { role: 'farmer' }
    await call(VALID_INPUT, { auth: { uid: 'farmer1' } })
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ sellerName: 'Vendeur' }))
  })
})
