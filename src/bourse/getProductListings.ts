import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const getProductListings = functions
  .region('europe-west1')
  .https.onCall(async (data, _context) => {
    const { commodity, province, limit: lim = 20 } = (data ?? {}) as {
      commodity?: string
      province?: string
      limit?: number
    }

    let q = db.collection('product_listings')
      .where('status', '==', 'active') as FirebaseFirestore.Query

    if (commodity) q = q.where('commodity', '==', commodity)
    if (province)  q = q.where('province', '==', province)

    const snap = await q.orderBy('createdAt', 'desc').limit(lim).get()
    return { listings: snap.docs.map(d => ({ id: d.id, ...d.data() })) }
  })

export const getMyProductListings = functions
  .region('europe-west1')
  .https.onCall(async (_data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const snap = await db.collection('product_listings')
      .where('sellerId', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get()

    return { listings: snap.docs.map(d => ({ id: d.id, ...d.data() })) }
  })
