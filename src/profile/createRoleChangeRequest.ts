import { admin, db, functions } from '../lib/admin'

export const createRoleChangeRequest = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { currentRole, requestedRole, reason } = data as {
      currentRole: string
      requestedRole: string
      reason: string
    }

    if (!currentRole || !requestedRole || !reason?.trim()) {
      throw new functions.https.HttpsError('invalid-argument', 'currentRole, requestedRole and reason are required')
    }

    if (currentRole === requestedRole) {
      throw new functions.https.HttpsError('invalid-argument', 'requestedRole must differ from currentRole')
    }

    const allowed = ['investor', 'farmer', 'merchant']
    if (!allowed.includes(requestedRole)) {
      throw new functions.https.HttpsError('invalid-argument', `requestedRole must be one of: ${allowed.join(', ')}`)
    }

    const ref = db.collection('role_change_requests').doc()
    await ref.set({
      uid,
      currentRole,
      requestedRole,
      reason: reason.trim(),
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    })

    return { requestId: ref.id }
  })
