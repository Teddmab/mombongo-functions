import { admin, db, functions } from '../lib/admin'
import { getUsdToCdf } from '../payments/initiateDeposit'
import { notifyPartnerInvoiceIssued } from '../partners/notifyPartnerInvoiceIssued'

const CONSENT_METHODS = ['phone', 'in_person', 'field_agent'] as const
type ConsentMethod = typeof CONSENT_METHODS[number]

interface FarmerContribution {
  farmerId: string
  contributedKg: number
}

interface AssistedInvoiceInput {
  clientRequestId: string
  farmers: FarmerContribution[]
  merchantId: string
  /** Only valid when farmers.length === 1 — a listing belongs to exactly one seller. Omit for a cooperative, or for a single farmer whose harvest was never published as a listing; commodity/pricePerKgCdf are required in that case instead. */
  listingId?: string | null
  commodity?: string
  pricePerKgCdf?: number
  consentMethod: ConsentMethod
  consentAt: string // ISO — when the admin actually obtained consent, which may be before the request is submitted
  note?: string
}

/**
 * ADM-UI-04's "Créer une facture avec assistance" — an admin creates a
 * real, payable harvest-sale invoice on behalf of one farmer, or several
 * pooling a harvest together as a cooperative. This is genuinely new
 * financial-transaction-creation power, not a UI reskin, so every check
 * below is load-bearing:
 *
 * - Every farmer named stays a real issuer on the invoice (farmers[] on
 *   the doc) — the admin is never the payer or seller of record, only
 *   recorded as the assisting actor.
 * - Every farmer's and the merchant's KYC/role are enforced server-side
 *   and cannot be bypassed by the client (no flag skips these checks) —
 *   including farmers/merchants the admin just created inline via
 *   adminCreatePerson, which are real users with real (admin-attested)
 *   kycStatus, not a special-cased shortcut here.
 * - The total is computed server-side — from the listing's own price ×
 *   quantity in listing mode, or from the admin-entered price × the sum
 *   of contributions in cooperative/ad-hoc mode — the client never
 *   supplies (and this function never trusts) a final amount.
 * - origin: 'admin_assisted' is a new, third value alongside SDP's
 *   'partner_api'/'harvest_sale' — never written as anything
 *   indistinguishable from farmer self-service.
 * - clientRequestId makes final submission idempotent.
 *
 * Payment path depends on who the merchant actually is, not on origin:
 * a real, logged-in merchant pays through the existing payHarvestInvoice
 * (SDP-03) unchanged. If the merchant is a partner's own synthetic
 * merchant account (partnerId resolved below), the partner pays through
 * their existing createExternalInvoiceCheckout instead — the same path a
 * partner_api-origin invoice already uses — since a login-less synthetic
 * account can never authenticate to call payHarvestInvoice itself.
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
      clientRequestId, farmers, merchantId, listingId, commodity, pricePerKgCdf: adHocPricePerKgCdf,
      consentMethod, consentAt, note,
    } = (data ?? {}) as Partial<AssistedInvoiceInput>

    if (!clientRequestId) throw new functions.https.HttpsError('invalid-argument', 'clientRequestId required')
    if (!Array.isArray(farmers) || farmers.length === 0)
      throw new functions.https.HttpsError('invalid-argument', 'At least one farmer required')
    if (farmers.some((f) => !f.farmerId || !f.contributedKg || f.contributedKg <= 0))
      throw new functions.https.HttpsError('invalid-argument', 'Each farmer needs a farmerId and a contributedKg > 0')
    if (new Set(farmers.map((f) => f.farmerId)).size !== farmers.length)
      throw new functions.https.HttpsError('invalid-argument', 'Duplicate farmer in the list')
    if (!merchantId) throw new functions.https.HttpsError('invalid-argument', 'merchantId required')
    if (listingId && farmers.length > 1)
      throw new functions.https.HttpsError('invalid-argument', 'A listing belongs to a single farmer — omit listingId for a cooperative')
    if (!consentMethod || !CONSENT_METHODS.includes(consentMethod))
      throw new functions.https.HttpsError('invalid-argument', `consentMethod must be one of ${CONSENT_METHODS.join(', ')}`)
    if (!consentAt) throw new functions.https.HttpsError('invalid-argument', 'consentAt required')

    const idempotencyRef = db.collection('admin_assisted_invoice_requests').doc(clientRequestId)
    const existing = await idempotencyRef.get()
    if (existing.exists) {
      const prior = existing.data()!
      return { invoiceId: prior.invoiceId as string, amountUsd: prior.amountUsd as number }
    }

    const [farmerSnaps, merchantSnap] = await Promise.all([
      Promise.all(farmers.map((f) => db.collection('users').doc(f.farmerId).get())),
      db.collection('users').doc(merchantId).get(),
    ])

    for (let i = 0; i < farmers.length; i++) {
      const farmer = farmerSnaps[i].data()
      if (!farmerSnaps[i].exists || farmer?.role !== 'farmer')
        throw new functions.https.HttpsError('failed-precondition', `Agriculteur introuvable (${farmers[i].farmerId})`)
      if (farmer?.kycStatus !== 'approved')
        throw new functions.https.HttpsError('failed-precondition', `L'agriculteur ${farmer?.fullName ?? farmers[i].farmerId} doit avoir un KYC approuvé`)
    }

    const merchant = merchantSnap.data()
    if (!merchantSnap.exists || merchant?.role !== 'merchant')
      throw new functions.https.HttpsError('failed-precondition', 'Commerçant introuvable')
    if (merchant?.kycStatus !== 'approved')
      throw new functions.https.HttpsError('failed-precondition', 'Le commerçant doit avoir un KYC approuvé')

    // If the chosen merchant IS a provisioned partner's own synthetic
    // account (e.g. AROM), this invoice needs to behave like a partner_api
    // invoice for payment purposes — a login-less synthetic merchant can
    // never call payHarvestInvoice itself, so without partnerId set here
    // the invoice would be permanently unpayable: neither
    // createExternalInvoiceCheckout (needs invoice.partnerId to match) nor
    // payHarvestInvoice (needs a real authenticated session) would ever
    // accept it. origin stays 'admin_assisted' — that's provenance (who
    // created it); partnerId is what actually drives payment/notification.
    const partnerForMerchantSnap = await db.collection('partners').where('merchantUid', '==', merchantId).limit(1).get()
    const partnerId = partnerForMerchantSnap.empty ? null : partnerForMerchantSnap.docs[0].id

    const totalKg = farmers.reduce((sum, f) => sum + f.contributedKg, 0)

    let listingSnap: FirebaseFirestore.DocumentSnapshot | null = null
    let pricePerKgCdf: number
    let resolvedCommodity: string | null

    if (listingId) {
      // Listing mode — single farmer only (enforced above), reuses the
      // farmer's own published listing and its price, exactly as before.
      listingSnap = await db.collection('product_listings').doc(listingId).get()
      const listing = listingSnap.data()
      if (!listingSnap.exists || listing?.sellerId !== farmers[0].farmerId)
        throw new functions.https.HttpsError('failed-precondition', "L'annonce ne correspond pas à cet agriculteur")
      if (listing?.status !== 'active')
        throw new functions.https.HttpsError('failed-precondition', "Cette annonce n'est plus disponible")
      if (totalKg > (listing.quantityKg as number))
        throw new functions.https.HttpsError('invalid-argument', 'Quantité supérieure à la quantité disponible')
      pricePerKgCdf = listing.pricePerKgCdf as number
      resolvedCommodity = (listing.commodity as string) ?? null
    } else {
      // Cooperative / ad-hoc mode — no listing to anchor to (a pooled
      // harvest across several farmers was never published as one), so
      // commodity and price come directly from the admin.
      if (!commodity?.trim()) throw new functions.https.HttpsError('invalid-argument', 'commodity required when no listing is selected')
      if (!adHocPricePerKgCdf || adHocPricePerKgCdf <= 0)
        throw new functions.https.HttpsError('invalid-argument', 'pricePerKgCdf must be > 0 when no listing is selected')
      pricePerKgCdf = adHocPricePerKgCdf
      resolvedCommodity = commodity.trim()
    }

    const usdToCdf = await getUsdToCdf(db)
    const amountUsd = Math.round(((pricePerKgCdf * totalKg) / usdToCdf) * 100) / 100

    const invoiceRef = db.collection('external_invoices').doc()
    const now = admin.firestore.FieldValue.serverTimestamp()

    await db.runTransaction(async (tx) => {
      tx.set(invoiceRef, {
        externalInvoiceId: invoiceRef.id,
        origin: 'admin_assisted',
        partnerId,
        // farmerId kept for backward compatibility with code that reads a
        // single issuer (e.g. name-resolution joins) — always the first
        // farmer. farmers[] is the source of truth for who actually issued.
        farmerId: farmers[0].farmerId,
        // Every issuer, not just the first — see getMyIssuedInvoices, which
        // uses array-contains against this to find a cooperative farmer's
        // invoices even when they aren't farmers[0].
        farmerIds: farmers.map((f) => f.farmerId),
        farmers,
        isCooperative: farmers.length > 1,
        merchantId,
        listingId: listingId ?? null,
        commodity: resolvedCommodity,
        offerId: null,
        quantityKg: totalKg,
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
      // no partial-fulfillment support exists yet. Only applies in listing
      // mode; a cooperative/ad-hoc invoice never touches product_listings.
      if (listingSnap) tx.update(listingSnap.ref, { status: 'sold' })
      tx.set(idempotencyRef, { invoiceId: invoiceRef.id, amountUsd, createdAt: now })
    })

    functions.logger.info(`adminCreateAssistedInvoice: ${adminUid} created ${invoiceRef.id} for ${farmers.length} farmer(s) / merchant ${merchantId}`)

    if (partnerId) await notifyPartnerInvoiceIssued(invoiceRef.id)

    return { invoiceId: invoiceRef.id, amountUsd }
  })
