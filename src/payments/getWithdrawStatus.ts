import { db, functions } from '../lib/admin'

export const getWithdrawStatus = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { payoutId } = data as { payoutId: string }
    const snap = await db.collection('withdrawals').doc(payoutId).get()

    if (!snap.exists || snap.data()?.userId !== uid)
      throw new functions.https.HttpsError('not-found', 'Withdrawal not found')

    return {
      status: snap.data()?.status as string,
      amountUsd: snap.data()?.amountUsd as number,
    }
  })
