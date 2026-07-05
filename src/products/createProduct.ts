import { admin, db, functions } from '../lib/admin'

interface ProductPayload {
  name: string
  icon: string
  category: string
  location: string
  farmer: string
  description: string
  roi: number
  minInvest: number
  duration: number
  stock: number
  unit: string
  targetUsd: number
}

export const createProduct = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const userSnap = await db.collection('users').doc(uid).get()
    if (userSnap.data()?.role !== 'admin')
      throw new functions.https.HttpsError('permission-denied', 'Admins only')

    const {
      name, icon, category, location, farmer, description,
      roi, minInvest, duration, stock, unit, targetUsd,
    } = data as ProductPayload

    if (!name || !category || roi <= 0 || minInvest <= 0 || duration <= 0)
      throw new functions.https.HttpsError('invalid-argument', 'Invalid product payload')

    const ref = db.collection('products').doc()
    const now = admin.firestore.FieldValue.serverTimestamp()

    await ref.set({
      name,
      icon: icon || '🌾',
      category,
      location,
      farmer,
      description,
      roi,
      minInvest,
      duration,
      stock,
      unit,
      targetUsd,
      invested: 0,
      investorsCount: 0,
      status: 'draft',
      createdBy: uid,
      createdAt: now,
      updatedAt: now,
    })

    return { productId: ref.id }
  })
