import { functions } from '../lib/admin'
import { createHarvestOfferCore } from './createHarvestOfferCore'

/**
 * In-app merchant path — a real, logged-in merchant offering on a specific
 * product_listings doc. The partner-API equivalent (createExternalHarvestOffer,
 * SDP-04) resolves merchantId from partners/{partnerId}.merchantUid instead
 * of context.auth, then calls the same createHarvestOfferCore.
 */
export const createHarvestOffer = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { listingId, offerQuantityKg, offerPricePerKgCdf, message } = (data ?? {}) as {
      listingId?: string
      offerQuantityKg?: number
      offerPricePerKgCdf?: number
      message?: string
    }

    if (!listingId || !offerQuantityKg || !offerPricePerKgCdf) {
      throw new functions.https.HttpsError('invalid-argument', 'listingId, offerQuantityKg and offerPricePerKgCdf required')
    }

    try {
      const { offerId } = await createHarvestOfferCore({
        listingId,
        merchantId: uid,
        source: 'app',
        partnerId: null,
        offerQuantityKg,
        offerPricePerKgCdf,
        message,
      })
      return { offerId }
    } catch (err) {
      throw new functions.https.HttpsError('invalid-argument', err instanceof Error ? err.message : 'Invalid offer')
    }
  })
