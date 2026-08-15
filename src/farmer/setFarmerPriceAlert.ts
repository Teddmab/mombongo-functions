import { admin, functions } from '../lib/admin'

const db = admin.firestore()
const FieldValue = admin.firestore.FieldValue

export const setFarmerPriceAlert = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { commodity, province, thresholdUsd, direction } = (data ?? {}) as {
      commodity?: string
      province?: string
      thresholdUsd?: number
      direction?: string
    }

    if (!commodity?.trim()) throw new functions.https.HttpsError('invalid-argument', 'commodity required')
    if (!province?.trim())  throw new functions.https.HttpsError('invalid-argument', 'province required')
    if (!thresholdUsd || thresholdUsd <= 0) throw new functions.https.HttpsError('invalid-argument', 'thresholdUsd must be > 0')
    if (direction !== 'above' && direction !== 'below') throw new functions.https.HttpsError('invalid-argument', 'direction must be above or below')

    // Deterministic doc ID — one alert per (farmer, commodity, direction)
    const docId = `${uid}_${commodity.trim()}_${direction}`
    const docRef = db.collection('farmer_price_alerts').doc(docId)

    await docRef.set(
      {
        farmerId: uid,
        commodity: commodity.trim(),
        province: province.trim(),
        thresholdUsd,
        direction,
        active: true,
        updatedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    )

    return { alertId: docId }
  })
