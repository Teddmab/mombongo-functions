import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const generateContract = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { matchId } = (data ?? {}) as { matchId: string }
    if (!matchId) throw new functions.https.HttpsError('invalid-argument', 'matchId required')

    const matchRef = db.collection('bourse_matches').doc(matchId)
    const matchSnap = await matchRef.get()
    if (!matchSnap.exists) throw new functions.https.HttpsError('not-found', 'Match introuvable')

    const match = matchSnap.data()!
    if (match.status !== 'agreed') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        "Les parties n'ont pas encore conclu un accord",
      )
    }
    if (match.buyerId !== uid && match.sellerId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Non autorisé')
    }

    if (match.contractId) {
      return { contractId: match.contractId as string }
    }

    const now = admin.firestore.FieldValue.serverTimestamp()
    const deliveryDeadline = new Date()
    deliveryDeadline.setDate(deliveryDeadline.getDate() + 14)

    const contractRef = db.collection('bourse_contracts').doc()
    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(matchRef)
      const m = fresh.data()!
      if (m.contractId) return
      if (m.status !== 'agreed') {
        throw new functions.https.HttpsError('failed-precondition', 'Accord requis')
      }
      tx.set(contractRef, {
        matchId,
        sellerId: m.sellerId,
        buyerId: m.buyerId,
        commodity: m.commodity,
        quantityKg: m.quantityKg,
        pricePerKgCdf: m.agreedPricePerKgCdf,
        totalCdf: m.totalCdf,
        deliveryLocation: 'À confirmer par les parties',
        paymentTerms: 'escrow',
        deliveryDeadline: admin.firestore.Timestamp.fromDate(deliveryDeadline),
        sellerSignedAt: null,
        buyerSignedAt: null,
        status: 'pending_signatures',
        escrowStatus: null,
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
