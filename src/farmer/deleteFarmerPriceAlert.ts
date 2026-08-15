import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const deleteFarmerPriceAlert = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { alertId } = (data ?? {}) as { alertId?: string }
    if (!alertId?.trim()) throw new functions.https.HttpsError('invalid-argument', 'alertId required')

    const docRef = db.collection('farmer_price_alerts').doc(alertId)
    const snap = await docRef.get()

    if (!snap.exists) throw new functions.https.HttpsError('not-found', 'Alert not found')
    if (snap.data()?.farmerId !== uid) throw new functions.https.HttpsError('permission-denied', 'Not your alert')

    await docRef.delete()
    return { ok: true }
  })
