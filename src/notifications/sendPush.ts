import * as admin from 'firebase-admin'

const db = admin.firestore()

/**
 * Send a push notification to all FCM tokens registered for a user.
 * Silently removes invalid tokens.
 */
export async function sendPush(
  uid: string,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<void> {
  const userSnap = await db.collection('users').doc(uid).get()
  if (!userSnap.exists) return

  const userData = userSnap.data()!
  // Merge array tokens (current) with singular token (legacy).
  // fcmTokens is always initialised as [] at signup so Array.isArray() is always
  // true — we must also check the singular fcmToken field regardless.
  const arrayTokens: string[] = Array.isArray(userData.fcmTokens) ? userData.fcmTokens : []
  const singleToken: string[] = userData.fcmToken ? [userData.fcmToken as string] : []
  const tokens: string[] = [...new Set([...arrayTokens, ...singleToken])].filter(Boolean)

  if (tokens.length === 0) return

  const message: admin.messaging.MulticastMessage = {
    tokens,
    notification: { title, body },
    data: data ?? {},
    android: { priority: 'high' },
    apns: { payload: { aps: { sound: 'default' } } },
  }

  const response = await admin.messaging().sendEachForMulticast(message)

  // Remove invalid/expired tokens
  const invalidTokens: string[] = []
  response.responses.forEach((r, i) => {
    if (!r.success && (
      r.error?.code === 'messaging/registration-token-not-registered' ||
      r.error?.code === 'messaging/invalid-registration-token'
    )) {
      invalidTokens.push(tokens[i])
    }
  })

  if (invalidTokens.length > 0) {
    await db.collection('users').doc(uid).update({
      fcmTokens: admin.firestore.FieldValue.arrayRemove(...invalidTokens),
    })
  }
}
