import { admin, db, functions } from '../lib/admin'

export const upsertFarmerParcel = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { parcelId, name, cropType, surfaceHa, plantingDate, province, territory, notes } = data as {
      parcelId?: string
      name: string
      cropType: string
      surfaceHa?: number
      plantingDate?: string
      province?: string
      territory?: string
      notes?: string
    }

    if (!name?.trim()) {
      throw new functions.https.HttpsError('invalid-argument', 'name is required')
    }
    if (!cropType?.trim()) {
      throw new functions.https.HttpsError('invalid-argument', 'cropType is required')
    }

    const col = db.collection('farmers').doc(uid).collection('parcels')
    const ref = parcelId ? col.doc(parcelId) : col.doc()

    const payload: Record<string, unknown> = {
      name: name.trim(),
      cropType,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      deleted: false,
    }
    if (surfaceHa !== undefined) payload.surfaceHa = surfaceHa
    if (plantingDate !== undefined) payload.plantingDate = plantingDate
    if (province !== undefined) payload.province = province
    if (territory !== undefined) payload.territory = territory
    if (notes !== undefined) payload.notes = notes

    if (!parcelId) {
      payload.createdAt = admin.firestore.FieldValue.serverTimestamp()
      payload.farmerId = uid
    }

    await ref.set(payload, { merge: true })
    return { parcelId: ref.id }
  })
