import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const deleteFarmInput = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { inputId } = (data ?? {}) as { inputId: string }
    if (!inputId) throw new functions.https.HttpsError('invalid-argument', 'inputId required')

    const ref = db.collection('farm_inputs').doc(inputId)
    const snap = await ref.get()
    if (!snap.exists) throw new functions.https.HttpsError('not-found', 'Input not found')
    if (snap.data()!.farmerId !== uid) throw new functions.https.HttpsError('not-found', 'Input not found')

    await ref.delete()
    return { success: true }
  })
