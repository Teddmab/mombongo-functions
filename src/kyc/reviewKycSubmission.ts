import { admin, functions } from '../lib/admin'

const VALID_DECISIONS = ['verified', 'rejected', 'correction_requested'] as const
type Decision = typeof VALID_DECISIONS[number]

/**
 * users.kycStatus is read all over mombongo-web (KycScreen.tsx,
 * HomeScreen.tsx, useDashboardCTA.ts) and by getMomBongoScore — every one
 * of them checks for the string 'approved', not 'verified'. 'verified' was
 * this admin decision's own vocabulary; without this mapping, an admin
 * approving a submission would never actually register as KYC-complete
 * anywhere else in the app. kyc_submissions.status keeps the admin's own
 * three-value vocabulary (verified/rejected/correction_requested) since
 * that collection isn't read by farmer-facing code. correction_requested
 * maps to 'pending' on users.kycStatus — there is no fourth value in the
 * rest of the platform's kycStatus checks, so this is the closest safe
 * mapping (farmer still needs to resubmit) rather than inventing one.
 */
const USER_KYC_STATUS: Record<Decision, string> = {
  verified: 'approved',
  rejected: 'rejected',
  correction_requested: 'pending',
}

/**
 * Admin-only KYC decision — the only server-validated way to approve,
 * reject, or request a correction on a farmer's/user's KYC submission.
 * Replaces the client-side `updateDoc` writes the admin console used
 * before (no actor recorded, no auth check beyond Firestore rules).
 */
export const reviewKycSubmission = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const adminUid = context.auth?.uid
    if (!adminUid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const db = admin.firestore()
    const callerSnap = await db.collection('users').doc(adminUid).get()
    if (callerSnap.data()?.role !== 'admin')
      throw new functions.https.HttpsError('permission-denied', 'Admin only')

    const { uid, decision, reason } = data as { uid?: string; decision?: Decision; reason?: string }
    if (!uid) throw new functions.https.HttpsError('invalid-argument', 'uid required')
    if (!decision || !VALID_DECISIONS.includes(decision))
      throw new functions.https.HttpsError('invalid-argument', `decision must be one of ${VALID_DECISIONS.join(', ')}`)
    if (decision !== 'verified' && !reason?.trim())
      throw new functions.https.HttpsError('invalid-argument', 'reason is required for rejection or correction requests')

    const submissionRef = db.collection('kyc_submissions').doc(uid)
    const userRef = db.collection('users').doc(uid)

    await db.runTransaction(async (tx) => {
      const submissionSnap = await tx.get(submissionRef)
      if (!submissionSnap.exists)
        throw new functions.https.HttpsError('not-found', 'No KYC submission for this user')

      const now = admin.firestore.FieldValue.serverTimestamp()
      tx.update(submissionRef, {
        status: decision,
        reviewedAt: now,
        reviewedBy: adminUid,
        rejectionReason: decision === 'verified' ? null : reason!.trim(),
      })
      tx.update(userRef, {
        kycStatus: USER_KYC_STATUS[decision],
        updatedAt: now,
      })
    })

    functions.logger.info(`reviewKycSubmission: ${adminUid} set ${uid} → ${decision}`)
    return { success: true }
  })
