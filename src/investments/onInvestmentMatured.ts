import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const onInvestmentMatured = functions
  .region('europe-west1')
  .pubsub.schedule('every 24 hours')
  .timeZone('Africa/Kinshasa')
  .onRun(async () => {
    const now = admin.firestore.Timestamp.now()

    const snap = await db.collection('investments')
      .where('status', '==', 'active')
      .where('maturityDate', '<=', now)
      .limit(500)
      .get()

    if (snap.empty) return null

    const batch = db.batch()
    const fcmTokens: Array<{ token: string; investorId: string }> = []

    for (const doc of snap.docs) {
      batch.update(doc.ref, {
        status: 'matured',
        maturedAt: admin.firestore.FieldValue.serverTimestamp(),
      })

      const investorId: string = doc.data().investorId as string
      const userSnap = await db.collection('users').doc(investorId).get()
      const fcmToken: string | undefined = userSnap.data()?.fcmToken as string | undefined
      if (fcmToken) fcmTokens.push({ token: fcmToken, investorId })
    }

    await batch.commit()

    if (fcmTokens.length > 0) {
      const messaging = admin.messaging()
      await Promise.allSettled(
        fcmTokens.map(({ token }) =>
          messaging.send({
            token,
            notification: {
              title: '🎉 Investissement arrivé à terme',
              body: 'Votre investissement est arrivé à terme ! Vous recevrez bientôt votre remboursement.',
            },
          })
        )
      )
    }

    return null
  })
