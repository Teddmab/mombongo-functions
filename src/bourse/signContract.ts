import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const signContract = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { contractId } = data as { contractId: string }

    const contractRef = db.collection('bourse_contracts').doc(contractId)

    await db.runTransaction(async tx => {
      const snap = await tx.get(contractRef)
      if (!snap.exists) throw new functions.https.HttpsError('not-found', 'Contrat introuvable')

      const c = snap.data()!
      if (c.buyerId !== uid && c.sellerId !== uid)
        throw new functions.https.HttpsError('permission-denied', 'Non autorisé')
      if (!['pending_signature', 'partially_signed'].includes(c.status))
        throw new functions.https.HttpsError('failed-precondition', 'Statut invalide')

      const now = admin.firestore.FieldValue.serverTimestamp()
      const isBuyer = c.buyerId === uid
      const updateData: Record<string, unknown> = {}

      if (isBuyer) {
        if (c.buyerSignedAt) throw new functions.https.HttpsError('already-exists', 'Déjà signé')
        updateData.buyerSignedAt = now
      } else {
        if (c.sellerSignedAt) throw new functions.https.HttpsError('already-exists', 'Déjà signé')
        updateData.sellerSignedAt = now
      }

      const bothSigned = isBuyer ? !!c.sellerSignedAt : !!c.buyerSignedAt
      updateData.status = bothSigned ? 'active' : 'partially_signed'
      updateData.updatedAt = now

      tx.update(contractRef, updateData)
    })

    return { ok: true }
  })
