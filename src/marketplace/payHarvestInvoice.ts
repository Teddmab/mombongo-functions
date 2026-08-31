import { db, functions } from '../lib/admin'
import { createCheckoutForInvoiceCore } from '../partners/createCheckoutForInvoiceCore'

/**
 * Session-authenticated equivalent of createExternalInvoiceCheckout — a
 * real, logged-in merchant paying their own invoice doesn't need
 * HMAC-signed partner auth (SDP-00 decision 4). merchantUid is simply
 * context.auth.uid here; no partner doc to resolve it from.
 */
export const payHarvestInvoice = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const { invoiceId, method, phone, operator } = (data ?? {}) as {
      invoiceId?: string
      method?: 'mobile_money'
      phone?: string
      operator?: string
    }
    if (!invoiceId || !method) {
      throw new functions.https.HttpsError('invalid-argument', 'invoiceId and method required')
    }

    const invoiceRef = db.collection('external_invoices').doc(invoiceId)
    const invoiceSnap = await invoiceRef.get()
    if (!invoiceSnap.exists || invoiceSnap.data()?.merchantId !== uid) {
      throw new functions.https.HttpsError('not-found', 'Invoice not found')
    }
    const invoice = invoiceSnap.data()!
    if (invoice.status !== 'pending') {
      throw new functions.https.HttpsError('failed-precondition', 'Already in progress or resolved')
    }

    const result = await createCheckoutForInvoiceCore({
      invoiceRef,
      invoiceId,
      amountUsd: invoice.amountUsd,
      merchantUid: uid,
      partnerId: null,
      method,
      phone,
      operator,
    })

    if (!result.ok) {
      if (result.kind === 'missing_phone_operator') {
        throw new functions.https.HttpsError('invalid-argument', 'phone and operator required for mobile_money')
      }
      if (result.kind === 'bank_transfer_unimplemented') {
        throw new functions.https.HttpsError('unimplemented', 'Bank transfer not yet implemented')
      }
      throw new functions.https.HttpsError('internal', result.message)
    }

    return { status: 'checkout_created', providerRef: result.providerRef, ...result.responseBody }
  })
