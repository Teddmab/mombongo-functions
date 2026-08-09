import * as admin from 'firebase-admin'
import { db, functions } from '../lib/admin'

export const createProductOrder = functions.region('europe-west1').https.onCall(async (data, context) => {
  const uid = context.auth?.uid
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

  const { listingId, quantityKg, deliveryAddress, deliveryDate, paymentMethod, notes } = data ?? {}

  if (!listingId || !quantityKg || !deliveryAddress) {
    throw new functions.https.HttpsError('invalid-argument', 'listingId, quantityKg and deliveryAddress are required')
  }

  const listingDoc = await db.collection('product_listings').doc(listingId).get()
  if (!listingDoc.exists) throw new functions.https.HttpsError('not-found', 'Listing not found')

  const listing = listingDoc.data()!
  if (listing.status !== 'active') {
    throw new functions.https.HttpsError('failed-precondition', 'Listing is no longer available')
  }

  const totalAmountCdf = listing.pricePerKgCdf * Number(quantityKg)

  const ref = await db.collection('product_orders').add({
    merchantId: uid,
    listingId,
    sellerId: listing.sellerId,
    sellerName: listing.sellerName ?? '',
    commodity: listing.commodity,
    province: listing.province ?? '',
    quantityKg: Number(quantityKg),
    pricePerKgCdf: listing.pricePerKgCdf,
    totalAmountCdf,
    deliveryAddress,
    deliveryDate: deliveryDate ?? '',
    paymentMethod: paymentMethod ?? 'mobile-money',
    notes: notes ?? '',
    status: 'pending',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  })

  return { orderId: ref.id, totalAmountCdf }
})
