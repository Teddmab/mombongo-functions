import * as crypto from 'crypto'
import { FieldValue } from 'firebase-admin/firestore'
import { functions, db } from '../lib/admin'

/**
 * Shared retry/backoff/dead-letter mechanics, extracted from
 * notifyPartnerPaymentComplete.ts (SAI-04) now that notifyPartnerInvoiceIssued
 * (SDP-04) is a second caller — the sprint doc asked to factor this out once
 * a second copy would otherwise exist rather than reimplementing it.
 *
 * kind distinguishes dead-letter docs in outbound_notification_failures so
 * a retry can call the right notifier back (adminRetryPartnerNotification) —
 * existing docs predate this field and have no kind, which is treated as
 * 'payment_complete' there for backward compatibility.
 */
export type PartnerWebhookKind = 'payment_complete' | 'invoice_issued'

export interface SendSignedPartnerWebhookInput {
  webhookUrl: string
  outboundSecret: string
  payload: object
  kind: PartnerWebhookKind
  partnerId: string
  invoiceId: string
  onSuccess: () => Promise<void>
}

const MAX_ATTEMPTS = 3

function signPayload(secret: string, payload: object): string {
  return crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex')
}

export async function sendSignedPartnerWebhook(input: SendSignedPartnerWebhookInput): Promise<void> {
  // Both webhook kinds land on the same partner webhookUrl with no other
  // way to tell them apart — a partner would otherwise have to infer the
  // event from which fields happen to be present. Stamping `event` here,
  // once, means every payload gets it without each notifier needing its
  // own copy of this line. Signed as part of the body, since that's what
  // the partner actually receives and verifies against.
  const body = { event: input.kind, ...input.payload }
  const signature = signPayload(input.outboundSecret, body)

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(input.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mombongo-signature': signature },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        await input.onSuccess()
        return
      }
      throw new Error(`Partner webhook returned ${res.status}`)
    } catch (err) {
      functions.logger.warn(`sendSignedPartnerWebhook (${input.kind}) attempt ${attempt} failed`, err)
      if (attempt === MAX_ATTEMPTS) {
        await db.collection('outbound_notification_failures').add({
          invoiceId: input.invoiceId,
          partnerId: input.partnerId,
          kind: input.kind,
          error: String(err),
          failedAt: FieldValue.serverTimestamp(),
        })
      } else {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000))
      }
    }
  }
}
