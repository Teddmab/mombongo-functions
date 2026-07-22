import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const createProductListing = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const {
      commodity, quantityKg, quality, province, territory,
      pricePerKgCdf, availableFrom, availableUntil, description,
    } = data as {
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

    if (!commodity) throw new functions.https.HttpsError('invalid-argument', 'commodity requis')
    if (!(quantityKg > 0)) throw new functions.https.HttpsError('invalid-argument', 'Quantité invalide')
    if (!(pricePerKgCdf > 0)) throw new functions.https.HttpsError('invalid-argument', 'Prix invalide')

    const userSnap = await db.collection('users').doc(uid).get()
    const sellerName: string = userSnap.data()?.fullName ?? 'Vendeur'
    const sellerRole: string = userSnap.data()?.role ?? 'farmer'

    const ref = db.collection('product_listings').doc()
    const now = admin.firestore.FieldValue.serverTimestamp()

    await ref.set({
      sellerId: uid,
      sellerName,
      sellerRole,
      commodity,
      quantityKg,
      quality,
      province,
      territory,
      pricePerKgCdf,
      availableFrom: new Date(availableFrom),
      availableUntil: new Date(availableUntil),
      description: description ?? '',
      photoUrls: [],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })

    return { listingId: ref.id }
  })
