import { admin, functions } from '../lib/admin'

/**
 * Admin-only secure preview for KYC documents. `kyc_submissions/{uid}.photoUrls`
 * stores private Storage paths (never public URLs) — this mints short-lived
 * v4 signed read URLs on demand so the admin console never embeds or logs a
 * long-lived/public link to an identity document.
 */
export const getKycDocumentViewUrl = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const adminUid = context.auth?.uid
    if (!adminUid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const db = admin.firestore()
    const callerSnap = await db.collection('users').doc(adminUid).get()
    if (callerSnap.data()?.role !== 'admin')
      throw new functions.https.HttpsError('permission-denied', 'Admin only')

    const { uid } = data as { uid?: string }
    if (!uid) throw new functions.https.HttpsError('invalid-argument', 'uid required')

    const submissionSnap = await db.collection('kyc_submissions').doc(uid).get()
    if (!submissionSnap.exists)
      throw new functions.https.HttpsError('not-found', 'No KYC submission for this user')

    const { documentType, photoUrls } = submissionSnap.data() as { documentType: string; photoUrls: string[] }

    const urls = await Promise.all(
      (photoUrls ?? []).map(async (path) => {
        const [url] = await admin.storage().bucket().file(path).getSignedUrl({
          version: 'v4',
          action: 'read',
          expires: Date.now() + 10 * 60 * 1000,
        })
        return url
      }),
    )

    return { documentType, urls }
  })
