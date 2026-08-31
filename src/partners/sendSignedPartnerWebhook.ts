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
  const signature = signPayload(input.outboundSecret, input.payload)

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(input.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mombongo-signature': signature },
        body: JSON.stringify(input.payload),
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
