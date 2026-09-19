import { FieldValue } from 'firebase-admin/firestore'
import { db } from '../lib/admin'

/**
 * Shared by the in-app onCall path (createHarvestOffer) and the partner-API
 * path (createExternalHarvestOffer, SDP-04) — one offer-creation path
 * regardless of caller, mirroring sendMorningPricePushCore's split between
 * core logic and its callers.
 *
 * Accepts an optional Firestore transaction so the partner-API idempotency
 * wrapper (createExternalHarvestOfferIdempotency.ts) can run this same
 * validation+write as one atomic step alongside its own idempotency-record
 * write — a duplicate submission and a validation failure must both leave
 * zero trace, and that's only possible if the read/validate/write all
 * happen inside one transaction. The in-app caller passes no transaction
 * and gets byte-identical behavior to before this change (doc().set() is
 * what .add() already does internally, just with the ID available before
 * the write completes).
 */
export interface CreateHarvestOfferInput {
  listingId: string
  merchantId: string
  source: 'app' | 'api'
  partnerId: string | null
  offerQuantityKg: number
  offerPricePerKgCdf: number
  message?: string | null
  /** AROM's own correlation reference, if supplied — null for every in-app offer. */
  externalReference?: string | null
}

export interface CreateHarvestOfferResult {
  offerId: string
}

export async function createHarvestOfferCore(
  input: CreateHarvestOfferInput,
  tx?: FirebaseFirestore.Transaction,
): Promise<CreateHarvestOfferResult> {
  const listingRef = db.collection('product_listings').doc(input.listingId)
  const listingSnap = tx ? await tx.get(listingRef) : await listingRef.get()
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

  const offerRef = db.collection('harvest_offers').doc()
  const data = {
    listingId: input.listingId,
    farmerId: listing.sellerId,
    merchantId: input.merchantId,
    source: input.source,
    partnerId: input.partnerId,
    offerQuantityKg: input.offerQuantityKg,
    offerPricePerKgCdf: input.offerPricePerKgCdf,
    message: input.message ?? null,
    externalReference: input.externalReference ?? null,
    status: 'pending',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }

  if (tx) {
    tx.set(offerRef, data)
  } else {
    await offerRef.set(data)
  }

  return { offerId: offerRef.id }
}
