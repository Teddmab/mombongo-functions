import * as crypto from 'crypto'
import { db } from '../lib/admin'

/**
 * Fail-closed HMAC verification for partner-signed inbound requests —
 * mirrors verifyPawapayHmac (src/payments/pawapayWebhook.ts) exactly,
 * not the fail-open inline check in pawapayPayoutWebhook.ts/
 * pawapayRefundWebhook.ts. Missing partner, inactive partner, missing
 * secret, missing signature, or a mismatched signature are all "no".
 */
export async function verifyPartnerSignature(
  partnerId: string | undefined,
  rawBody: Buffer | undefined,
  signatureHeader: string | undefined,
): Promise<boolean> {
  if (!partnerId || !rawBody || !signatureHeader) return false

  const partnerSnap = await db.collection('partners').doc(partnerId).get()
  if (!partnerSnap.exists || !partnerSnap.data()?.active) return false

  const secret = partnerSnap.data()?.hmacSecret as string | undefined
  if (!secret) return false // fail closed — missing config is not "allow"

  const expectedHex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  const sigBuf = Buffer.from(signatureHeader, 'utf8')
  const expBuf = Buffer.from(expectedHex, 'utf8')
  if (sigBuf.length !== expBuf.length) return false
  return crypto.timingSafeEqual(sigBuf, expBuf)
}
