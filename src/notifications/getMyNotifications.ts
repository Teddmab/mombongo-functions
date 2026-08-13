import { admin, functions } from '../lib/admin'

const db = admin.firestore()

function toIso(ts: unknown): string {
  if (!ts) return new Date().toISOString()
  if (ts instanceof admin.firestore.Timestamp) return ts.toDate().toISOString()
  if (typeof ts === 'string') return ts
  return new Date().toISOString()
}

export const getMyNotifications = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const limit = Math.min((data?.limit ?? 50) as number, 100)

    const snap = await db.collection('notifications')
      .where('userId', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get()

    const notifications = snap.docs.map(d => {
      const n = d.data()
      return {
        id: d.id,
        type: (n.type as string) ?? 'system',
        title: (n.title as string) ?? '',
        body: (n.body as string) ?? '',
        read: (n.read as boolean) ?? false,
        data: (n.data as Record<string, string>) ?? {},
        createdAt: toIso(n.createdAt),
      }
    })

    const unreadCount = notifications.filter(n => !n.read).length

    return { notifications, unreadCount }
  })
