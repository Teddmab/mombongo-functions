import { FieldValue } from 'firebase-admin/firestore'
import { functions } from '../lib/admin'
import { initiateExternalInvoiceCard } from './initiateExternalInvoiceCard'
import { initiateExternalInvoiceMobileMoney } from './initiateExternalInvoiceMobileMoney'

/**
 * Shared by createExternalInvoiceCheckout.ts (partner-signed, SAI-02) and
 * payHarvestInvoice.ts (session-authenticated, SDP-03) — the two callers
 * differ only in how they arrive at merchantUid (partner-doc lookup vs.
 * context.auth.uid directly) and in their auth/lookup guards, not in what
 * happens once merchantUid and the invoice are resolved.
 *
 * Writes merchantUid onto the invoice doc at checkout-creation time (new
 * — SAI-02 never did this). pawapayWebhook.ts's completion branch reads
 * it from there directly instead of re-deriving it via a partner-doc
 * lookup, which is what let a null partnerId (the in-app case) silently
 * break completion — see stripeWebhook.ts/pawapayWebhook.ts's own
 * updated comments for the full story.
 */
export interface CreateCheckoutInput {
  invoiceRef: FirebaseFirestore.DocumentReference
  invoiceId: string
  amountUsd: number
  merchantUid: string
  partnerId: string | null
  method: 'card' | 'mobile_money' | 'bank_transfer'
  phone?: string
  operator?: string
}

export type CreateCheckoutResult =
  | { ok: true; providerRef: string; responseBody: Record<string, unknown> }
  | { ok: false; kind: 'missing_phone_operator' }
  | { ok: false; kind: 'bank_transfer_unimplemented' }
  | { ok: false; kind: 'provider_error'; message: string }

export async function createCheckoutForInvoiceCore(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
  let responseBody: Record<string, unknown>
  let providerRef: string

  try {
    if (input.method === 'card') {
      const intent = await initiateExternalInvoiceCard({
        amountUsd: input.amountUsd,
        invoiceId: input.invoiceId,
        partnerId: input.partnerId,
        merchantUid: input.merchantUid,
      })
      // Matches createStripePaymentIntent.ts's existing response shape
      // (clientSecret, not a hosted redirect URL).
      responseBody = { clientSecret: intent.clientSecret }
      providerRef = intent.paymentIntentId
    } else if (input.method === 'mobile_money') {
      if (!input.phone || !input.operator) {
        return { ok: false, kind: 'missing_phone_operator' }
      }
      // PawaPay's flow is a phone-push prompt, not a URL — there is no
      // checkout page to redirect to. The response here is just an
      // acceptance status; completion arrives via the webhook.
      const deposit = await initiateExternalInvoiceMobileMoney({
        amountUsd: input.amountUsd,
        phone: input.phone,
        operator: input.operator,
      })
      responseBody = { depositStatus: deposit.status }
      providerRef = deposit.depositId
    } else {
      // bank_transfer — see SAI-03, provider not yet chosen.
      return { ok: false, kind: 'bank_transfer_unimplemented' }
    }
  } catch (err) {
    functions.logger.error('createCheckoutForInvoiceCore: provider call failed', err)
    return { ok: false, kind: 'provider_error', message: err instanceof Error ? err.message : 'Provider error' }
  }

  await input.invoiceRef.update({
    status: 'checkout_created',
    method: input.method,
    providerRef,
    merchantUid: input.merchantUid,
    checkoutCreatedAt: FieldValue.serverTimestamp(),
  })

  return { ok: true, providerRef, responseBody }
}
