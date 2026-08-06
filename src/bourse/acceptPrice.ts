import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const acceptPrice = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { matchId, negotiationId } = (data ?? {}) as {
      matchId: string
      negotiationId?: string
    }

    if (!matchId) throw new functions.https.HttpsError('invalid-argument', 'matchId required')

    const matchRef = db.collection('bourse_matches').doc(matchId)
    const matchSnap = await matchRef.get()
    if (!matchSnap.exists) throw new functions.https.HttpsError('not-found', 'Match introuvable')

    const match = matchSnap.data()!
    if (match.sellerId !== uid && match.buyerId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Non autorisé')
    }
    if (match.status !== 'pending_negotiation') {
      throw new functions.https.HttpsError('failed-precondition', 'Négociation fermée')
    }

    let negRef = negotiationId
      ? matchRef.collection('negotiations').doc(negotiationId)
      : undefined

    if (!negRef) {
      const negsSnap = await matchRef
        .collection('negotiations')
        .orderBy('createdAt', 'desc')
        .limit(1)
        .get()
      if (negsSnap.empty) {
        throw new functions.https.HttpsError('failed-precondition', 'Aucune proposition')
      }
      negRef = negsSnap.docs[0].ref
    }

    const negSnap = await negRef.get()
    if (!negSnap.exists) throw new functions.https.HttpsError('not-found', 'Proposition introuvable')
    const lastProposal = negSnap.data()!

    if (lastProposal.proposedByUid === uid) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Vous ne pouvez pas accepter votre propre proposition',
      )
    }

    const agreedPricePerKgCdf: number = lastProposal.proposedPricePerKgCdf
    const totalCdf = agreedPricePerKgCdf * (match.quantityKg as number)
    const now = admin.firestore.FieldValue.serverTimestamp()

    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(matchRef)
      if (!fresh.exists || fresh.data()?.status !== 'pending_negotiation') {
        throw new functions.https.HttpsError('failed-precondition', 'Négociation fermée')
      }
      tx.update(negRef!, { status: 'accepted' })
      tx.update(matchRef, {
        status: 'agreed',
        agreedPricePerKgCdf,
        totalCdf,
        updatedAt: now,
      })
    })

    return { success: true, ok: true, agreedPricePerKgCdf, totalCdf }
  })
