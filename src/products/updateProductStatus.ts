import { admin, db, functions } from '../lib/admin'

export const updateProductStatus = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const userSnap = await db.collection('users').doc(uid).get()
    if (userSnap.data()?.role !== 'admin')
      throw new functions.https.HttpsError('permission-denied', 'Admins only')

    const { productId, status } = data as { productId: string; status: 'active' | 'inactive' | 'draft' }

    if (!productId || !['active', 'inactive', 'draft'].includes(status))
      throw new functions.https.HttpsError('invalid-argument', 'Invalid payload')

    await db.collection('products').doc(productId).update({
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    })

    return { success: true }
  })
