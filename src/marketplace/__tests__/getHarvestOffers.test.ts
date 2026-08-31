import { describe, it, expect, vi } from 'vitest'

const offerDocs = [
  { id: 'offer-2', data: () => ({ listingId: 'l1', offerPricePerKgCdf: 600, merchantId: 'm2' }) },
  { id: 'offer-1', data: () => ({ listingId: 'l1', offerPricePerKgCdf: 500, merchantId: 'm1' }) },
]

const orderByMock = vi.fn(() => ({ get: async () => ({ docs: offerDocs }) }))
const whereMock = vi.fn(() => ({ orderBy: orderByMock }))

vi.mock('../../lib/admin', () => ({
  db: {
    collection: (name: string) => {
      if (name === 'product_listings') {
        return {
          doc: (id: string) => ({
            get: async () => ({
              exists: id === 'listing-owned',
              data: () => (id === 'listing-owned' ? { sellerId: 'farmer-1' } : undefined),
            }),
          }),
        }
      }
      if (name === 'harvest_offers') {
        return { where: whereMock }
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

import { getListingOffers, getMyHarvestOffers } from '../getHarvestOffers'

type Handler = (data: unknown, context: { auth?: { uid: string } }) => Promise<unknown>

describe('getListingOffers', () => {
  it('rejects an unauthenticated caller', async () => {
    await expect((getListingOffers as unknown as Handler)({ listingId: 'listing-owned' }, {})).rejects.toThrow('Login required')
  })

  it("rejects reading someone else's listing", async () => {
    await expect(
      (getListingOffers as unknown as Handler)({ listingId: 'listing-owned' }, { auth: { uid: 'not-the-farmer' } }),
    ).rejects.toThrow('Not your listing')
  })

  it("returns offers for the caller's own listing", async () => {
    const result = await (getListingOffers as unknown as Handler)(
      { listingId: 'listing-owned' },
      { auth: { uid: 'farmer-1' } },
    )
    expect(result).toEqual({
      offers: [
        { id: 'offer-2', listingId: 'l1', offerPricePerKgCdf: 600, merchantId: 'm2' },
        { id: 'offer-1', listingId: 'l1', offerPricePerKgCdf: 500, merchantId: 'm1' },
      ],
    })
  })
})

describe('getMyHarvestOffers', () => {
  it('rejects an unauthenticated caller', async () => {
    await expect((getMyHarvestOffers as unknown as Handler)({}, {})).rejects.toThrow('Login required')
  })

  it("returns the caller's own offers", async () => {
    const result = await (getMyHarvestOffers as unknown as Handler)({}, { auth: { uid: 'merchant-1' } })
    expect((result as { offers: unknown[] }).offers).toHaveLength(2)
  })
})
