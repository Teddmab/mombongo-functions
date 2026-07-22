import { admin, functions } from '../lib/admin'
const db = admin.firestore()

export const getPriceHistory = functions
  .region('europe-west1')
  .https.onCall(async (data: any) => {
    const { commodity, province, days = 30 } = data ?? {}
    if (!commodity) throw new functions.https.HttpsError('invalid-argument', 'commodity required')

    const since = new Date()
    since.setDate(since.getDate() - days)

    let q: FirebaseFirestore.Query = db.collection('price_history')
      .where('commodity', '==', commodity)
      .where('recordedAt', '>=', since)
      .orderBy('recordedAt', 'asc')
      .limit(days + 5)

    if (province) q = q.where('province', '==', province)

    const snap = await q.get()
    return { history: snap.docs.map(d => d.data()) }
  })
