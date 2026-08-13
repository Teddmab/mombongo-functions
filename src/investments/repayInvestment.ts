import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const repayInvestment = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    // Verify admin role
    const callerSnap = await db.collection('users').doc(uid).get()
    const callerRole: string = (callerSnap.data()?.role as string) ?? ''
    if (callerRole !== 'admin')
      throw new functions.https.HttpsError('permission-denied', 'Admin only')

    const { investmentId, repaidAmountUsd } = data as {
      investmentId: string
      repaidAmountUsd: number
    }
    if (!investmentId || !repaidAmountUsd || repaidAmountUsd <= 0)
      throw new functions.https.HttpsError('invalid-argument', 'investmentId and repaidAmountUsd required')

    const investRef = db.collection('investments').doc(investmentId)
    const txRef = db.collection('transactions').doc()

    await db.runTransaction(async tx => {
      const invSnap = await tx.get(investRef)
      if (!invSnap.exists)
        throw new functions.https.HttpsError('not-found', 'Investment not found')

      const inv = invSnap.data()!
      if (!['active', 'matured'].includes(inv.status as string))
        throw new functions.https.HttpsError('failed-precondition', 'Investment already repaid or cancelled')

      const investorId: string = inv.investorId as string
      const userRef = db.collection('users').doc(investorId)
      const now = admin.firestore.FieldValue.serverTimestamp()

      tx.update(investRef, {
        status: 'repaid',
        repaidAt: now,
        repaidAmountUsd,
      })

      tx.update(userRef, {
        walletUsd: admin.firestore.FieldValue.increment(repaidAmountUsd),
        totalEarnedUsd: admin.firestore.FieldValue.increment(
          repaidAmountUsd - ((inv.amountUsd as number) ?? 0)
        ),
      })

      tx.set(txRef, {
        userId: investorId,
        type: 'repayment',
        amountUsd: repaidAmountUsd,
        investmentId,
        productId: (inv.productId as string) ?? null,
        productName: (inv.productName as string) ?? '',
        status: 'completed',
        createdAt: now,
      })
    })

    // Send push notification
    const investorSnap = await db.collection('users')
      .doc((await investRef.get()).data()!.investorId as string)
      .get()
    const fcmToken: string | undefined = investorSnap.data()?.fcmToken as string | undefined
    if (fcmToken) {
      await admin.messaging().send({
        token: fcmToken,
        notification: {
          title: '✅ Remboursement reçu',
          body: `Votre remboursement de $${repaidAmountUsd.toFixed(2)} a été crédité sur votre portefeuille.`,
        },
      }).catch(() => undefined)
    }

    return { ok: true, txId: txRef.id }
  })
