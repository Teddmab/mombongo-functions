import { db, admin, functions } from '../lib/admin'

export const createFinancingApplication = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { farmerId, amountUsd }: { farmerId: string; amountUsd: number } = data
    if (!farmerId || amountUsd < 50)
      throw new functions.https.HttpsError('invalid-argument', 'farmerId required and minimum $50')

    await db.runTransaction(async tx => {
      const userRef   = db.collection('users').doc(uid)
      const farmerRef = db.collection('farmers').doc(farmerId)
      const [userSnap, farmerSnap] = await Promise.all([tx.get(userRef), tx.get(farmerRef)])

      if (!farmerSnap.exists || !['approved', 'active'].includes(farmerSnap.data()?.status))
        throw new functions.https.HttpsError('not-found', 'Farmer not available for funding')

      const walletUsd: number = userSnap.data()?.walletUsd ?? 0
      if (walletUsd < amountUsd)
        throw new functions.https.HttpsError('failed-precondition', 'Insufficient USD balance')

      const requested: number = farmerSnap.data()!.requestedAmountUsd
      const disbursed: number = farmerSnap.data()!.disbursedAmountUsd ?? 0
      const remaining = requested - disbursed
      if (amountUsd > remaining)
        throw new functions.https.HttpsError('invalid-argument', `Max fundable: $${remaining}`)

      const now    = admin.firestore.FieldValue.serverTimestamp()
      const appRef = db.collection('financing_applications').doc()
      const txRef  = db.collection('transactions').doc()

      tx.set(appRef, {
        farmerId,
        investorId: uid,
        amountUsd,
        tranches: [{ amountUsd, status: 'disbursed', disbursedAt: now }],
        status: 'active',
        cropType: farmerSnap.data()?.cropType,
        createdAt: now,
      })

      tx.update(userRef, { walletUsd: admin.firestore.FieldValue.increment(-amountUsd) })
      tx.update(farmerRef, {
        disbursedAmountUsd: admin.firestore.FieldValue.increment(amountUsd),
        status: 'active',
      })

      tx.set(txRef, {
        userId: uid,
        type: 'financing',
        amountUsd,
        farmerId,
        status: 'completed',
        createdAt: now,
      })
    })

    return { success: true }
  })
