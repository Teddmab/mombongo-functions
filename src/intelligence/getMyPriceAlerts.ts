import { admin, functions } from '../lib/admin'
const db = admin.firestore()

export const getMyPriceAlerts = functions
  .region('europe-west1')
  .https.onCall(async (_data: any, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const snap = await db.collection('price_alerts')
      .where('userId', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(10)
      .get()

    return { alerts: snap.docs.map(d => ({ id: d.id, ...d.data() })) }
  })
