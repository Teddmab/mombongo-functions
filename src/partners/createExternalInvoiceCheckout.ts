import { FieldValue } from 'firebase-admin/firestore'
import { db, functions } from '../lib/admin'
import { verifyPartnerSignature } from './verifyPartnerSignature'
import { initiateExternalInvoiceCard } from './initiateExternalInvoiceCard'
import { initiateExternalInvoiceMobileMoney } from './initiateExternalInvoiceMobileMoney'

/**
 * Given a pending external_invoices doc (SAI-01) and a chosen payment
 * method, creates the matching provider session. Same partner-signature
 * auth as createExternalInvoice. Does NOT reuse initiateDeposit.ts/
 * createStripePaymentIntent.ts — those credit a Mombongo user's wallet on
 * completion, which doesn't apply here (see SAI-02's audit note). Instead
 * calls new, purpose-built functions that share the provider-calling
 * shape but write nothing to deposits/ or walletUsd.
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
      method?: 'mobile_money' | 'card' | 'bank_transfer'
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

    let responseBody: Record<string, unknown>
    let providerRef: string

    try {
      if (method === 'card') {
        const intent = await initiateExternalInvoiceCard({
          amountUsd: invoice.amountUsd,
          invoiceId,
          partnerId: partnerId as string,
          merchantUid,
        })
        // Matches createStripePaymentIntent.ts's existing response shape
        // (clientSecret, not a hosted redirect URL) — AROM embeds
        // Stripe.js client-side.
        responseBody = { clientSecret: intent.clientSecret }
        providerRef = intent.paymentIntentId
      } else if (method === 'mobile_money') {
        if (!phone || !operator) {
          res.status(400).send('phone and operator required for mobile_money')
          return
        }
        // PawaPay's flow is a phone-push prompt, not a URL — there is no
        // checkout page to redirect to. The response here is just an
        // acceptance status; completion arrives via SAI-04's webhook.
        const deposit = await initiateExternalInvoiceMobileMoney({
          amountUsd: invoice.amountUsd,
          phone,
          operator,
        })
        responseBody = { depositStatus: deposit.status }
        providerRef = deposit.depositId
      } else {
        // bank_transfer — see SAI-03, provider not yet chosen.
        res.status(501).send('Bank transfer not yet implemented')
        return
      }
    } catch (err) {
      functions.logger.error('createExternalInvoiceCheckout: provider call failed', err)
      res.status(502).send(err instanceof Error ? err.message : 'Provider error')
      return
    }

    await invoiceSnap.ref.update({
      status: 'checkout_created',
      method,
      providerRef,
      checkoutCreatedAt: FieldValue.serverTimestamp(),
    })

    res.status(200).json({ status: 'checkout_created', providerRef, ...responseBody })
  })
