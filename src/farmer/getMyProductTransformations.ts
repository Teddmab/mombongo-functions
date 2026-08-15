import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const getMyProductTransformations = functions
  .region('europe-west1')
  .https.onCall(async (_data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const snap = await db
      .collection('product_transformations')
      .where('farmerId', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get()

    return { transformations: snap.docs.map(d => ({ id: d.id, ...d.data() })) }
  })
