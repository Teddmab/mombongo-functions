import { FieldValue } from 'firebase-admin/firestore'
import { db } from '../lib/admin'

/**
 * Shared by the in-app onCall path (createHarvestOffer) and the partner-API
 * path (createExternalHarvestOffer, SDP-04) — one offer-creation path
 * regardless of caller, mirroring sendMorningPricePushCore's split between
 * core logic and its callers.
 */
export interface CreateHarvestOfferInput {
  listingId: string
  merchantId: string
  source: 'app' | 'api'
  partnerId: string | null
  offerQuantityKg: number
  offerPricePerKgCdf: number
  message?: string
}

export interface CreateHarvestOfferResult {
  offerId: string
}

export async function createHarvestOfferCore(
  input: CreateHarvestOfferInput,
): Promise<CreateHarvestOfferResult> {
  const listingSnap = await db.collection('product_listings').doc(input.listingId).get()
  if (!listingSnap.exists || listingSnap.data()?.status !== 'active') {
    throw new Error('Listing not found or not open for offers')
  }
  const listing = listingSnap.data()!

  if (input.offerQuantityKg <= 0 || input.offerQuantityKg > listing.quantityKg) {
    throw new Error('offerQuantityKg must be > 0 and <= the listing quantity')
  }
  if (input.offerPricePerKgCdf <= 0) {
    throw new Error('offerPricePerKgCdf must be > 0')
  }

  const docRef = await db.collection('harvest_offers').add({
    listingId: input.listingId,
    farmerId: listing.sellerId,
    merchantId: input.merchantId,
    source: input.source,
    partnerId: input.partnerId,
    offerQuantityKg: input.offerQuantityKg,
    offerPricePerKgCdf: input.offerPricePerKgCdf,
    message: input.message ?? null,
    status: 'pending',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  })

  return { offerId: docRef.id }
}
