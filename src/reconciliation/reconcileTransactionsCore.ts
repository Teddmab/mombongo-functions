import { admin, db } from '../lib/admin'

export type ReconciliationStatus = 'matched' | 'exception' | 'not_applicable' | 'resolved_manually'

export interface ReconciliationResult {
  status: ReconciliationStatus
  note: string | null
}

/**
 * Real reconciliation, scoped honestly to what's actually checkable in
 * this codebase: transactions/{id} is written at the same moment its
 * underlying provider record (deposits/withdrawals/external_invoices) is
 * marked complete, by the same webhook handler, in the same Firestore
 * transaction — so in the ordinary case they can never disagree. What
 * this catches is the abnormal case: a provider-side record that's since
 * been altered, deleted, or was already in an inconsistent state at
 * write time (e.g. a retried webhook, manual data fix, or bug elsewhere)
 * — not a comparison against PawaPay's or AROM's own systems, since
 * nothing in this codebase calls back out to query either one's
 * transaction status independently. That would be a real, separate
 * integration to build, not something this function pretends to do.
 *
 * Transaction types with no independent secondary record to check
 * against (investment, financing, bourse_investment, bourse_sale,
 * *_refund) are marked 'not_applicable' rather than 'matched' — marking
 * them 'matched' would claim a check happened when it didn't.
 */
export async function reconcileOneTransaction(
  txId: string,
  tx: Record<string, unknown>,
): Promise<ReconciliationResult> {
  const type = tx.type as string
  const amountUsd = tx.amountUsd as number | undefined

  if (type === 'deposit' && tx.pawapayDepositId) {
    const snap = await db.collection('deposits').doc(tx.pawapayDepositId as string).get()
    if (!snap.exists) return { status: 'exception', note: 'Aucun document deposits correspondant' }
    const deposit = snap.data()!
    if (deposit.status !== 'completed') return { status: 'exception', note: `deposits.status = ${deposit.status}, attendu 'completed'` }
    if (typeof amountUsd === 'number' && deposit.amountUsd !== amountUsd) {
      return { status: 'exception', note: `Montant différent : transaction ${amountUsd} $ vs deposits ${deposit.amountUsd} $` }
    }
    return { status: 'matched', note: null }
  }

  if (type === 'withdrawal' && tx.pawapayPayoutId) {
    const snap = await db.collection('withdrawals').doc(tx.pawapayPayoutId as string).get()
    if (!snap.exists) return { status: 'exception', note: 'Aucun document withdrawals correspondant' }
    const withdrawal = snap.data()!
    if (withdrawal.status !== 'completed') return { status: 'exception', note: `withdrawals.status = ${withdrawal.status}, attendu 'completed'` }
    if (typeof amountUsd === 'number' && withdrawal.amountUsd !== amountUsd) {
      return { status: 'exception', note: `Montant différent : transaction ${amountUsd} $ vs withdrawals ${withdrawal.amountUsd} $` }
    }
    return { status: 'matched', note: null }
  }

  if (type === 'external_invoice_payment' && tx.externalInvoiceDocId) {
    const snap = await db.collection('external_invoices').doc(tx.externalInvoiceDocId as string).get()
    if (!snap.exists) return { status: 'exception', note: 'Aucune facture external_invoices correspondante' }
    const invoice = snap.data()!
    if (invoice.status !== 'paid') return { status: 'exception', note: `external_invoices.status = ${invoice.status}, attendu 'paid'` }
    if (typeof amountUsd === 'number' && invoice.amountUsd !== amountUsd) {
      return { status: 'exception', note: `Montant différent : transaction ${amountUsd} $ vs facture ${invoice.amountUsd} $` }
    }
    return { status: 'matched', note: null }
  }

  return { status: 'not_applicable', note: null }
}

/** Processes transactions from the last `windowDays` that have never been checked, capped at `limit` per run. */
export async function reconcileRecentTransactions(windowDays: number, limit: number): Promise<{ checked: number; exceptions: number }> {
  const since = admin.firestore.Timestamp.fromDate(new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000))
  const snap = await db.collection('transactions')
    .where('createdAt', '>=', since)
    .orderBy('createdAt', 'desc')
    .limit(limit * 3) // over-fetch since we filter unchecked ones client-side below (no composite index for "reconciliationCheckedAt == null" + orderBy)
    .get()

  let checked = 0
  let exceptions = 0

  for (const doc of snap.docs) {
    if (checked >= limit) break
    const data = doc.data()
    if (data.reconciliationCheckedAt) continue // already checked in a prior run

    const result = await reconcileOneTransaction(doc.id, data)
    await doc.ref.update({
      reconciliationStatus: result.status,
      reconciliationNote: result.note,
      reconciliationCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
    })
    checked += 1
    if (result.status === 'exception') exceptions += 1
  }

  return { checked, exceptions }
}
