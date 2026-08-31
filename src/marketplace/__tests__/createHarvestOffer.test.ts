import { describe, it, expect, vi } from 'vitest'

vi.mock('../../lib/admin', () => ({
  functions: {
    region: vi.fn(() => ({ https: { onCall: vi.fn((h: unknown) => h) } })),
    https: {
      HttpsError: class extends Error {
        constructor(public code: string, msg: string) { super(msg) }
      },
    },
  },
}))

const { createHarvestOfferCoreMock } = vi.hoisted(() => ({ createHarvestOfferCoreMock: vi.fn() }))
vi.mock('../createHarvestOfferCore', () => ({
  createHarvestOfferCore: createHarvestOfferCoreMock,
}))

import { createHarvestOffer } from '../createHarvestOffer'

type Handler = (data: unknown, context: { auth?: { uid: string } }) => Promise<unknown>

describe('createHarvestOffer — onCall wrapper', () => {
  it('rejects an unauthenticated caller', async () => {
    await expect(
      (createHarvestOffer as unknown as Handler)(
        { listingId: 'l1', offerQuantityKg: 10, offerPricePerKgCdf: 100 },
        {},
      ),
    ).rejects.toThrow('Login required')
  })

  it('rejects missing required fields', async () => {
    await expect(
      (createHarvestOffer as unknown as Handler)({ listingId: 'l1' }, { auth: { uid: 'merchant-1' } }),
    ).rejects.toThrow('required')
  })

  it('calls createHarvestOfferCore with source app and the caller uid as merchantId', async () => {
    createHarvestOfferCoreMock.mockResolvedValueOnce({ offerId: 'offer-1' })
    const result = await (createHarvestOffer as unknown as Handler)(
      { listingId: 'l1', offerQuantityKg: 10, offerPricePerKgCdf: 100 },
      { auth: { uid: 'merchant-1' } },
    )
    expect(result).toEqual({ offerId: 'offer-1' })
    expect(createHarvestOfferCoreMock).toHaveBeenCalledWith(
      expect.objectContaining({ merchantId: 'merchant-1', source: 'app', partnerId: null }),
    )
  })

  it('surfaces createHarvestOfferCore errors as invalid-argument', async () => {
    createHarvestOfferCoreMock.mockRejectedValueOnce(new Error('Listing not found or not open for offers'))
    await expect(
      (createHarvestOffer as unknown as Handler)(
        { listingId: 'l1', offerQuantityKg: 10, offerPricePerKgCdf: 100 },
        { auth: { uid: 'merchant-1' } },
      ),
    ).rejects.toThrow('not open for offers')
  })
})
