import { admin, db, functions } from '../lib/admin'

export const processWalletPayment = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { amountUsd, type, referenceId } = data as {
      amountUsd: number
      type: 'support' | 'reserve' | 'subscribe'
      referenceId?: string
    }

    if (!amountUsd || amountUsd <= 0)
      throw new functions.https.HttpsError('invalid-argument', 'Montant invalide')

    const userRef = db.collection('users').doc(uid)
    const now = admin.firestore.FieldValue.serverTimestamp()

    await db.runTransaction(async tx => {
      const snap = await tx.get(userRef)
      if (!snap.exists)
        throw new functions.https.HttpsError('not-found', 'Utilisateur introuvable')

      const walletUsd: number = snap.data()?.walletUsd ?? 0
      if (walletUsd < amountUsd)
        throw new functions.https.HttpsError('failed-precondition', 'Solde insuffisant')

      tx.update(userRef, {
        walletUsd: admin.firestore.FieldValue.increment(-amountUsd),
        updatedAt: now,
      })

      tx.set(db.collection('transactions').doc(), {
        userId: uid,
        type,
        amountUsd,
        referenceId: referenceId ?? null,
        method: 'wallet',
        status: 'completed',
        createdAt: now,
      })
    })

    return { success: true }
  })
