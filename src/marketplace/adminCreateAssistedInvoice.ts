import { admin, db, functions } from '../lib/admin'
import { getUsdToCdf } from '../payments/initiateDeposit'

const CONSENT_METHODS = ['phone', 'in_person', 'field_agent'] as const
type ConsentMethod = typeof CONSENT_METHODS[number]

interface AssistedInvoiceInput {
  clientRequestId: string
  farmerId: string
  merchantId: string
  listingId: string
  quantityKg: number
  consentMethod: ConsentMethod
  consentAt: string // ISO — when the admin actually obtained consent, which may be before the request is submitted
  note?: string
}

/**
 * ADM-UI-04's "Créer une facture avec assistance" — an admin creates a
 * real, payable harvest-sale invoice on a farmer's behalf. This is
 * genuinely new financial-transaction-creation power, not a UI reskin, so
 * every check below is load-bearing:
 *
 * - The farmer remains the invoice's issuer (farmerId on the doc, exactly
 *   like a self-service harvest-sale invoice) — the admin is never the
 *   payer or the seller of record, only recorded as the assisting actor.
 * - Farmer KYC and merchant verification are enforced server-side and
 *   cannot be bypassed by the client (no flag skips these checks).
 * - The total is computed server-side from the listing's own price ×
 *   quantity — the client never supplies (and this function never trusts)
 *   a final amount.
 * - origin: 'admin_assisted' is a new, third value alongside SDP's
 *   'partner_api'/'harvest_sale' — never written as anything indistinguishable
 *   from farmer self-service.
 * - clientRequestId makes final submission idempotent: a retried call
 *   with the same id returns the original result instead of creating a
 *   second invoice or closing the listing twice.
 *
 * Once created, the invoice is paid through the existing payHarvestInvoice
 * (SDP-03) — no new payment/checkout path needed, since that function
 * only checks invoice.merchantId === context.auth.uid, not origin.
 */
export const adminCreateAssistedInvoice = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const adminUid = context.auth?.uid
    if (!adminUid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const callerSnap = await db.collection('users').doc(adminUid).get()
    if (callerSnap.data()?.role !== 'admin')
      throw new functions.https.HttpsError('permission-denied', 'Admin only')

    const {
      clientRequestId, farmerId, merchantId, listingId, quantityKg,
      consentMethod, consentAt, note,
    } = (data ?? {}) as Partial<AssistedInvoiceInput>

    if (!clientRequestId) throw new functions.https.HttpsError('invalid-argument', 'clientRequestId required')
    if (!farmerId || !merchantId || !listingId)
      throw new functions.https.HttpsError('invalid-argument', 'farmerId, merchantId and listingId required')
    if (!quantityKg || quantityKg <= 0)
      throw new functions.https.HttpsError('invalid-argument', 'quantityKg must be > 0')
    if (!consentMethod || !CONSENT_METHODS.includes(consentMethod))
      throw new functions.https.HttpsError('invalid-argument', `consentMethod must be one of ${CONSENT_METHODS.join(', ')}`)
    if (!consentAt) throw new functions.https.HttpsError('invalid-argument', 'consentAt required')

    const idempotencyRef = db.collection('admin_assisted_invoice_requests').doc(clientRequestId)
    const existing = await idempotencyRef.get()
    if (existing.exists) {
      const prior = existing.data()!
      return { invoiceId: prior.invoiceId as string, amountUsd: prior.amountUsd as number }
    }

    const [farmerSnap, merchantSnap, listingSnap] = await Promise.all([
      db.collection('users').doc(farmerId).get(),
      db.collection('users').doc(merchantId).get(),
      db.collection('product_listings').doc(listingId).get(),
    ])

    const farmer = farmerSnap.data()
    if (!farmerSnap.exists || farmer?.role !== 'farmer')
      throw new functions.https.HttpsError('failed-precondition', 'Agriculteur introuvable')
    if (farmer?.kycStatus !== 'approved')
      throw new functions.https.HttpsError('failed-precondition', "L'agriculteur doit avoir un KYC approuvé")

    const merchant = merchantSnap.data()
    if (!merchantSnap.exists || merchant?.role !== 'merchant')
      throw new functions.https.HttpsError('failed-precondition', 'Commerçant introuvable')
    if (merchant?.kycStatus !== 'approved')
      throw new functions.https.HttpsError('failed-precondition', 'Le commerçant doit avoir un KYC approuvé')

    const listing = listingSnap.data()
    if (!listingSnap.exists || listing?.sellerId !== farmerId)
      throw new functions.https.HttpsError('failed-precondition', "L'annonce ne correspond pas à cet agriculteur")
    if (listing?.status !== 'active')
      throw new functions.https.HttpsError('failed-precondition', "Cette annonce n'est plus disponible")
    if (quantityKg > (listing.quantityKg as number))
      throw new functions.https.HttpsError('invalid-argument', 'Quantité supérieure à la quantité disponible')

    const pricePerKgCdf = listing.pricePerKgCdf as number
    const usdToCdf = await getUsdToCdf(db)
    const amountUsd = Math.round(((pricePerKgCdf * quantityKg) / usdToCdf) * 100) / 100

    const invoiceRef = db.collection('external_invoices').doc()
    const now = admin.firestore.FieldValue.serverTimestamp()

    await db.runTransaction(async (tx) => {
      tx.set(invoiceRef, {
        externalInvoiceId: invoiceRef.id,
        origin: 'admin_assisted',
        partnerId: null,
        farmerId,
        merchantId,
        listingId,
        offerId: null,
        quantityKg,
        pricePerKgCdf,
        amountUsd,
        currency: 'USD',
        status: 'pending',
        testMode: false,
        reference: note ?? null,
        adminAssisted: {
          actorUid: adminUid,
          consentMethod,
          consentAt: admin.firestore.Timestamp.fromDate(new Date(consentAt)),
          note: note ?? null,
        },
        createdAt: now,
      })
      // Mirrors selectHarvestOffer's convention (SDP-00 open question 3,
      // resolved as "accepting one offer closes the listing entirely") —
      // no partial-fulfillment support exists yet, so this invoice also
      // closes the listing fully rather than leaving a partially-sold,
      // still-active listing other merchants could offer against.
      tx.update(listingSnap.ref, { status: 'sold' })
      tx.set(idempotencyRef, { invoiceId: invoiceRef.id, amountUsd, createdAt: now })
    })

    functions.logger.info(`adminCreateAssistedInvoice: ${adminUid} created ${invoiceRef.id} for farmer ${farmerId} / merchant ${merchantId}`)
    return { invoiceId: invoiceRef.id, amountUsd }
  })
