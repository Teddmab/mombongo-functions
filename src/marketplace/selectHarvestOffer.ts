import { FieldValue } from 'firebase-admin/firestore'
import { db, functions } from '../lib/admin'
import { getUsdToCdf } from '../payments/initiateDeposit'
import { notifyPartnerInvoiceIssued } from '../partners/notifyPartnerInvoiceIssued'

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
      const [othersSnap, listingSnap] = await Promise.all([
        tx.get(
          db.collection('harvest_offers')
            .where('listingId', '==', offer.listingId)
            .where('status', '==', 'pending'),
        ),
        tx.get(listingRef),
      ])

      // Then all writes.
      tx.set(invoiceRef, {
        origin: 'harvest_sale',
        partnerId: offer.partnerId ?? null,
        merchantId: offer.merchantId,
        farmerId: offer.farmerId,
        // Array form for getMyIssuedInvoices' array-contains query — a
        // cooperative admin-assisted invoice can have several farmers, so
        // farmerId alone (always just the first one there) isn't enough to
        // find every invoice a given farmer actually appears on.
        farmerIds: [offer.farmerId],
        listingId: offer.listingId,
        offerId,
        // Snapshotted at creation time rather than joined later — an
        // invoice should describe what was actually sold even if the
        // listing itself changes or is deleted afterward. Also lets
        // notifyPartnerInvoiceIssued read one doc instead of three.
        commodity: (listingSnap.data()?.commodity as string) ?? null,
        quantityKg: offer.offerQuantityKg,
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

    // If the winning offer came in via the partner API, notify them an
    // invoice now exists so they can decide whether to pay it via
    // createExternalInvoiceCheckout. In-app merchants see it directly in
    // their own app (SDP-07), no webhook needed.
    if (offer.partnerId) {
      await notifyPartnerInvoiceIssued(invoiceId)
    }

    return { invoiceId }
  })
