import { admin, functions } from '../lib/admin'
import { sendPush } from './sendPush'

const db = admin.firestore()

export const adminSendPush = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    if (!context.auth?.uid)
      throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const callerSnap = await db.collection('users').doc(context.auth.uid).get()
    if (callerSnap.data()?.role !== 'admin')
      throw new functions.https.HttpsError('permission-denied', 'Admin only')

    const { targetUid, targetRole, title, body, screen, crop, province } = data as {
      targetUid?: string
      targetRole?: string
      title: string
      body: string
      screen?: string
      crop?: string
      province?: string
    }

    if (!title || !body)
      throw new functions.https.HttpsError('invalid-argument', 'title and body required')

    const pushData: Record<string, string> = {}
    if (screen)   pushData.screen   = screen
    if (crop)     pushData.crop     = crop
    if (province) pushData.province = province

    const results = { sent: 0, failed: 0 }

    if (targetUid) {
      try {
        await sendPush(targetUid, title, body, pushData)
        results.sent++
      } catch {
        results.failed++
      }
    } else if (targetRole) {
      const snap = await db.collection('users').where('role', '==', targetRole).get()
      await Promise.all(snap.docs.map(async doc => {
        try {
          await sendPush(doc.id, title, body, pushData)
          results.sent++
        } catch {
          results.failed++
        }
      }))
    } else {
      throw new functions.https.HttpsError('invalid-argument', 'targetUid or targetRole required')
    }

    await db.collection('admin_push_log').add({
      title,
      body,
      screen: screen ?? null,
      targetUid: targetUid ?? null,
      targetRole: targetRole ?? null,
      results,
      sentBy: context.auth.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    })

    return results
  })
