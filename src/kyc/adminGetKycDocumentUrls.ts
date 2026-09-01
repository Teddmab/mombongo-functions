import { admin, db, functions } from '../lib/admin'

/**
 * Admin-only, short-lived signed READ URLs for a farmer's KYC document
 * photos. kyc_submissions.photoUrls actually stores Storage object paths
 * (kyc_documents/{uid}/...), not public URLs — mombongo-admin's own
 * storage.rules has no rule for that path at all, so there was previously
 * no way for an admin to view these images short of the Firebase console.
 * Mirrors getKycUploadUrls' signed-URL pattern (mombongo-web), just for
 * reads instead of writes, and gated to admins instead of the document owner.
 */
export const adminGetKycDocumentUrls = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const callerUid = context.auth?.uid
    if (!callerUid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const callerSnap = await db.collection('users').doc(callerUid).get()
    if (callerSnap.data()?.role !== 'admin')
      throw new functions.https.HttpsError('permission-denied', 'Admin only')

    const { uid } = (data ?? {}) as { uid?: string }
    if (!uid) throw new functions.https.HttpsError('invalid-argument', 'uid required')

    const submissionSnap = await db.collection('kyc_submissions').doc(uid).get()
    if (!submissionSnap.exists) throw new functions.https.HttpsError('not-found', 'No KYC submission for this user')

    const submission = submissionSnap.data()!
    const paths = (submission.photoUrls as string[] | undefined) ?? []

    const urls = await Promise.all(
      paths.map(async (path) => {
        const [url] = await admin.storage().bucket().file(path).getSignedUrl({
          version: 'v4',
          action: 'read',
          expires: Date.now() + 10 * 60 * 1000, // 10 min — just long enough to review, not to leak
        })
        return url
      }),
    )

    return {
      documentType: submission.documentType ?? null,
      status: submission.status ?? 'pending',
      submittedAt: submission.submittedAt ?? null,
      reviewedAt: submission.reviewedAt ?? null,
      reviewedBy: submission.reviewedBy ?? null,
      rejectionReason: submission.rejectionReason ?? null,
      photoUrls: urls,
    }
  })
