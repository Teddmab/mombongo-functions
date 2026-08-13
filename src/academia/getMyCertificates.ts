import * as admin from 'firebase-admin'
import * as functions from 'firebase-functions'

const db = admin.firestore()

export const getMyCertificates = functions
  .region('europe-west1')
  .https.onCall(async (_, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const snap = await db
      .collection('certificates')
      .where('userId', '==', uid)
      .orderBy('issuedAt', 'desc')
      .get()

    return { certificates: snap.docs.map(d => ({ id: d.id, ...d.data() })) }
  })
