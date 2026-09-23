import * as crypto from 'crypto'

/**
 * Fail-closed HMAC verification for inbound PawaPay webhooks — mirrors
 * verifyPartnerSignature.ts's pattern exactly. Previously each of
 * pawapayWebhook.ts / pawapayPayoutWebhook.ts / pawapayRefundWebhook.ts
 * inlined an `if (secret && signature) { ...verify... }` check: when
 * either PAWAPAY_WEBHOOK_SECRET or the x-pawapay-signature header was
 * absent, the block was skipped entirely and the request was processed
 * as authentic — a fail-open gap, not the fail-closed behavior two other
 * files' comments (verifyPartnerSignature.ts, createExternalInvoice.ts)
 * incorrectly claimed this already had via a `verifyPawapayHmac` function
 * that never actually existed in source.
 *
 * Missing secret, missing signature header, or a mismatched signature
 * are all "no" — never "proceed unverified".
 */
export function verifyPawapayWebhookSignature(
  secret: string | undefined,
  signatureHeader: string | undefined,
  rawBody: string,
): boolean {
  if (!secret || !signatureHeader) return false

  const expectedHex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  const sigBuf = Buffer.from(signatureHeader, 'utf8')
  const expBuf = Buffer.from(expectedHex, 'utf8')
  if (sigBuf.length !== expBuf.length) return false
  return crypto.timingSafeEqual(sigBuf, expBuf)
}
