import { admin, db, functions } from '../lib/admin'

const DECISIONS = ['approve', 'reject', 'request_correction'] as const
type Decision = typeof DECISIONS[number]

/**
 * Replaces the client-side `updateDoc(users/{id}, {kycStatus})` calls that
 * used to live directly in mombongo-admin (AdminKyc.tsx, AdminFarmers.tsx,
 * admin.service.ts) — those were unauthenticated-by-rules writes with no
 * audit trail, double-submit guard, or reason capture. This is the single
 * secure path for a KYC decision from here on.
 *
 * kyc_submissions.status carries the fine-grained state (pending |
 * correction_requested | approved | rejected) that only admin's own queue
 * needs. users.kycStatus stays on the 3-value vocabulary the farmer-facing
 * KycScreen (mombongo-web) already branches on (none | pending | approved |
 * rejected) — 'correction_requested' deliberately maps to 'pending' there
 * rather than a 4th value the farmer UI doesn't know how to render.
 * Known gap: the correction reason isn't yet surfaced back to the farmer
 * anywhere in mombongo-web — flagged, not fixed here (out of this repo's
 * scope for this story).
 */
export const adminReviewKyc = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const callerUid = context.auth?.uid
    if (!callerUid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const callerSnap = await db.collection('users').doc(callerUid).get()
    if (callerSnap.data()?.role !== 'admin')
      throw new functions.https.HttpsError('permission-denied', 'Admin only')

    const { uid, decision, reason } = (data ?? {}) as { uid?: string; decision?: Decision; reason?: string }
    if (!uid) throw new functions.https.HttpsError('invalid-argument', 'uid required')
    if (!decision || !DECISIONS.includes(decision))
      throw new functions.https.HttpsError('invalid-argument', `decision must be one of: ${DECISIONS.join(', ')}`)
    if ((decision === 'reject' || decision === 'request_correction') && !reason?.trim())
      throw new functions.https.HttpsError('invalid-argument', 'reason is required for reject/request_correction')

    const submissionRef = db.collection('kyc_submissions').doc(uid)
    const userRef = db.collection('users').doc(uid)

    const newStatus = await db.runTransaction(async (tx) => {
      const submissionSnap = await tx.get(submissionRef)
      if (!submissionSnap.exists) throw new functions.https.HttpsError('not-found', 'No KYC submission for this user')

      const currentStatus = submissionSnap.data()?.status
      if (currentStatus !== 'pending') {
        // Idempotency / double-submit guard — a decision was already made
        // (or is being made by someone else's request) since this queue
        // entry was loaded.
        throw new functions.https.HttpsError(
          'failed-precondition',
          `Ce dossier a déjà été traité (statut actuel : ${currentStatus}).`,
        )
      }

      const now = admin.firestore.FieldValue.serverTimestamp()
      const submissionUpdate: Record<string, unknown> = { reviewedAt: now, reviewedBy: callerUid }
      const userUpdate: Record<string, unknown> = { updatedAt: now }

      if (decision === 'approve') {
        submissionUpdate.status = 'approved'
        submissionUpdate.rejectionReason = null
        userUpdate.kycStatus = 'approved'
        userUpdate.kycVerifiedAt = now
      } else if (decision === 'reject') {
        submissionUpdate.status = 'rejected'
        submissionUpdate.rejectionReason = reason!.trim()
        userUpdate.kycStatus = 'rejected'
      } else {
        submissionUpdate.status = 'correction_requested'
        submissionUpdate.rejectionReason = reason!.trim()
        userUpdate.kycStatus = 'pending'
      }

      tx.update(submissionRef, submissionUpdate)
      tx.update(userRef, userUpdate)
      return submissionUpdate.status as string
    })

    return { success: true, status: newStatus }
  })
