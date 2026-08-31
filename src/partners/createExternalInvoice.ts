import { FieldValue } from 'firebase-admin/firestore'
import { db, functions } from '../lib/admin'
import { verifyPartnerSignature } from './verifyPartnerSignature'

/**
 * Inbound invoice intake for external partners (AROM first). Partner
 * signs the raw request body with a per-partner HMAC secret
 * (verifyPartnerSignature) — same fail-closed shape as
 * verifyPawapayHmac, not the fail-open payout/refund webhook pattern.
 */
export const createExternalInvoice = functions
  .region('europe-west1')
  .https.onRequest(async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).send('Method not allowed')
      return
    }

    const partnerId = req.header('x-partner-id')
    const signature = req.header('x-partner-signature')
    // req.rawBody is preserved by Functions v1's onRequest before body
    // parsing — same mechanism stripeWebhook.ts relies on. Deliberately
    // not JSON.stringify(req.body) — see SAI-01's audit note on why
    // that's a weaker convention PawaPay's own webhooks happen to get
    // away with.
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody

    const valid = await verifyPartnerSignature(partnerId, rawBody, signature)
    if (!valid) {
      res.status(401).send('Invalid signature')
      return
    }

    const { externalInvoiceId, amountUsd, currency, dueDate, reference } = req.body as {
      externalInvoiceId?: string
      amountUsd?: number
      currency?: string
      dueDate?: string
      reference?: string
    }

    if (!externalInvoiceId || !amountUsd || amountUsd <= 0 || !currency) {
      res.status(400).send('Missing required fields')
      return
    }

    // partnerId is guaranteed defined here — verifyPartnerSignature
    // already confirmed the partner doc exists and is active.
    const partnerSnap = await db.collection('partners').doc(partnerId as string).get()
    const partnerData = partnerSnap.data()!

    // Idempotency — same discipline as the existing PawaPay/Stripe
    // webhooks (guard on a natural key before writing).
    const existing = await db
      .collection('external_invoices')
      .where('partnerId', '==', partnerId)
      .where('externalInvoiceId', '==', externalInvoiceId)
      .limit(1)
      .get()

    if (!existing.empty) {
      res.status(200).json({ status: 'duplicate_ignored', invoiceId: existing.docs[0].id })
      return
    }

    const docRef = await db.collection('external_invoices').add({
      partnerId,
      externalInvoiceId,
      amountUsd,
      currency,
      dueDate: dueDate ?? null,
      reference: reference ?? null,
      status: 'pending', // pending | checkout_created | paid | failed
      testMode: (partnerData.testMode as boolean | undefined) ?? true, // fail toward test, not live
      createdAt: FieldValue.serverTimestamp(),
    })

    res.status(200).json({ status: 'accepted', invoiceId: docRef.id })
  })
