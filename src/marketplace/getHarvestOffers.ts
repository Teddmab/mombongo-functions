import { db, functions } from '../lib/admin'

/**
 * Farmer viewing offers on their own listing — ordered highest price first
 * so the farmer sees the best offer at the top when deciding who to select
 * (SDP-02's selectHarvestOffer).
 */
export const getListingOffers = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { listingId } = (data ?? {}) as { listingId?: string }
    if (!listingId) throw new functions.https.HttpsError('invalid-argument', 'listingId required')

    const listingSnap = await db.collection('product_listings').doc(listingId).get()
    if (!listingSnap.exists || listingSnap.data()?.sellerId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not your listing')
    }

    const snap = await db.collection('harvest_offers')
      .where('listingId', '==', listingId)
      .orderBy('offerPricePerKgCdf', 'desc')
      .get()

    return { offers: snap.docs.map(d => ({ id: d.id, ...d.data() })) }
  })

/** Merchant viewing their own offers, across all listings. */
export const getMyHarvestOffers = functions
  .region('europe-west1')
  .https.onCall(async (_data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const snap = await db.collection('harvest_offers')
      .where('merchantId', '==', uid)
      .orderBy('createdAt', 'desc')
      .get()

    return { offers: snap.docs.map(d => ({ id: d.id, ...d.data() })) }
  })
