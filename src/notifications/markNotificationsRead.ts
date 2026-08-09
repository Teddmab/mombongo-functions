import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const markNotificationsRead = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { notificationIds = [] } = (data ?? {}) as { notificationIds?: string[] }
    const batch = db.batch()

    if (notificationIds.length === 0) {
      const snap = await db.collection('notifications')
        .where('userId', '==', uid)
        .where('read', '==', false)
        .limit(100)
        .get()
      snap.docs.forEach(d => batch.update(d.ref, { read: true }))
    } else {
      for (const id of notificationIds) {
        const ref = db.collection('notifications').doc(id)
        batch.update(ref, { read: true })
      }
    }

    await batch.commit()
    return { ok: true }
  })
