import { db, functions } from '../lib/admin'

export const getDepositStatus = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { depositId } = data as { depositId: string }
    if (!depositId) throw new functions.https.HttpsError('invalid-argument', 'depositId required')

    const snap = await db.collection('deposits').doc(depositId).get()
    if (!snap.exists || snap.data()?.userId !== uid)
      throw new functions.https.HttpsError('not-found', 'Deposit not found')

    return {
      status: snap.data()?.status as string,
      amountUsd: snap.data()?.amountUsd as number,
    }
  })
