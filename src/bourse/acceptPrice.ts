import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const acceptPrice = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { matchId, negotiationId } = data as { matchId: string; negotiationId: string }

    const matchRef = db.collection('bourse_matches').doc(matchId)
    const negRef = matchRef.collection('negotiations').doc(negotiationId)

    await db.runTransaction(async tx => {
      const [matchSnap, negSnap] = await Promise.all([tx.get(matchRef), tx.get(negRef)])

      if (!matchSnap.exists) throw new functions.https.HttpsError('not-found', 'Match introuvable')
      if (!negSnap.exists) throw new functions.https.HttpsError('not-found', 'Proposition introuvable')

      const matchData = matchSnap.data()!
      const negData = negSnap.data()!

      if (matchData.buyerId !== uid && matchData.sellerId !== uid)
        throw new functions.https.HttpsError('permission-denied', 'Non autorisé')
      // Can't accept your own proposal
      if (negData.proposedBy === uid)
        throw new functions.https.HttpsError('failed-precondition', 'Vous ne pouvez pas accepter votre propre offre')
      if (negData.status !== 'pending')
        throw new functions.https.HttpsError('failed-precondition', 'Proposition déjà traitée')

      const now = admin.firestore.FieldValue.serverTimestamp()
      tx.update(negRef, { status: 'accepted', acceptedAt: now })
      tx.update(matchRef, {
        status: 'agreed',
        agreedPricePerKgCdf: negData.proposedPricePerKgCdf,
        updatedAt: now,
      })
    })

    return { ok: true }
  })
