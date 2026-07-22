import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const generateContract = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { matchId } = data as { matchId: string }

    const matchRef = db.collection('bourse_matches').doc(matchId)
    const contractRef = db.collection('bourse_contracts').doc()

    await db.runTransaction(async tx => {
      const matchSnap = await tx.get(matchRef)
      if (!matchSnap.exists) throw new functions.https.HttpsError('not-found', 'Match introuvable')

      const m = matchSnap.data()!
      if (m.buyerId !== uid && m.sellerId !== uid)
        throw new functions.https.HttpsError('permission-denied', 'Non autorisé')
      if (m.status !== 'agreed')
        throw new functions.https.HttpsError('failed-precondition', 'Un accord de prix est requis')
      if (m.contractId)
        throw new functions.https.HttpsError('already-exists', 'Contrat déjà généré')

      const now = admin.firestore.FieldValue.serverTimestamp()
      const totalCdf = m.agreedPricePerKgCdf * m.quantityKg

      tx.set(contractRef, {
        matchId,
        listingId: m.listingId,
        orderId: m.orderId,
        sellerId: m.sellerId,
        buyerId: m.buyerId,
        commodity: m.commodity,
        quantityKg: m.quantityKg,
        agreedPricePerKgCdf: m.agreedPricePerKgCdf,
        totalCdf,
        status: 'pending_signature',
        sellerSignedAt: null,
        buyerSignedAt: null,
        createdAt: now,
        updatedAt: now,
      })

      tx.update(matchRef, {
        status: 'contracted',
        contractId: contractRef.id,
        updatedAt: now,
      })
    })

    return { contractId: contractRef.id }
  })
