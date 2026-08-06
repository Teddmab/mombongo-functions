import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const createBuyerOrder = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const {
      commodity,
      quantityKg,
      maxPricePerKgCdf,
      deliveryProvince,
      deliveryTerritory,
      neededBy,
      description,
    } = (data ?? {}) as {
      commodity: string
      quantityKg: number
      maxPricePerKgCdf: number
      deliveryProvince: string
      deliveryTerritory?: string
      neededBy: string
      description?: string
    }

    if (!commodity || !deliveryProvince) {
      throw new functions.https.HttpsError('invalid-argument', 'commodity and deliveryProvince required')
    }
    if (!quantityKg || quantityKg <= 0) {
      throw new functions.https.HttpsError('invalid-argument', 'Quantité invalide')
    }
    if (!maxPricePerKgCdf || maxPricePerKgCdf <= 0) {
      throw new functions.https.HttpsError('invalid-argument', 'Prix max invalide')
    }

    const userSnap = await db.collection('users').doc(uid).get()
    const buyerName = userSnap.data()?.displayName ?? 'Acheteur'
    const buyerRole = userSnap.data()?.role ?? 'merchant'

    const ref = db.collection('buyer_orders').doc()
    const now = admin.firestore.FieldValue.serverTimestamp()

    await ref.set({
      buyerId: uid,
      buyerName,
      buyerRole,
      commodity,
      quantityKg,
      maxPricePerKgCdf,
      deliveryProvince,
      deliveryTerritory: deliveryTerritory ?? '',
      neededBy: neededBy ? new Date(neededBy) : now,
      description: description ?? '',
      status: 'open',
      createdAt: now,
    })

    const matchSnap = await db
      .collection('product_listings')
      .where('status', '==', 'active')
      .where('commodity', '==', commodity)
      .get()

    const candidates = matchSnap.docs.filter(
      (d) => (d.data().pricePerKgCdf as number) <= maxPricePerKgCdf,
    )

    if (candidates.length > 0) {
      const batch = db.batch()
      for (const c of candidates.slice(0, 3)) {
        const matchRef = db.collection('bourse_matches').doc()
        batch.set(matchRef, {
          listingId: c.id,
          orderId: ref.id,
          sellerId: c.data().sellerId,
          buyerId: uid,
          commodity,
          quantityKg: Math.min(quantityKg, c.data().quantityKg as number),
          sellerPricePerKgCdf: c.data().pricePerKgCdf,
          buyerMaxPricePerKgCdf: maxPricePerKgCdf,
          status: 'pending_negotiation',
          createdAt: now,
          updatedAt: now,
        })
      }
      await batch.commit()
    }

    return { orderId: ref.id, matchCount: candidates.length }
  })
