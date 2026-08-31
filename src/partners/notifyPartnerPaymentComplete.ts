import { FieldValue } from 'firebase-admin/firestore'
import { functions, db } from '../lib/admin'
import { sendSignedPartnerWebhook } from './sendSignedPartnerWebhook'

interface NotifyPayload {
  externalInvoiceId: string
  status: 'paid' | 'failed'
  amountUsd: number
  paidAt: string
}

/**
 * Firestore trigger, mirroring onFinancingStatusChange
 * (src/notifications/statusTriggers.ts) exactly — fires only on a real
 * status transition to paid/failed, not on every write to the doc (e.g.
 * SAI-05's admin panel viewing/annotating it). Decoupled from SAI-02's
 * webhook branch by design: the webhook owns "did the provider confirm,"
 * this trigger owns "tell the partner."
 */
export const onExternalInvoicePaid = functions
  .region('europe-west1')
  .firestore.document('external_invoices/{invoiceId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data()
    const after = change.after.data()
    if (before?.status === after?.status) return
    if (after?.status !== 'paid' && after?.status !== 'failed') return

    await notifyPartnerPaymentComplete(context.params.invoiceId, change.after)
  })

/**
 * Also exported standalone so SAI-05's adminRetryPartnerNotification can
 * call it directly for a manual retry, without needing to re-trigger a
 * Firestore write.
 */
export async function notifyPartnerPaymentComplete(
  invoiceId: string,
  invoiceSnap: FirebaseFirestore.DocumentSnapshot,
): Promise<void> {
  const invoice = invoiceSnap.data()!
  const partnerSnap = await db.collection('partners').doc(invoice.partnerId).get()
  const webhookUrl = partnerSnap.data()?.webhookUrl as string | undefined
  // Separate from SAI-01's inbound hmacSecret — see this story's audit
  // note on why outbound uses its own secret rather than the same one.
  const outboundSecret = partnerSnap.data()?.outboundHmacSecret as string | undefined

  if (!webhookUrl || !outboundSecret) {
    functions.logger.error(`No webhookUrl/outboundHmacSecret configured for partner ${invoice.partnerId}`)
    return
  }

  const payload: NotifyPayload = {
    externalInvoiceId: invoice.externalInvoiceId,
    status: invoice.status,
    amountUsd: invoice.amountUsd,
    paidAt: new Date().toISOString(),
  }

  await sendSignedPartnerWebhook({
    webhookUrl,
    outboundSecret,
    payload,
    kind: 'payment_complete',
    partnerId: invoice.partnerId,
    invoiceId,
    onSuccess: async () => {
      await invoiceSnap.ref.update({ notifiedAt: FieldValue.serverTimestamp() })
    },
  })
}
