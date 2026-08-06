import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const signContract = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { contractId } = (data ?? {}) as { contractId: string }
    if (!contractId) throw new functions.https.HttpsError('invalid-argument', 'contractId required')

    const contractRef = db.collection('bourse_contracts').doc(contractId)

    const status = await db.runTransaction(async (tx) => {
      const snap = await tx.get(contractRef)
      if (!snap.exists) throw new functions.https.HttpsError('not-found', 'Contrat introuvable')

      const contract = snap.data()!
      const isSeller = contract.sellerId === uid
      const isBuyer = contract.buyerId === uid
      if (!isSeller && !isBuyer) {
        throw new functions.https.HttpsError('permission-denied', 'Non autorisé')
      }

      const now = admin.firestore.FieldValue.serverTimestamp()
      const update: Record<string, unknown> = { updatedAt: now }

      if (isSeller && !contract.sellerSignedAt) update.sellerSignedAt = now
      if (isBuyer && !contract.buyerSignedAt) update.buyerSignedAt = now

      const sellerSigned = isSeller ? true : !!contract.sellerSignedAt
      const buyerSigned = isBuyer ? true : !!contract.buyerSignedAt
      const nextStatus = sellerSigned && buyerSigned ? 'active' : 'pending_signatures'
      if (sellerSigned && buyerSigned) update.status = 'active'

      tx.update(contractRef, update)
      return nextStatus
    })

    return { status }
  })
