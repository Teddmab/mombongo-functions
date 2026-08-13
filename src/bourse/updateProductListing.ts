import { admin, functions } from '../lib/admin'

const db = admin.firestore()
const FieldValue = admin.firestore.FieldValue

const ALLOWED = ['pricePerKgCdf', 'quantityKg', 'availableUntil', 'description', 'quality']

export const updateProductListing = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { listingId, updates } = data as { listingId: string; updates: Record<string, unknown> }
    if (!listingId) throw new functions.https.HttpsError('invalid-argument', 'listingId required')
    if (!updates || typeof updates !== 'object')
      throw new functions.https.HttpsError('invalid-argument', 'updates required')

    const listingRef = db.collection('product_listings').doc(listingId)
    const snap = await listingRef.get()
    if (!snap.exists) throw new functions.https.HttpsError('not-found', 'Annonce introuvable')
    if (snap.data()!.sellerId !== uid)
      throw new functions.https.HttpsError('permission-denied', 'Vous ne pouvez modifier que vos propres annonces')

    const safe = Object.fromEntries(
      Object.entries(updates).filter(([k]) => ALLOWED.includes(k))
    )
    if (Object.keys(safe).length === 0)
      throw new functions.https.HttpsError('invalid-argument', 'Aucun champ valide à mettre à jour')

    await listingRef.update({ ...safe, updatedAt: FieldValue.serverTimestamp() })
    return { ok: true }
  })
