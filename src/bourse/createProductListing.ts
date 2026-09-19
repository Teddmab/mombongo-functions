import { admin, functions } from '../lib/admin'
import { canonicalizeCommodity } from '../lib/commodity'

const db = admin.firestore()

export const createProductListing = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const {
      commodity,
      quantityKg,
      quality,
      province,
      territory,
      pricePerKgCdf,
      availableFrom,
      availableUntil,
      description,
    } = (data ?? {}) as {
      commodity: string
      quantityKg: number
      quality: 'A' | 'B' | 'C'
      province: string
      territory: string
      pricePerKgCdf: number
      availableFrom: string
      availableUntil: string
      description?: string
    }

    if (!commodity || !province) {
      throw new functions.https.HttpsError('invalid-argument', 'commodity and province required')
    }
    if (!quantityKg || quantityKg <= 0) {
      throw new functions.https.HttpsError('invalid-argument', 'Quantité invalide')
    }
    if (!pricePerKgCdf || pricePerKgCdf <= 0) {
      throw new functions.https.HttpsError('invalid-argument', 'Prix invalide')
    }
    if (!['A', 'B', 'C'].includes(quality)) {
      throw new functions.https.HttpsError('invalid-argument', 'Qualité invalide')
    }

    const userSnap = await db.collection('users').doc(uid).get()
    // fullName is what every real account actually has set (displayName
    // isn't populated anywhere in this codebase's sign-up flow) — checking
    // displayName only meant this almost always fell through to the
    // generic placeholder, including for external-partner-facing listings.
    const sellerName = userSnap.data()?.displayName ?? userSnap.data()?.fullName ?? 'Vendeur'
    const sellerRole = userSnap.data()?.role ?? 'farmer'

    const ref = db.collection('product_listings').doc()
    const now = admin.firestore.FieldValue.serverTimestamp()

    await ref.set({
      sellerId: uid,
      sellerName,
      sellerRole,
      commodity,
      // Stable match key for partner catalog scoping (getExternalPublishedListings)
      // — commodity itself is free text, never a safe thing to match a
      // partner's allowlist against directly. See src/lib/commodity.ts.
      commodityCode: canonicalizeCommodity(commodity),
      quantityKg,
      quality,
      province,
      territory: territory ?? '',
      pricePerKgCdf,
      availableFrom: availableFrom ? new Date(availableFrom) : now,
      availableUntil: availableUntil ? new Date(availableUntil) : now,
      description: description ?? '',
      photoUrls: [],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })

    return { listingId: ref.id }
  })
