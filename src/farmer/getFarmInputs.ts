import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const getFarmInputs = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { cultureId } = (data ?? {}) as { cultureId?: string }

    let q: FirebaseFirestore.Query = db.collection('farm_inputs').where('farmerId', '==', uid)
    if (cultureId) q = q.where('cultureId', '==', cultureId)
    q = q.orderBy('recordedAt', 'desc')

    const snap = await q.get()

    const inputs = snap.docs.map(d => {
      const doc = d.data()
      return {
        inputId: d.id,
        ...doc,
        recordedAt: doc.recordedAt?.toDate?.()?.toISOString() ?? null,
        createdAt:  doc.createdAt?.toDate?.()?.toISOString()  ?? null,
      }
    })

    const totalCostCdf = snap.docs.reduce((s, d) => s + ((d.data().costCdf as number) ?? 0), 0)

    return { inputs, totalCostCdf }
  })
