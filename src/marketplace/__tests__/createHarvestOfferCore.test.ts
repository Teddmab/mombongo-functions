import { describe, it, expect, vi } from 'vitest'

vi.mock('../../lib/admin', () => {
  const listings: Record<string, Record<string, unknown> | undefined> = {
    'listing-active': { status: 'active', sellerId: 'farmer-1', quantityKg: 100 },
    'listing-sold': { status: 'sold', sellerId: 'farmer-1', quantityKg: 100 },
  }
  const added: unknown[] = []
  return {
    db: {
      collection: (name: string) => {
        if (name === 'product_listings') {
          return {
            doc: (id: string) => ({
              get: async () => ({
                exists: listings[id] !== undefined,
                data: () => listings[id],
              }),
            }),
          }
        }
        if (name === 'harvest_offers') {
          return {
            add: async (data: unknown) => {
              added.push(data)
              return { id: `offer-${added.length}` }
            },
          }
        }
        throw new Error(`unexpected collection ${name}`)
      },
    },
    __added: added,
  }
})

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: vi.fn(() => 'SERVER_TIMESTAMP') },
}))

import { createHarvestOfferCore } from '../createHarvestOfferCore'

describe('createHarvestOfferCore', () => {
  it('creates an offer on an active listing', async () => {
    const { offerId } = await createHarvestOfferCore({
      listingId: 'listing-active',
      merchantId: 'merchant-1',
      source: 'app',
      partnerId: null,
      offerQuantityKg: 50,
      offerPricePerKgCdf: 500,
    })
    expect(offerId).toBeTruthy()
  })

  it('copies farmerId from the listing sellerId', async () => {
    const adminMock = await import('../../lib/admin')
    const added = (adminMock as unknown as { __added: Array<Record<string, unknown>> }).__added
    added.length = 0
    await createHarvestOfferCore({
      listingId: 'listing-active',
      merchantId: 'merchant-1',
      source: 'app',
      partnerId: null,
      offerQuantityKg: 50,
      offerPricePerKgCdf: 500,
    })
    expect(added[0]).toMatchObject({ farmerId: 'farmer-1', status: 'pending' })
  })

  it('rejects an offer on a non-active listing', async () => {
    await expect(
      createHarvestOfferCore({
        listingId: 'listing-sold',
        merchantId: 'merchant-1',
        source: 'app',
        partnerId: null,
        offerQuantityKg: 50,
        offerPricePerKgCdf: 500,
      }),
    ).rejects.toThrow('not open for offers')
  })

  it('rejects an offer on a listing that does not exist', async () => {
    await expect(
      createHarvestOfferCore({
        listingId: 'nope',
        merchantId: 'merchant-1',
        source: 'app',
        partnerId: null,
        offerQuantityKg: 50,
        offerPricePerKgCdf: 500,
      }),
    ).rejects.toThrow('not open for offers')
  })

  it('rejects offerQuantityKg exceeding the listing quantity', async () => {
    await expect(
      createHarvestOfferCore({
        listingId: 'listing-active',
        merchantId: 'merchant-1',
        source: 'app',
        partnerId: null,
        offerQuantityKg: 500,
        offerPricePerKgCdf: 500,
      }),
    ).rejects.toThrow('offerQuantityKg')
  })

  it('rejects offerQuantityKg <= 0', async () => {
    await expect(
      createHarvestOfferCore({
        listingId: 'listing-active',
        merchantId: 'merchant-1',
        source: 'app',
        partnerId: null,
        offerQuantityKg: 0,
        offerPricePerKgCdf: 500,
      }),
    ).rejects.toThrow('offerQuantityKg')
  })

  it('rejects offerPricePerKgCdf <= 0', async () => {
    await expect(
      createHarvestOfferCore({
        listingId: 'listing-active',
        merchantId: 'merchant-1',
        source: 'app',
        partnerId: null,
        offerQuantityKg: 50,
        offerPricePerKgCdf: 0,
      }),
    ).rejects.toThrow('offerPricePerKgCdf')
  })
})
