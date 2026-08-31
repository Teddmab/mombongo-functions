import { FieldValue } from 'firebase-admin/firestore'
import { db, functions } from '../lib/admin'
import { getUsdToCdf } from '../payments/initiateDeposit'

/**
 * Farmer picks a winning offer on their own listing. Creates the
 * external_invoices doc (origin: 'harvest_sale') the merchant will pay
 * through Sprint AI's existing checkout machinery, declines every other
 * pending offer on the listing, and closes the listing.
 *
 * Firestore requires all transaction reads before any writes — the
 * "decline others" query below runs first for that reason, not because
 * of read-order preference.
 */
export const selectHarvestOffer = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { offerId } = (data ?? {}) as { offerId?: string }
    if (!offerId) throw new functions.https.HttpsError('invalid-argument', 'offerId required')

    const offerRef = db.collection('harvest_offers').doc(offerId)
    const offerSnap = await offerRef.get()
    if (!offerSnap.exists) throw new functions.https.HttpsError('not-found', 'Offer not found')
    const offer = offerSnap.data()!

    if (offer.farmerId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not your listing')
    }
    if (offer.status !== 'pending') {
      throw new functions.https.HttpsError('failed-precondition', 'Offer already resolved')
    }

    const usdToCdf = await getUsdToCdf(db)
    const amountUsd = (offer.offerQuantityKg * offer.offerPricePerKgCdf) / usdToCdf

    const invoiceId = await db.runTransaction(async (tx) => {
      const invoiceRef = db.collection('external_invoices').doc()
      const listingRef = db.collection('product_listings').doc(offer.listingId)

      // All reads first.
      const othersSnap = await tx.get(
        db.collection('harvest_offers')
          .where('listingId', '==', offer.listingId)
          .where('status', '==', 'pending'),
      )

      // Then all writes.
      tx.set(invoiceRef, {
        origin: 'harvest_sale',
        partnerId: offer.partnerId ?? null,
        merchantId: offer.merchantId,
        farmerId: offer.farmerId,
        listingId: offer.listingId,
        offerId,
        externalInvoiceId: invoiceRef.id,
        amountUsd,
        currency: 'USD',
        status: 'pending',
        testMode: false,
        createdAt: FieldValue.serverTimestamp(),
      })
      tx.update(offerRef, { status: 'accepted', updatedAt: FieldValue.serverTimestamp() })
      othersSnap.docs.forEach((d) => {
        if (d.id !== offerId) {
          tx.update(d.ref, { status: 'declined', updatedAt: FieldValue.serverTimestamp() })
        }
      })
      tx.update(listingRef, { status: 'sold' })

      return invoiceRef.id
    })

    // TODO(SDP-04): when the partner-API offer path exists, notify the
    // partner an invoice was issued here (notifyPartnerInvoiceIssued).
    // Not called yet — offer.partnerId is always null until SDP-04 ships
    // createExternalHarvestOffer, the only path that sets it.

    return { invoiceId }
  })
