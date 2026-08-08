import { admin, functions } from '../lib/admin'

export const getMyKycSubmission = functions
  .region('europe-west1')
  .https.onCall(async (_data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const db = admin.firestore()
    const snap = await db.collection('kyc_submissions').doc(uid).get()
    if (!snap.exists) return { submission: null, history: [] }

    const doc = snap.data()!

    // Return history (previous submissions), newest first
    const historySnap = await db
      .collection('kyc_submissions')
      .doc(uid)
      .collection('history')
      .orderBy('submittedAt', 'desc')
      .limit(10)
      .get()

    const history = historySnap.docs.map((d) => {
      const h = d.data()
      return {
        documentType: h.documentType as string,
        submittedAt:  (h.submittedAt?.toDate?.() ?? new Date()).toISOString(),
        photoCount:   Array.isArray(h.photoUrls) ? h.photoUrls.length : 0,
      }
    })

    return {
      submission: {
        documentType: doc.documentType as string,
        submittedAt:  (doc.submittedAt?.toDate?.() ?? new Date()).toISOString(),
        photoCount:   Array.isArray(doc.photoUrls) ? doc.photoUrls.length : 0,
      },
      history,
    }
  })
