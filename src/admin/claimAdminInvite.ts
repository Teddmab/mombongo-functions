import { admin, db, functions } from '../lib/admin'

export const claimAdminInvite = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { token } = data as { token?: string }
    if (!token) throw new functions.https.HttpsError('invalid-argument', 'Token requis')

    const now = admin.firestore.Timestamp.now()

    const inviteQuery = await db.collection('admin_invites')
      .where('token', '==', token)
      .where('claimed', '==', false)
      .limit(1)
      .get()

    if (inviteQuery.empty) {
      throw new functions.https.HttpsError('not-found', 'Invitation invalide ou déjà utilisée.')
    }

    const inviteDoc = inviteQuery.docs[0]
    if (inviteDoc.data().expiresAt.toMillis() < now.toMillis()) {
      throw new functions.https.HttpsError('deadline-exceeded', 'Cette invitation a expiré.')
    }

    // Mark claimed before setting role to prevent double-claim race
    await inviteDoc.ref.update({ claimed: true, claimedBy: uid, claimedAt: now })

    await db.collection('users').doc(uid).set({ role: 'admin' }, { merge: true })
    await admin.auth().setCustomUserClaims(uid, { role: 'admin' })

    return { success: true }
  })
