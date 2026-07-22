import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const proposePrice = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { matchId, proposedPricePerKgCdf, message } = data as {
      matchId: string
      proposedPricePerKgCdf: number
      message?: string
    }

    if (!(proposedPricePerKgCdf > 0))
      throw new functions.https.HttpsError('invalid-argument', 'Prix invalide')

    const matchRef = db.collection('bourse_matches').doc(matchId)
    const matchSnap = await matchRef.get()
    if (!matchSnap.exists) throw new functions.https.HttpsError('not-found', 'Match introuvable')

    const matchData = matchSnap.data()!
    if (matchData.buyerId !== uid && matchData.sellerId !== uid)
      throw new functions.https.HttpsError('permission-denied', 'Non autorisé')
    if (!['pending_negotiation', 'agreed'].includes(matchData.status))
      throw new functions.https.HttpsError('failed-precondition', 'Statut invalide')

    const userSnap = await db.collection('users').doc(uid).get()
    const proposerName: string = userSnap.data()?.fullName ?? 'Utilisateur'
    const proposerRole: string = uid === matchData.buyerId ? 'buyer' : 'seller'

    const now = admin.firestore.FieldValue.serverTimestamp()
    const negRef = matchRef.collection('negotiations').doc()

    await negRef.set({
      proposedBy: uid,
      proposerName,
      proposerRole,
      proposedPricePerKgCdf,
      message: message ?? '',
      status: 'pending',
      createdAt: now,
    })

    await matchRef.update({ status: 'pending_negotiation', updatedAt: now })

    return { negotiationId: negRef.id }
  })
