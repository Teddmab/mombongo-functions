import { admin, db, functions } from '../lib/admin'

export const createInvestment = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { productId, amountUsd } = data as { productId: string; amountUsd: number }

    if (!productId || !amountUsd || amountUsd <= 0)
      throw new functions.https.HttpsError('invalid-argument', 'Invalid payload')

    const investmentRef = db.collection('investments').doc()
    const txRef = db.collection('transactions').doc()
    const userRef = db.collection('users').doc(uid)
    const productRef = db.collection('products').doc(productId)

    await db.runTransaction(async tx => {
      const [userSnap, productSnap] = await Promise.all([
        tx.get(userRef),
        tx.get(productRef),
      ])

      if (!userSnap.exists)
        throw new functions.https.HttpsError('not-found', 'User not found')
      if (!productSnap.exists || productSnap.data()?.status !== 'active')
        throw new functions.https.HttpsError('not-found', 'Product not available')

      const walletUsd: number = userSnap.data()?.walletUsd ?? 0
      const minInvest: number = productSnap.data()?.minInvest ?? 0

      if (amountUsd < minInvest)
        throw new functions.https.HttpsError(
          'invalid-argument',
          `Minimum investment is $${minInvest}`
        )
      if (walletUsd < amountUsd)
        throw new functions.https.HttpsError('failed-precondition', 'Insufficient wallet balance')

      const now = admin.firestore.FieldValue.serverTimestamp()
      const durationDays: number = productSnap.data()?.durationDays ?? productSnap.data()?.duration ?? 30
      const roi: number = productSnap.data()?.roi ?? 0
      const harvestDate = new Date()
      harvestDate.setDate(harvestDate.getDate() + durationDays)
      const maturityDate = admin.firestore.Timestamp.fromDate(harvestDate)
      const expectedReturnUsd = parseFloat((amountUsd * (1 + roi / 100)).toFixed(2))

      tx.set(investmentRef, {
        investorId: uid,
        productId,
        amountUsd,
        roi,
        status: 'active',
        harvestDate: maturityDate,
        maturityDate,
        expectedReturnUsd,
        investedAt: now,
        productName: productSnap.data()?.name,
        productIcon: productSnap.data()?.icon,
      })

      tx.update(userRef, {
        walletUsd: admin.firestore.FieldValue.increment(-amountUsd),
        totalInvestedUsd: admin.firestore.FieldValue.increment(amountUsd),
      })

      tx.update(productRef, {
        invested: admin.firestore.FieldValue.increment(amountUsd),
        investorsCount: admin.firestore.FieldValue.increment(1),
      })

      tx.set(txRef, {
        userId: uid,
        type: 'investment',
        amountUsd,
        investmentId: investmentRef.id,
        productId,
        productName: productSnap.data()?.name,
        status: 'completed',
        createdAt: now,
      })
    })

    return { investmentId: investmentRef.id, txId: txRef.id }
  })
