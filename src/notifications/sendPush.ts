import * as admin from 'firebase-admin'

const db = admin.firestore()

export interface SendPushResult {
  sent: number      // actual FCM delivery successes
  failed: number    // actual FCM delivery failures
  noTokens: boolean // true when the user had no registered FCM tokens
}

/**
 * Send a push notification to all FCM tokens registered for a user.
 * Silently removes invalid tokens.
 * Returns actual per-token delivery counts from FCM, not just whether the call threw.
 */
export async function sendPush(
  uid: string,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<SendPushResult> {
  const userSnap = await db.collection('users').doc(uid).get()
  if (!userSnap.exists) return { sent: 0, failed: 0, noTokens: true }

  const userData = userSnap.data()!
  const arrayTokens: string[] = Array.isArray(userData.fcmTokens) ? userData.fcmTokens : []
  const singleToken: string[] = userData.fcmToken ? [userData.fcmToken as string] : []
  const tokens: string[] = [...new Set([...arrayTokens, ...singleToken])].filter(Boolean)

  if (tokens.length === 0) return { sent: 0, failed: 0, noTokens: true }

  const message: admin.messaging.MulticastMessage = {
    tokens,
    notification: { title, body },
    data: data ?? {},
    android: { priority: 'high' },
    apns: { payload: { aps: { sound: 'default' } } },
    webpush: {
      notification: { title, body, icon: '/favicon.png' },
    },
  }

  const response = await admin.messaging().sendEachForMulticast(message)

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

  return {
    sent: response.successCount,
    failed: response.failureCount,
    noTokens: false,
  }
}
