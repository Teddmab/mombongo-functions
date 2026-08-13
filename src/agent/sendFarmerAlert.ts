import { db, admin, functions } from '../lib/admin'

export const sendFarmerAlert = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const agentUid = context.auth?.uid
    if (!agentUid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { farmerId, message } = data as { farmerId: string; message: string }
    if (!farmerId || !message)
      throw new functions.https.HttpsError('invalid-argument', 'farmerId and message are required')

    const farmerSnap = await db.collection('users').doc(farmerId).get()
    if (!farmerSnap.exists) throw new functions.https.HttpsError('not-found', 'Agriculteur introuvable')
    const farmer = farmerSnap.data()!

    if (farmer.agentId !== agentUid)
      throw new functions.https.HttpsError('permission-denied', "Pas dans votre portefeuille")

    await db.collection('notifications').add({
      userId: farmerId,
      type: 'system',
      title: 'Message de votre agent terrain',
      body: message,
      read: false,
      data: { agentId: agentUid },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    })

    const tokens: string[] = farmer.fcmTokens ?? []
    if (tokens.length > 0) {
      try {
        const { getMessaging } = await import('firebase-admin/messaging')
        await getMessaging().sendEachForMulticast({
          tokens,
          notification: { title: 'Message de votre agent terrain', body: message },
          data: { type: 'system', agentId: agentUid },
        })
      } catch {
        // FCM failure is non-fatal — notification is already written to Firestore
      }
    }

    return { ok: true }
  })
