import { FieldValue } from 'firebase-admin/firestore'
import { db, functions } from '../lib/admin'
import { sendSignedPartnerWebhook } from './sendSignedPartnerWebhook'
import { computeEventId } from '../lib/eventId'

export const INVOICE_ISSUED_SCHEMA_VERSION = 2

interface InvoiceIssuedPayload {
  eventId: string
  schemaVersion: number
  occurredAt: string
  invoiceId: string      // Mombongo's own external_invoices doc id — there
                          // is no partner-originated externalInvoiceId for
                          // a harvest-sale invoice, this IS the id
  offerId: string | null // null for an admin-assisted invoice — no offer exists for that origin
  externalReference: string | null
  farmerId: string
  listingId: string | null
  quantityKg: number
  unitPriceCdf: number
  totalAmountCdf: number
  currency: 'CDF'
  amountUsd: number // kept for backward compatibility with the v1 payload shape
  commodity: string
}

/**
 * Called whenever an invoice is created with a partnerId set — from
 * selectHarvestOffer (SDP-02) when the winning offer came in via the
 * partner API, and from adminCreateAssistedInvoice when an admin picks a
 * partner's own merchant account as the buyer. NOT a Firestore trigger
 * like onExternalInvoicePaid, because "invoice created" is a one-time
 * event at creation, not a status transition to watch for. Same
 * retry/backoff/dead-letter shape as notifyPartnerPaymentComplete, via
 * the shared sendSignedPartnerWebhook helper (SDP-04).
 *
 * schemaVersion 2 (2026-09): adds eventId/occurredAt/offerId/
 * externalReference/unitPriceCdf/totalAmountCdf/currency so AROM can
 * correlate this invoice to the exact offer it submitted, without relying
 * on listingId alone (ambiguous once more than one offer can exist per
 * listing — see createExternalHarvestOfferIdempotency.ts). v1 fields
 * (invoiceId, farmerId, listingId, amountUsd, quantityKg, commodity) are
 * all still present, unchanged, for backward compatibility — this is an
 * additive change, not a breaking one.
 *
 * Reads commodity/quantityKg/unitPriceCdf/totalAmountCdf/externalReference
 * straight off the invoice doc — every creation path snapshots these at
 * creation time now, so this no longer joins through harvest_offers/
 * product_listings (which don't exist at all for an admin-assisted
 * ad-hoc/cooperative sale).
 *
 * Issuing this event is NOT permission for AROM to pay — see
 * selectHarvestOffer.ts / the payment-boundary documentation. It
 * represents an expected payable purchase pending AROM's physical
 * reception and quality/quantity approval; Mombongo does not currently
 * enforce that boundary server-side (createExternalInvoiceCheckout still
 * accepts a checkout call immediately after this event), which is a
 * documented, not-yet-closed gap.
 */
export async function notifyPartnerInvoiceIssued(invoiceId: string): Promise<void> {
  const invoiceSnap = await db.collection('external_invoices').doc(invoiceId).get()
  if (!invoiceSnap.exists) {
    functions.logger.error(`notifyPartnerInvoiceIssued: invoice ${invoiceId} not found`)
    return
  }
  const invoice = invoiceSnap.data()!
  if (!invoice.partnerId) {
    functions.logger.error(`notifyPartnerInvoiceIssued: invoice ${invoiceId} has no partnerId`)
    return
  }

  const partnerSnap = await db.collection('partners').doc(invoice.partnerId).get()
  const webhookUrl = partnerSnap.data()?.webhookUrl as string | undefined
  const outboundSecret = partnerSnap.data()?.outboundHmacSecret as string | undefined
  if (!webhookUrl || !outboundSecret) {
    functions.logger.error(`No webhookUrl/outboundHmacSecret configured for partner ${invoice.partnerId}`)
    return
  }

  const quantityKg = invoice.quantityKg ?? 0
  const unitPriceCdf = invoice.unitPriceCdf ?? 0
  const payload: InvoiceIssuedPayload = {
    eventId: computeEventId('invoice_issued', invoiceId),
    schemaVersion: INVOICE_ISSUED_SCHEMA_VERSION,
    occurredAt: new Date().toISOString(),
    invoiceId,
    offerId: (invoice.offerId as string | null) ?? null,
    externalReference: (invoice.externalReference as string | null) ?? null,
    farmerId: invoice.farmerId,
    listingId: invoice.listingId ?? null,
    quantityKg,
    unitPriceCdf,
    totalAmountCdf: invoice.totalAmountCdf ?? quantityKg * unitPriceCdf,
    currency: 'CDF',
    amountUsd: invoice.amountUsd,
    commodity: invoice.commodity ?? '',
  }

  await sendSignedPartnerWebhook({
    webhookUrl,
    outboundSecret,
    payload,
    kind: 'invoice_issued',
    partnerId: invoice.partnerId,
    invoiceId,
    onSuccess: async () => {
      await invoiceSnap.ref.update({ invoiceIssuedNotifiedAt: FieldValue.serverTimestamp() })
    },
  })
}
