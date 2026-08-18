import { admin, db, functions } from '../lib/admin'

export const bootstrapAdmin = functions
  .region('europe-west1')
  .https.onCall(async (_data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    // Only works when no admin exists in the system yet (first-caller-wins).
    // Once one admin exists this CF is permanently disabled — use setUserRole instead.
    const adminQuery = await db.collection('users').where('role', '==', 'admin').limit(1).get()
    if (!adminQuery.empty) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Un administrateur existe déjà. Utilisez le panneau Admin → Rôles pour gérer les accès.'
      )
    }

    await db.collection('users').doc(uid).set({ role: 'admin' }, { merge: true })
    await admin.auth().setCustomUserClaims(uid, { role: 'admin' })
    return { success: true }
  })
