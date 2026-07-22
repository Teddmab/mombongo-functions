import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const fundEscrow = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { contractId } = data as { contractId: string }

    const contractRef = db.collection('bourse_contracts').doc(contractId)
    const escrowRef = db.collection('escrow_accounts').doc(contractId)
    const walletRef = db.collection('wallets').doc(uid)

    await db.runTransaction(async tx => {
      const [contractSnap, escrowSnap, walletSnap] = await Promise.all([
        tx.get(contractRef),
        tx.get(escrowRef),
        tx.get(walletRef),
      ])

      if (!contractSnap.exists) throw new functions.https.HttpsError('not-found', 'Contrat introuvable')

      const c = contractSnap.data()!
      if (c.buyerId !== uid)
        throw new functions.https.HttpsError('permission-denied', "Seul l'acheteur peut financer le sequestre")
      if (c.status !== 'active')
        throw new functions.https.HttpsError('failed-precondition', 'Contrat non actif')
      if (escrowSnap.exists)
        throw new functions.https.HttpsError('already-exists', 'Séquestre déjà financé')

      const walletCdf: number = walletSnap.data()?.balanceCdf ?? 0
      if (walletCdf < c.totalCdf)
        throw new functions.https.HttpsError('failed-precondition', 'Solde insuffisant')

      const now = admin.firestore.FieldValue.serverTimestamp()

      tx.update(walletRef, {
        balanceCdf: admin.firestore.FieldValue.increment(-c.totalCdf),
        updatedAt: now,
      })

      tx.set(escrowRef, {
        contractId,
        buyerId: c.buyerId,
        sellerId: c.sellerId,
        amountCdf: c.totalCdf,
        status: 'held',
        createdAt: now,
      })

      tx.update(contractRef, { status: 'funded', updatedAt: now })
    })

    return { ok: true }
  })
