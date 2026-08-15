import { admin, functions } from '../lib/admin'

const db = admin.firestore()

function tsToIso(val: unknown): string | null {
  if (!val) return null
  if (val instanceof admin.firestore.Timestamp) return val.toDate().toISOString()
  return null
}

export const getCooperativeLots = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    if (!context.auth?.uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { commodity, province } = (data ?? {}) as { commodity?: string; province?: string }

    let q: FirebaseFirestore.Query = db.collection('cooperative_lots').where('status', '==', 'open')
    if (commodity) q = q.where('commodity', '==', commodity)
    if (province && !commodity) q = q.where('province', '==', province)
    q = q.orderBy('createdAt', 'desc').limit(50)

    const snap = await q.get()
    const lots = snap.docs.map(d => {
      const doc = d.data()
      const filtered = province && commodity ? doc.province === province : true
      if (!filtered) return null
      return {
        lotId: d.id,
        ...doc,
        deadline:   tsToIso(doc.deadline),
        createdAt:  tsToIso(doc.createdAt),
      }
    }).filter(Boolean)

    return { lots }
  })
