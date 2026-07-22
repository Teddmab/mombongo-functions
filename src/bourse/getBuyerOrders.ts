import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const getBuyerOrders = functions
  .region('europe-west1')
  .https.onCall(async (data, _context) => {
    const { commodity } = (data ?? {}) as { commodity?: string }

    let q = db.collection('buyer_orders')
      .where('status', '==', 'open') as FirebaseFirestore.Query

    if (commodity) q = q.where('commodity', '==', commodity)

    const snap = await q.orderBy('createdAt', 'desc').limit(20).get()
    return { orders: snap.docs.map(d => ({ id: d.id, ...d.data() })) }
  })
