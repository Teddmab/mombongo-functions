import { admin, db, functions } from '../lib/admin'

export const deleteFarmerParcel = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { parcelId } = data as { parcelId: string }
    if (!parcelId) {
      throw new functions.https.HttpsError('invalid-argument', 'parcelId is required')
    }

    const ref = db.collection('farmers').doc(uid).collection('parcels').doc(parcelId)
    const snap = await ref.get()
    if (!snap.exists) {
      throw new functions.https.HttpsError('not-found', 'Parcel not found')
    }
    if (snap.data()?.farmerId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not your parcel')
    }

    await ref.update({
      deleted: true,
      deletedAt: admin.firestore.FieldValue.serverTimestamp(),
    })
    return { success: true }
  })
