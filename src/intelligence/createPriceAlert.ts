import { admin, functions } from '../lib/admin'
const db = admin.firestore()
const FieldValue = admin.firestore.FieldValue

export const createPriceAlert = functions
  .region('europe-west1')
  .https.onCall(async (data: any, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { commodity, province, targetPriceCdf, direction = 'above' } = data
    if (!commodity) throw new functions.https.HttpsError('invalid-argument', 'Produit requis')
    if (!province) throw new functions.https.HttpsError('invalid-argument', 'Province requise')
    if (!(targetPriceCdf > 0)) throw new functions.https.HttpsError('invalid-argument', 'Prix invalide')
    if (!['above', 'below'].includes(direction))
      throw new functions.https.HttpsError('invalid-argument', 'Direction invalide')

    const existing = await db.collection('price_alerts')
      .where('userId', '==', uid)
      .where('status', '==', 'active')
      .get()
    if (existing.size >= 5)
      throw new functions.https.HttpsError('resource-exhausted', 'Maximum 5 alertes actives')

    const ref = db.collection('price_alerts').doc()
    await ref.set({
      userId: uid,
      commodity,
      province,
      targetPriceCdf,
      direction,
      status: 'active',
      createdAt: FieldValue.serverTimestamp(),
    })

    return { alertId: ref.id }
  })
