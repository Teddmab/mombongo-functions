import { db, functions } from '../lib/admin'

export const getFarmerParcels = functions
  .region('europe-west1')
  .https.onCall(async (_data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const snap = await db
      .collection('farmers')
      .doc(uid)
      .collection('parcels')
      .where('deleted', '==', false)
      .orderBy('createdAt', 'desc')
      .get()

    const parcels = snap.docs.map(d => {
      const data = d.data()
      return {
        id: d.id,
        name: data.name,
        cropType: data.cropType,
        surfaceHa: data.surfaceHa ?? null,
        plantingDate: data.plantingDate ?? null,
        province: data.province ?? null,
        territory: data.territory ?? null,
        notes: data.notes ?? null,
        createdAt: data.createdAt?.toDate?.()?.toISOString() ?? null,
      }
    })

    return { parcels }
  })
