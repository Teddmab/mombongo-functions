import { admin, functions } from '../lib/admin'

const db = admin.firestore()
const FieldValue = admin.firestore.FieldValue

export const deactivateProductListing = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { listingId } = data as { listingId: string }
    if (!listingId) throw new functions.https.HttpsError('invalid-argument', 'listingId required')

    const ref = db.collection('product_listings').doc(listingId)
    const snap = await ref.get()
    if (!snap.exists) throw new functions.https.HttpsError('not-found', 'Annonce introuvable')
    if (snap.data()!.sellerId !== uid)
      throw new functions.https.HttpsError('permission-denied', 'Permission refusée')

    await ref.update({ status: 'inactive', updatedAt: FieldValue.serverTimestamp() })
    return { ok: true }
  })
