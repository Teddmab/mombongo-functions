import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const confirmDelivery = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { contractId } = data as { contractId: string }

    const contractRef = db.collection('bourse_contracts').doc(contractId)
    const escrowRef = db.collection('escrow_accounts').doc(contractId)

    await db.runTransaction(async tx => {
      const [contractSnap, escrowSnap] = await Promise.all([
        tx.get(contractRef),
        tx.get(escrowRef),
      ])

      if (!contractSnap.exists) throw new functions.https.HttpsError('not-found', 'Contrat introuvable')
      if (!escrowSnap.exists) throw new functions.https.HttpsError('not-found', 'Séquestre introuvable')

      const c = contractSnap.data()!
      const e = escrowSnap.data()!

      if (c.buyerId !== uid)
        throw new functions.https.HttpsError('permission-denied', "Seul l'acheteur peut confirmer la livraison")
      if (c.status !== 'shipped')
        throw new functions.https.HttpsError('failed-precondition', 'Livraison non expédiée')
      if (e.status !== 'held')
        throw new functions.https.HttpsError('failed-precondition', 'Séquestre invalide')

      const sellerWalletRef = db.collection('wallets').doc(c.sellerId)
      const now = admin.firestore.FieldValue.serverTimestamp()

      // Release escrow to seller
      tx.update(sellerWalletRef, {
        balanceCdf: admin.firestore.FieldValue.increment(e.amountCdf),
        updatedAt: now,
      })

      tx.update(escrowRef, { status: 'released', releasedAt: now })

      tx.update(contractRef, {
        status: 'fulfilled',
        deliveredAt: now,
        updatedAt: now,
      })

      // Update listing and order status
      tx.update(db.collection('product_listings').doc(c.listingId), {
        status: 'sold',
        updatedAt: now,
      })
      tx.update(db.collection('buyer_orders').doc(c.orderId), {
        status: 'fulfilled',
        updatedAt: now,
      })
    })

    return { ok: true }
  })
