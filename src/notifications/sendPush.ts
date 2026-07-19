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
  // Support both legacy single token and array of tokens
  const tokens: string[] = Array.isArray(userData.fcmTokens)
    ? userData.fcmTokens
    : userData.fcmToken
    ? [userData.fcmToken]
    : []

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
