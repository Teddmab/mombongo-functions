import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const getHarvestHistory = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { exploitationId } = (data ?? {}) as { exploitationId?: string }

    let query: FirebaseFirestore.Query = db
      .collection('harvest_records')
      .where('farmerId', '==', uid)
      .orderBy('harvestDate', 'desc')
      .limit(50)

    if (exploitationId) {
      query = db
        .collection('harvest_records')
        .where('farmerId', '==', uid)
        .where('exploitationId', '==', exploitationId)
        .orderBy('harvestDate', 'desc')
        .limit(50)
    }

    const snap = await query.get()
    const records = snap.docs.map(d => ({
      id: d.id,
      ...d.data(),
      harvestDate: (d.data().harvestDate as admin.firestore.Timestamp)?.toDate().toISOString() ?? null,
      createdAt: (d.data().createdAt as admin.firestore.Timestamp)?.toDate().toISOString() ?? null,
    }))
    return { records }
  })
