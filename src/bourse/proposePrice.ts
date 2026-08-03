import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const proposePrice = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { matchId, proposedPricePerKgCdf, message } = (data ?? {}) as {
      matchId: string
      proposedPricePerKgCdf: number
      message?: string
    }

    if (!matchId || !proposedPricePerKgCdf || proposedPricePerKgCdf <= 0) {
      throw new functions.https.HttpsError('invalid-argument', 'matchId and proposedPricePerKgCdf required')
    }

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

    const proposedBy: 'seller' | 'buyer' = match.sellerId === uid ? 'seller' : 'buyer'
    const now = admin.firestore.FieldValue.serverTimestamp()
    const negRef = matchRef.collection('negotiations').doc()

    await negRef.set({
      proposedBy,
      proposedByUid: uid,
      proposerRole: proposedBy,
      proposedPricePerKgCdf,
      message: message ?? '',
      status: 'pending',
      createdAt: now,
    })

    await matchRef.update({ updatedAt: now })

    return { negotiationId: negRef.id, success: true }
  })
