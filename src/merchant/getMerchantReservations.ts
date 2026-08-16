import { db, functions } from '../lib/admin'

export const getMerchantReservations = functions.region('europe-west1').https.onCall(async (data, context) => {
  const uid = context.auth?.uid
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

  const limit = Math.min(((data as { limit?: number })?.limit ?? 20), 100)

  const snap = await db.collection('bourse_investments')
    .where('investorId', '==', uid)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get()

  return {
    reservations: snap.docs.map(d => {
      const doc = d.data() as Record<string, unknown>
      return {
        ...doc,
        id:        d.id,
        createdAt: doc.createdAt instanceof Object && 'toDate' in doc.createdAt
          ? (doc.createdAt as { toDate: () => Date }).toDate().toISOString()
          : null,
      }
    }),
  }
})
