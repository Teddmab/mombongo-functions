import { admin, functions } from '../lib/admin'

const db = admin.firestore()

async function releaseEscrow(contractId: string) {
  const contractRef = db.collection('bourse_contracts').doc(contractId)

  await db.runTransaction(async (tx) => {
    const contractSnap = await tx.get(contractRef)
    if (!contractSnap.exists) throw new functions.https.HttpsError('not-found', 'Contrat introuvable')
    const contract = contractSnap.data()!
    if (contract.status === 'fulfilled') return
    if (contract.escrowStatus !== 'funded') {
      throw new functions.https.HttpsError('failed-precondition', 'Séquestre non financé')
    }

    const amountCdf = contract.totalCdf as number
    const now = admin.firestore.FieldValue.serverTimestamp()
    const sellerRef = db.collection('users').doc(contract.sellerId as string)

    if (contract.escrowId) {
      tx.update(db.collection('escrow_accounts').doc(contract.escrowId as string), {
        status: 'released',
        releasedAt: now,
      })
    }

    tx.update(sellerRef, { walletCdf: admin.firestore.FieldValue.increment(amountCdf) })
    tx.update(contractRef, {
      status: 'fulfilled',
      escrowStatus: 'released',
      fulfilledAt: now,
      updatedAt: now,
    })

    if (contract.matchId) {
      tx.update(db.collection('bourse_matches').doc(contract.matchId as string), {
        status: 'completed',
        updatedAt: now,
      })
    }

    // Mark listing sold if present — listingId is on the match, read outside if needed
    const txRef = db.collection('transactions').doc()
    tx.set(txRef, {
      type: 'bourse_sale',
      fromUid: contract.buyerId,
      toUid: contract.sellerId,
      amountCdf,
      contractId,
      status: 'completed',
      createdAt: now,
    })
  })

  // Update listing status outside transaction (needs match lookup)
  const contractSnap = await contractRef.get()
  const matchId = contractSnap.data()?.matchId as string | undefined
  if (matchId) {
    const matchSnap = await db.collection('bourse_matches').doc(matchId).get()
    const listingId = matchSnap.data()?.listingId as string | undefined
    if (listingId) {
      await db.collection('product_listings').doc(listingId).update({
        status: 'sold',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      })
    }
  }
}

export const confirmDelivery = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { contractId } = (data ?? {}) as { contractId: string }
    if (!contractId) throw new functions.https.HttpsError('invalid-argument', 'contractId required')

    const contractSnap = await db.collection('bourse_contracts').doc(contractId).get()
    if (!contractSnap.exists) throw new functions.https.HttpsError('not-found', 'Contrat introuvable')

    const contract = contractSnap.data()!
    if (contract.buyerId !== uid) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'Seul l\'acheteur peut confirmer la réception',
      )
    }
    if (contract.status !== 'shipped') {
      throw new functions.https.HttpsError('failed-precondition', 'Expédition non confirmée')
    }

    await releaseEscrow(contractId)
    return { success: true, status: 'fulfilled' }
  })
