import { admin, functions } from '../lib/admin'
const db = admin.firestore()
const FieldValue = admin.firestore.FieldValue

export const cancelPriceAlert = functions
  .region('europe-west1')
  .https.onCall(async (data: any, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { alertId } = data
    if (!alertId) throw new functions.https.HttpsError('invalid-argument', 'alertId required')

    const snap = await db.collection('price_alerts').doc(alertId).get()
    if (!snap.exists) throw new functions.https.HttpsError('not-found', 'Alerte introuvable')
    if (snap.data()?.userId !== uid)
      throw new functions.https.HttpsError('permission-denied', 'Non autorisé')

    await snap.ref.update({ status: 'cancelled', updatedAt: FieldValue.serverTimestamp() })
    return { ok: true }
  })
