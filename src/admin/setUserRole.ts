import * as admin from 'firebase-admin'
import * as functions from 'firebase-functions'

const db = admin.firestore()

export const setUserRole = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const callerSnap = await db.collection('users').doc(uid).get()
    if (callerSnap.data()?.role !== 'admin')
      throw new functions.https.HttpsError('permission-denied', 'Admin only')

    const { userId, role } = data as { userId: string; role: string }
    if (!userId || !role)
      throw new functions.https.HttpsError('invalid-argument', 'userId and role required')

    const allowed = ['investor', 'farmer', 'agent', 'merchant', 'admin']
    if (!allowed.includes(role))
      throw new functions.https.HttpsError('invalid-argument', `Role must be one of: ${allowed.join(', ')}`)

    await db.collection('users').doc(userId).update({ role })
    await admin.auth().setCustomUserClaims(userId, { role })

    return { success: true }
  })
