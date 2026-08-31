import Stripe from 'stripe'

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('Stripe not configured')
  return new Stripe(key, { apiVersion: '2026-06-24.dahlia' as any })
}

/**
 * Creates a Stripe PaymentIntent for an external-invoice payment. Reuses
 * createStripePaymentIntent.ts's SDK-call shape, but deliberately does
 * NOT go through that onCall or its context.auth requirement — the
 * caller here is a signed partner request (SAI-01), not a logged-in
 * Mombongo user, and completion must not credit anyone's walletUsd (see
 * SAI-02's audit note). metadata.kind is what stripeWebhook.ts's new
 * branch keys off of.
 *
 * metadata.invoiceId is OUR Firestore external_invoices doc id (not
 * AROM's own externalInvoiceId field) — the webhook looks the doc up
 * directly by id from this, no query needed. Don't confuse the two.
 */
export async function initiateExternalInvoiceCard(input: {
  amountUsd: number
  invoiceId: string
  partnerId: string | null
  merchantUid: string
}): Promise<{ paymentIntentId: string; clientSecret: string | null }> {
  const stripe = getStripe()
  const intent = await stripe.paymentIntents.create({
    amount: Math.round(input.amountUsd * 100),
    currency: 'usd',
    metadata: {
      kind: 'external_invoice',
      invoiceId: input.invoiceId,
      // Stripe metadata values must be strings — omitted entirely for an
      // in-app (SDP-03) payment, which has no partner. stripeWebhook.ts's
      // completion branch must not require this key to be present.
      ...(input.partnerId ? { partnerId: input.partnerId } : {}),
      merchantUid: input.merchantUid,
    },
    automatic_payment_methods: { enabled: true },
  })
  return { paymentIntentId: intent.id, clientSecret: intent.client_secret }
}
