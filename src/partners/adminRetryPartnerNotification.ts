import { db, functions } from '../lib/admin'
import { notifyPartnerPaymentComplete } from './notifyPartnerPaymentComplete'
import { notifyPartnerInvoiceIssued } from './notifyPartnerInvoiceIssued'

/**
 * Admin-only manual retry for a failed outbound partner notification —
 * mirrors adminTriggerMorningPricePush's "run it again by hand" pattern
 * exactly (same context.auth?.uid -> users/{uid}.role === 'admin' guard
 * as every other admin CF).
 *
 * kind picks which notifier to re-run — defaults to 'payment_complete'
 * so existing callers (the admin console doesn't pass it yet) keep their
 * exact current behavior. Every outbound_notification_failures doc from
 * before SDP-04 has no kind field either, for the same reason.
 */
export const adminRetryPartnerNotification = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    if (!context.auth?.uid)
      throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const callerSnap = await db.collection('users').doc(context.auth.uid).get()
    if (callerSnap.data()?.role !== 'admin')
      throw new functions.https.HttpsError('permission-denied', 'Admin only')

    const { invoiceId, kind } = (data ?? {}) as { invoiceId?: string; kind?: 'payment_complete' | 'invoice_issued' }
    if (!invoiceId)
      throw new functions.https.HttpsError('invalid-argument', 'invoiceId required')

    const invoiceSnap = await db.collection('external_invoices').doc(invoiceId).get()
    if (!invoiceSnap.exists)
      throw new functions.https.HttpsError('not-found', 'Invoice not found')

    functions.logger.info(`adminRetryPartnerNotification: triggered manually by ${context.auth.uid} for invoice ${invoiceId} (kind=${kind ?? 'payment_complete'})`)

    if (kind === 'invoice_issued') {
      await notifyPartnerInvoiceIssued(invoiceId)
    } else {
      await notifyPartnerPaymentComplete(invoiceId, invoiceSnap)
    }

    return { success: true, triggeredAt: new Date().toISOString() }
  })
