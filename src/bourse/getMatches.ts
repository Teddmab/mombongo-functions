import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const getMatches = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const role: 'buyer' | 'seller' = (data as any)?.role ?? 'buyer'
    const field = role === 'buyer' ? 'buyerId' : 'sellerId'

    const snap = await db.collection('bourse_matches')
      .where(field, '==', uid)
      .where('status', 'in', ['pending_negotiation', 'agreed', 'contracted'])
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get()

    const matches = await Promise.all(snap.docs.map(async d => {
      const matchData = { id: d.id, ...d.data() }
      // Fetch last negotiation proposal
      const negsSnap = await d.ref.collection('negotiations')
        .orderBy('createdAt', 'desc').limit(3).get()
      const negotiations = negsSnap.docs.map(n => ({ id: n.id, ...n.data() }))
      return { ...matchData, negotiations }
    }))

    return { matches }
  })
