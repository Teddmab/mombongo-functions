import * as admin from 'firebase-admin'
import * as functions from 'firebase-functions'

const db = admin.firestore()

export const createBourseInvestment = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { opportunityId, amountCdf }: { opportunityId: string; amountCdf: number } = data
    if (!opportunityId) throw new functions.https.HttpsError('invalid-argument', 'opportunityId required')
    if (!amountCdf || amountCdf < 10_000)
      throw new functions.https.HttpsError('invalid-argument', 'Minimum 10,000 FC')

    await db.runTransaction(async tx => {
      const userRef = db.collection('users').doc(uid)
      const oppRef  = db.collection('bourse_opportunities').doc(opportunityId)
      const [userSnap, oppSnap] = await Promise.all([tx.get(userRef), tx.get(oppRef)])

      if (!oppSnap.exists || oppSnap.data()?.status !== 'open')
        throw new functions.https.HttpsError('not-found', 'Opportunity not available')

      const walletCdf: number = userSnap.data()?.walletCdf ?? 0
      if (walletCdf < amountCdf)
        throw new functions.https.HttpsError('failed-precondition', 'Insufficient CDF balance')

      const now = admin.firestore.FieldValue.serverTimestamp()
      const invRef = db.collection('bourse_investments').doc()
      const txRef  = db.collection('transactions').doc()
      const opp = oppSnap.data()!
      const pricePerKg = opp.targetCdf && opp.capacityKg ? opp.targetCdf / opp.capacityKg : 1

      tx.set(invRef, {
        investorId: uid,
        opportunityId,
        amountCdf,
        commission: opp.commission ?? 0,
        status: 'active',
        route: opp.route ?? null,
        commodity: opp.commodity ?? null,
        investedAt: now,
      })

      tx.update(userRef, { walletCdf: admin.firestore.FieldValue.increment(-amountCdf) })
      tx.update(oppRef, {
        filledKg: admin.firestore.FieldValue.increment(amountCdf / pricePerKg),
        investorsCount: admin.firestore.FieldValue.increment(1),
      })

      tx.set(txRef, {
        userId: uid,
        type: 'bourse_investment',
        amountCdf,
        opportunityId,
        status: 'completed',
        createdAt: now,
      })
    })

    return { success: true }
  })
