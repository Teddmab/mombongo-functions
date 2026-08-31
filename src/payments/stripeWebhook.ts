import * as admin from 'firebase-admin'
import * as functions from 'firebase-functions'
import Stripe from 'stripe'
import { markExternalInvoicePaid } from '../partners/markExternalInvoicePaid'

const db = admin.firestore()

export const stripeWebhook = functions
  .region('europe-west1')
  .https.onRequest(async (req, res) => {
    const sig = req.headers['stripe-signature'] as string
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET

    if (!webhookSecret) {
      res.status(500).send('Stripe webhook secret not configured')
      return
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-06-24.dahlia' as any })

    let event: Stripe.Event
    try {
      event = stripe.webhooks.constructEvent(
        (req as any).rawBody ?? req.body,
        sig,
        webhookSecret
      )
    } catch {
      res.status(400).send('Webhook signature verification failed')
      return
    }

    if (event.type !== 'payment_intent.succeeded') {
      res.status(200).send('OK')
      return
    }

    const pi = event.data.object as Stripe.PaymentIntent

    // SAI-02: external-invoice payments (AROM etc.) branch off entirely
    // here — runs INSTEAD OF the walletUsd-increment block below, never
    // in addition to it. No wallet is credited; a transactions doc is
    // still written for visibility, against the shared partner merchant
    // account, not a real end-user.
    if (pi.metadata.kind === 'external_invoice') {
      const { invoiceId, partnerId, merchantUid } = pi.metadata
      // partnerId is intentionally NOT required here — absent for an
      // in-app (SDP-03) payment, which has no partner. Only checking
      // invoiceId/merchantUid used to also silently drop those
      // completions entirely (this branch just returned "Missing
      // metadata" and never marked the invoice paid).
      if (!invoiceId || !merchantUid) {
        res.status(200).send('Missing external_invoice metadata')
        return
      }
      await markExternalInvoicePaid({
        invoiceRef: db.collection('external_invoices').doc(invoiceId),
        merchantUid,
        partnerId: partnerId ?? null,
        amountUsd: pi.amount / 100,
        method: 'card',
        providerRefField: 'stripePaymentIntentId',
        providerRef: pi.id,
      })
      // SAI-04's Firestore trigger reacts to the status: 'paid' write
      // above — no direct notifier call from here.
      res.status(200).send('OK')
      return
    }

    const { uid, depositId } = pi.metadata
    if (!uid || !depositId) {
      res.status(200).send('Missing metadata')
      return
    }

    const amountUsd = pi.amount / 100
    const now = admin.firestore.FieldValue.serverTimestamp()

    const depositRef = db.collection('deposits').doc(depositId)
    const depositSnap = await depositRef.get()

    if (!depositSnap.exists || depositSnap.data()?.status !== 'pending') {
      res.status(200).send('Already processed')
      return
    }

    await db.runTransaction(async tx => {
      tx.update(db.collection('users').doc(uid), {
        walletUsd: admin.firestore.FieldValue.increment(amountUsd),
      })
      tx.update(depositRef, { status: 'completed', completedAt: now })
      tx.set(db.collection('transactions').doc(), {
        userId: uid,
        type: 'deposit',
        method: 'card',
        amountUsd,
        currency: 'USD',
        status: 'completed',
        stripePaymentIntentId: pi.id,
        createdAt: now,
      })
    })

    res.status(200).send('OK')
  })
