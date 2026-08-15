import { admin, functions } from '../lib/admin'

const db = admin.firestore()

function tsToIso(val: unknown): string | null {
  if (!val) return null
  if (val instanceof admin.firestore.Timestamp) return val.toDate().toISOString()
  return null
}

export const getMyCooperativeLots = functions
  .region('europe-west1')
  .https.onCall(async (_data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const snap = await db.collection('cooperative_lots')
      .where('memberIds', 'array-contains', uid)
      .orderBy('createdAt', 'desc')
      .get()

    const lots = snap.docs.map(d => {
      const doc = d.data()
      return {
        lotId: d.id,
        ...doc,
        deadline:  tsToIso(doc.deadline),
        createdAt: tsToIso(doc.createdAt),
      }
    })

    return { lots }
  })
