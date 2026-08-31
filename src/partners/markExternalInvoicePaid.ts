import { FieldValue } from 'firebase-admin/firestore'
import { db } from '../lib/admin'

/**
 * Shared by stripeWebhook.ts's and pawapayWebhook.ts's external-invoice
 * branches (SAI-02) — unlike the onCall/wallet-credit functions, this is
 * genuinely the same operation from two completion sources, so it's
 * extracted once rather than duplicated. Marks external_invoices paid
 * and writes a transactions doc against the shared merchant account for
 * visibility (Teddy's requirement) — walletUsd is deliberately never
 * touched here.
 *
 * Idempotent: a second call for an already-`paid` invoice (e.g. a
 * webhook retry) is a no-op, mirroring the existing webhooks' own
 * `status !== 'pending'` guards.
 */
export async function markExternalInvoicePaid(input: {
  invoiceRef: FirebaseFirestore.DocumentReference
  merchantUid: string
  partnerId: string
  amountUsd: number
  method: 'card' | 'mobile_money'
  providerRefField: 'stripePaymentIntentId' | 'pawapayDepositId'
  providerRef: string
}): Promise<void> {
  const now = FieldValue.serverTimestamp()
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(input.invoiceRef)
    if (!snap.exists || snap.data()?.status !== 'checkout_created') return // already processed — idempotent no-op

    tx.update(input.invoiceRef, { status: 'paid', paidAt: now })
    tx.set(db.collection('transactions').doc(), {
      userId: input.merchantUid,
      type: 'external_invoice_payment',
      method: input.method,
      amountUsd: input.amountUsd,
      currency: 'USD',
      status: 'completed',
      partnerId: input.partnerId,
      externalInvoiceDocId: input.invoiceRef.id,
      [input.providerRefField]: input.providerRef,
      createdAt: now,
    })
  })
}

/** Mirrors pawapayWebhook.ts's existing non-COMPLETED handling — no transaction doc on failure, same as today's own-user deposit flow. */
export async function markExternalInvoiceFailed(invoiceRef: FirebaseFirestore.DocumentReference): Promise<void> {
  const snap = await invoiceRef.get()
  if (!snap.exists || snap.data()?.status !== 'checkout_created') return
  await invoiceRef.update({ status: 'failed', failedAt: FieldValue.serverTimestamp() })
}
