import { db, functions } from '../lib/admin'
import { notifyPartnerPaymentComplete } from './notifyPartnerPaymentComplete'
import { notifyPartnerInvoiceIssued } from './notifyPartnerInvoiceIssued'
import { notifyPartnerOfferStatusChanged } from './notifyPartnerOfferStatusChanged'
import type { PartnerWebhookKind } from './sendSignedPartnerWebhook'

const KINDS: readonly PartnerWebhookKind[] = ['payment_complete', 'invoice_issued', 'offer_status_changed']
const FINAL_INVOICE_STATUSES = ['paid', 'failed']

interface FailureDoc {
  invoiceId?: string
  partnerId?: string
  kind?: PartnerWebhookKind
  failedAt?: { toMillis?: () => number }
}

/**
 * Admin-only manual retry for a failed outbound partner notification —
 * mirrors adminTriggerMorningPricePush's "run it again by hand" pattern
 * exactly (same context.auth?.uid -> users/{uid}.role === 'admin' guard
 * as every other admin CF).
 *
 * Which event is re-sent:
 * - `kind` when the caller passes it explicitly;
 * - otherwise the kind recorded on the dead-letter doc — `failureId` if given,
 *   else the most recent outbound_notification_failures doc for this invoice
 *   whose kind can apply to it. Docs from before SDP-04 have no kind and are
 *   payment_complete failures.
 * mombongo-admin's dead-letter "Réessayer" button sends only `{ invoiceId }`.
 * This function used to default that to payment_complete, so retrying a failed
 * invoice_issued delivery sent AROM a payment_complete with `status: "pending"`
 * and a fabricated paidAt. Resolving from the dead-letter doc fixes that
 * without an admin change, and payment_complete is now refused for an invoice
 * that is not paid/failed.
 *
 * Re-sending is idempotent for the partner: invoice_issued and
 * offer_status_changed carry a deterministic eventId (computeEventId), so a
 * retry is the same business event, never a new one.
 *
 * Returns `delivered: false` (with `success: false`) when the retry was itself
 * exhausted — sendSignedPartnerWebhook has then written a new dead-letter doc,
 * so the failure stays visible in the admin list.
 *
 * The `invoiceId` parameter name is kept as-is (not renamed/generalized)
 * for backward compatibility with mombongo-admin's existing retry call —
 * see sendSignedPartnerWebhook.ts's doc comment. For kind:
 * 'offer_status_changed', this same value is actually a harvest_offers
 * id; the offer's own current status field is used as the status to
 * (re-)notify, since by the time a retry is needed the authoritative
 * transition has already committed.
 */
export const adminRetryPartnerNotification = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    if (!context.auth?.uid)
      throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const callerSnap = await db.collection('users').doc(context.auth.uid).get()
    if (callerSnap.data()?.role !== 'admin')
      throw new functions.https.HttpsError('permission-denied', 'Admin only')

    const { invoiceId, kind: requestedKind, failureId } = (data ?? {}) as {
      invoiceId?: string
      kind?: PartnerWebhookKind
      failureId?: string
    }
    if (!invoiceId)
      throw new functions.https.HttpsError('invalid-argument', 'invoiceId required')
    if (requestedKind !== undefined && !KINDS.includes(requestedKind))
      throw new functions.https.HttpsError('invalid-argument', 'Unknown kind')

    if (requestedKind === 'offer_status_changed') {
      const offerSnap = await db.collection('harvest_offers').doc(invoiceId).get()
      if (!offerSnap.exists)
        throw new functions.https.HttpsError('not-found', 'Offer not found')
      const status = offerSnap.data()?.status as string | undefined
      if (status !== 'accepted' && status !== 'declined')
        throw new functions.https.HttpsError('failed-precondition', 'Offer has no resolved status to notify')
      functions.logger.info(`adminRetryPartnerNotification: triggered manually by ${context.auth.uid} for ${invoiceId} (kind=offer_status_changed)`)
      const delivered = await notifyPartnerOfferStatusChanged(invoiceId, status)
      return { success: delivered, delivered, kind: requestedKind, triggeredAt: new Date().toISOString() }
    }

    const invoiceSnap = await db.collection('external_invoices').doc(invoiceId).get()
    if (!invoiceSnap.exists)
      throw new functions.https.HttpsError('not-found', 'Invoice not found')
    const invoice = invoiceSnap.data() ?? {}
    if (!invoice.partnerId)
      throw new functions.https.HttpsError('failed-precondition', 'Invoice has no partner to notify')
    const isFinal = FINAL_INVOICE_STATUSES.includes(invoice.status)
    const appliesTo = (k: PartnerWebhookKind) =>
      k === 'invoice_issued' || (k === 'payment_complete' && isFinal)

    let kind: PartnerWebhookKind | undefined = requestedKind
    if (!kind) {
      let failures: FailureDoc[]
      if (failureId) {
        const failureSnap = await db.collection('outbound_notification_failures').doc(failureId).get()
        if (!failureSnap.exists)
          throw new functions.https.HttpsError('not-found', 'Failure record not found')
        failures = [failureSnap.data() as FailureDoc]
        if (failures[0].invoiceId !== invoiceId)
          throw new functions.https.HttpsError('invalid-argument', 'Failure record does not belong to this invoice')
      } else {
        const snap = await db.collection('outbound_notification_failures')
          .where('invoiceId', '==', invoiceId)
          .limit(50)
          .get()
        failures = snap.docs
          .map((d) => d.data() as FailureDoc)
          .sort((a, b) => (b.failedAt?.toMillis?.() ?? 0) - (a.failedAt?.toMillis?.() ?? 0))
      }
      if (failures.some((f) => f.partnerId && f.partnerId !== invoice.partnerId))
        throw new functions.https.HttpsError('permission-denied', 'Failure record belongs to another partner')

      kind = failures
        .map((f) => f.kind ?? 'payment_complete')
        .find((k) => k !== 'offer_status_changed' && appliesTo(k))
      // No dead-letter doc at all (e.g. pre-dead-letter invoices): keep the
      // historical behaviour only where it is valid — a final invoice.
      if (!kind && failures.length === 0 && isFinal) kind = 'payment_complete'
      if (!kind)
        throw new functions.https.HttpsError('failed-precondition', 'No failed partner notification to retry for this invoice')
    }

    if (kind === 'offer_status_changed' || !appliesTo(kind))
      throw new functions.https.HttpsError('failed-precondition', `Cannot send ${kind} for an invoice with status ${invoice.status}`)

    functions.logger.info(`adminRetryPartnerNotification: triggered manually by ${context.auth.uid} for ${invoiceId} (kind=${kind})`)

    const delivered = kind === 'invoice_issued'
      ? await notifyPartnerInvoiceIssued(invoiceId)
      : await notifyPartnerPaymentComplete(invoiceId, invoiceSnap)

    return { success: delivered, delivered, kind, triggeredAt: new Date().toISOString() }
  })
