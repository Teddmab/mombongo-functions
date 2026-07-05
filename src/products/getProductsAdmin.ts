import { db, functions } from '../lib/admin'

export const getProductsAdmin = functions
  .region('europe-west1')
  .https.onCall(async (_data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const userSnap = await db.collection('users').doc(uid).get()
    if (userSnap.data()?.role !== 'admin')
      throw new functions.https.HttpsError('permission-denied', 'Admins only')

    const snap = await db
      .collection('products')
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get()

    const products = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    return { products }
  })
