import { admin, functions } from '../lib/admin'

const db = admin.firestore()

export const createBuyerOrder = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const {
      commodity, quantityKg, maxPricePerKgCdf,
      deliveryProvince, deliveryTerritory, neededBy, description,
    } = data as {
      commodity: string
      quantityKg: number
      maxPricePerKgCdf: number
      deliveryProvince: string
      deliveryTerritory?: string
      neededBy: string
      description?: string
    }

    if (!(quantityKg > 0)) throw new functions.https.HttpsError('invalid-argument', 'Quantité invalide')
    if (!(maxPricePerKgCdf > 0)) throw new functions.https.HttpsError('invalid-argument', 'Prix invalide')

    const userSnap = await db.collection('users').doc(uid).get()
    const buyerName: string = userSnap.data()?.fullName ?? 'Acheteur'
    const buyerRole: string = userSnap.data()?.role ?? 'merchant'

    const now = admin.firestore.FieldValue.serverTimestamp()
    const orderRef = db.collection('buyer_orders').doc()

    await orderRef.set({
      buyerId: uid,
      buyerName,
      buyerRole,
      commodity,
      quantityKg,
      maxPricePerKgCdf,
      deliveryProvince,
      deliveryTerritory: deliveryTerritory ?? '',
      neededBy: new Date(neededBy),
      description: description ?? '',
      status: 'open',
      createdAt: now,
    })

    // Auto-match: find active listings with same commodity at or below max price
    const matchSnap = await db.collection('product_listings')
      .where('status', '==', 'active')
      .where('commodity', '==', commodity)
      .get()

    const candidates = matchSnap.docs.filter(d => d.data().pricePerKgCdf <= maxPricePerKgCdf)

    if (candidates.length > 0) {
      const batch = db.batch()
      for (const c of candidates.slice(0, 3)) {
        const matchRef = db.collection('bourse_matches').doc()
        batch.set(matchRef, {
          listingId: c.id,
          orderId: orderRef.id,
          sellerId: c.data().sellerId,
          buyerId: uid,
          commodity,
          quantityKg: Math.min(quantityKg, c.data().quantityKg),
          status: 'pending_negotiation',
          createdAt: now,
          updatedAt: now,
        })
      }
      await batch.commit()
    }

    return { orderId: orderRef.id, matchCount: candidates.length }
  })
