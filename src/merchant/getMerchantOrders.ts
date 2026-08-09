import { db, functions } from '../lib/admin'

export const getMerchantOrders = functions.region('europe-west1').https.onCall(async (data, context) => {
  const uid = context.auth?.uid
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

  const limit = Math.min((data?.limit ?? 20) as number, 100)

  const snap = await db.collection('product_orders')
    .where('merchantId', '==', uid)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get()

  return { orders: snap.docs.map(d => ({ id: d.id, ...d.data() })) }
})
