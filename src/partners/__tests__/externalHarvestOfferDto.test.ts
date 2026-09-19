import { describe, it, expect } from 'vitest'
import { toExternalHarvestOfferDto } from '../externalHarvestOfferDto'

describe('toExternalHarvestOfferDto', () => {
  it('maps every documented field and never leaks internal-only ones', () => {
    const dto = toExternalHarvestOfferDto('offer-1', {
      externalReference: 'arom-po-1',
      listingId: 'l1',
      status: 'accepted',
      offerQuantityKg: 50,
      offerPricePerKgCdf: 800,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
      invoiceId: 'inv1',
      // Internal-only fields that must not leak.
      merchantId: 'merchant-uid-should-not-leak',
      farmerId: 'farmer-uid',
      source: 'api',
      message: 'internal note',
    })

    expect(dto).toEqual({
      offerId: 'offer-1',
      externalReference: 'arom-po-1',
      listingId: 'l1',
      status: 'accepted',
      quantityKg: 50,
      unitPriceCdf: 800,
      currency: 'CDF',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
      invoiceId: 'inv1',
    })
  })

  it('defaults externalReference and invoiceId to null, and normalizes a Firestore Timestamp', () => {
    const toDate = () => new Date('2026-09-01T00:00:00.000Z')
    const dto = toExternalHarvestOfferDto('offer-1', {
      listingId: 'l1', status: 'pending', offerQuantityKg: 10, offerPricePerKgCdf: 100,
      createdAt: { toDate }, updatedAt: { toDate },
    })
    expect(dto.externalReference).toBeNull()
    expect(dto.invoiceId).toBeNull()
    expect(dto.createdAt).toBe('2026-09-01T00:00:00.000Z')
  })
})
