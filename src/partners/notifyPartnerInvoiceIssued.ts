import { FieldValue } from 'firebase-admin/firestore'
import { db, functions } from '../lib/admin'
import { sendSignedPartnerWebhook } from './sendSignedPartnerWebhook'

interface InvoiceIssuedPayload {
  invoiceId: string      // Mombongo's own external_invoices doc id — there
                          // is no partner-originated externalInvoiceId for
                          // a harvest-sale invoice, this IS the id
  farmerId: string
  listingId: string
  amountUsd: number
  quantityKg: number
  commodity: string
}

/**
 * Called directly from selectHarvestOffer (SDP-02) when the winning
 * offer's partnerId is set — NOT a Firestore trigger like
 * onExternalInvoicePaid, because "invoice created" is a one-time event at
 * creation, not a status transition to watch for. Same
 * retry/backoff/dead-letter shape as notifyPartnerPaymentComplete, via
 * the shared sendSignedPartnerWebhook helper (SDP-04).
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

  const [offerSnap, listingSnap, partnerSnap] = await Promise.all([
    db.collection('harvest_offers').doc(invoice.offerId).get(),
    db.collection('product_listings').doc(invoice.listingId).get(),
    db.collection('partners').doc(invoice.partnerId).get(),
  ])

  const webhookUrl = partnerSnap.data()?.webhookUrl as string | undefined
  const outboundSecret = partnerSnap.data()?.outboundHmacSecret as string | undefined
  if (!webhookUrl || !outboundSecret) {
    functions.logger.error(`No webhookUrl/outboundHmacSecret configured for partner ${invoice.partnerId}`)
    return
  }

  const payload: InvoiceIssuedPayload = {
    invoiceId,
    farmerId: invoice.farmerId,
    listingId: invoice.listingId,
    amountUsd: invoice.amountUsd,
    quantityKg: offerSnap.data()?.offerQuantityKg ?? 0,
    commodity: listingSnap.data()?.commodity ?? '',
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
