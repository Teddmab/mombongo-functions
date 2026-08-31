import { db, functions } from '../lib/admin'
import { verifyPartnerSignature } from './verifyPartnerSignature'
import { createCheckoutForInvoiceCore } from './createCheckoutForInvoiceCore'

/**
 * Given a pending external_invoices doc (SAI-01) and a chosen payment
 * method, creates the matching provider session. Same partner-signature
 * auth as createExternalInvoice. Does NOT reuse initiateDeposit.ts —
 * that credits a Mombongo user's wallet on completion, which doesn't
 * apply here (see SAI-02's audit note). Instead calls a new,
 * purpose-built function that shares the provider-calling shape but
 * writes nothing to deposits/ or walletUsd.
 *
 * Provider-calling body extracted to createCheckoutForInvoiceCore.ts
 * (SDP-03), shared with payHarvestInvoice.ts's session-authenticated
 * equivalent. card support was removed platform-wide (never processed a
 * real payment) — mobile_money is the only implemented method today.
 */
export const createExternalInvoiceCheckout = functions
  .region('europe-west1')
  .https.onRequest(async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).send('Method not allowed')
      return
    }

    const partnerId = req.header('x-partner-id')
    const signature = req.header('x-partner-signature')
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody

    const valid = await verifyPartnerSignature(partnerId, rawBody, signature)
    if (!valid) {
      res.status(401).send('Invalid signature')
      return
    }

    const { invoiceId, method, phone, operator } = req.body as {
      invoiceId?: string
      method?: 'mobile_money' | 'bank_transfer'
      phone?: string
      operator?: string
    }

    if (!invoiceId || !method) {
      res.status(400).send('Missing required fields')
      return
    }

    const invoiceSnap = await db.collection('external_invoices').doc(invoiceId).get()
    if (!invoiceSnap.exists || invoiceSnap.data()?.partnerId !== partnerId) {
      res.status(404).send('Invoice not found')
      return
    }
    const invoice = invoiceSnap.data()!
    if (invoice.status !== 'pending') {
      // Already has a checkout in flight or is resolved — don't create a
      // second provider session.
      res.status(409).json({ status: 'already_in_progress', currentStatus: invoice.status })
      return
    }

    const partnerSnap = await db.collection('partners').doc(partnerId as string).get()
    const partnerData = partnerSnap.data()!
    const merchantUid = partnerData.merchantUid as string | undefined
    if (!merchantUid) {
      // Partner provisioned without a linked merchant account — fail
      // closed rather than proceeding with no attribution.
      res.status(500).send('Partner not fully provisioned')
      return
    }

    const result = await createCheckoutForInvoiceCore({
      invoiceRef: invoiceSnap.ref,
      invoiceId,
      amountUsd: invoice.amountUsd,
      merchantUid,
      partnerId: partnerId as string,
      method,
      phone,
      operator,
    })

    if (!result.ok) {
      if (result.kind === 'missing_phone_operator') {
        res.status(400).send('phone and operator required for mobile_money')
      } else if (result.kind === 'bank_transfer_unimplemented') {
        res.status(501).send('Bank transfer not yet implemented')
      } else {
        res.status(502).send(result.message)
      }
      return
    }

    res.status(200).json({ status: 'checkout_created', providerRef: result.providerRef, ...result.responseBody })
  })
