import * as admin from 'firebase-admin'
import * as functions from 'firebase-functions'

const db = admin.firestore()

export const disableUser = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const callerSnap = await db.collection('users').doc(uid).get()
    if (callerSnap.data()?.role !== 'admin')
      throw new functions.https.HttpsError('permission-denied', 'Admin only')

    const { userId, disabled } = data as { userId: string; disabled: boolean }
    if (!userId || typeof disabled !== 'boolean')
      throw new functions.https.HttpsError('invalid-argument', 'userId and disabled (boolean) required')

    if (userId === uid)
      throw new functions.https.HttpsError('invalid-argument', 'Cannot disable your own account')

    await admin.auth().updateUser(userId, { disabled })
    await db.collection('users').doc(userId).update({ disabled, isActive: !disabled })

    return { success: true }
  })
