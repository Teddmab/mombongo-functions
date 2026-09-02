import { FieldValue } from 'firebase-admin/firestore'
import { db, functions } from '../lib/admin'
import { sendSignedPartnerWebhook } from './sendSignedPartnerWebhook'

interface InvoiceIssuedPayload {
  invoiceId: string      // Mombongo's own external_invoices doc id — there
                          // is no partner-originated externalInvoiceId for
                          // a harvest-sale invoice, this IS the id
  farmerId: string
  listingId: string | null
  amountUsd: number
  quantityKg: number
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
 * Reads commodity/quantityKg straight off the invoice doc — both creation
 * paths snapshot these at creation time now, so this no longer joins
 * through harvest_offers/product_listings (which don't exist at all for
 * an admin-assisted ad-hoc/cooperative sale).
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

  const payload: InvoiceIssuedPayload = {
    invoiceId,
    farmerId: invoice.farmerId,
    listingId: invoice.listingId ?? null,
    amountUsd: invoice.amountUsd,
    quantityKg: invoice.quantityKg ?? 0,
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
