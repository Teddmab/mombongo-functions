import * as crypto from 'crypto'
import { db } from '../lib/admin'

/**
 * Fail-closed HMAC verification for partner-signed inbound requests. This
 * is a genuinely separate trust relationship from PawaPay's callbacks
 * (partners signing their own calls into Mombongo, with a per-partner
 * shared secret) — it's unrelated to, and not affected by, PawaPay's
 * callback signing moving to RFC 9421 asymmetric signatures (see
 * src/payments/verifyPawapayCallbackSignature.ts). Missing partner,
 * inactive partner, missing secret, missing signature, or a mismatched
 * signature are all "no".
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
