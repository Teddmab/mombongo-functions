import * as crypto from 'crypto'
import { admin, auth, db } from '../lib/admin'

/**
 * Shared by the CLI script (src/scripts/provisionPartner.ts) and the
 * admin-console CF (adminProvisionPartner.ts) — one partner-onboarding
 * path regardless of who triggers it, so provisioning a new partner
 * never requires writing or running new code, only calling this with
 * different inputs.
 *
 * merchantMode 'new' creates the shared, login-less synthetic merchant
 * account (SAI-00 decision 5) exactly as before. merchantMode 'existing'
 * links a partner to a real, already-existing Mombongo merchant account
 * instead — for a partner whose payments should be attributed to an
 * actual business already on the platform rather than a synthetic one.
 */
export type ProvisionPartnerInput = {
  partnerId: string
  partnerName: string
  webhookUrl?: string | null
  testMode: boolean
  createdBy?: string // admin uid, when invoked via adminProvisionPartner
} & (
  | { merchantMode: 'new'; merchantEmail: string; merchantDisplayName: string }
  | { merchantMode: 'existing'; existingMerchantUid: string }
)

export interface ProvisionPartnerResult {
  partnerId: string
  merchantUid: string
  hmacSecret: string
  outboundHmacSecret: string
}

export async function provisionPartnerCore(input: ProvisionPartnerInput): Promise<ProvisionPartnerResult> {
  const existingPartner = await db.collection('partners').doc(input.partnerId).get()
  if (existingPartner.exists) {
    throw new Error(`partners/${input.partnerId} already exists — this does not overwrite. ` +
      `Edit the doc directly (e.g. to rotate a secret) instead of re-provisioning.`)
  }

  let merchantUid: string
  if (input.merchantMode === 'existing') {
    const userSnap = await db.collection('users').doc(input.existingMerchantUid).get()
    if (!userSnap.exists) throw new Error(`users/${input.existingMerchantUid} not found`)
    if (userSnap.data()?.role !== 'merchant')
      throw new Error(`users/${input.existingMerchantUid} is not a merchant-role account`)
    merchantUid = input.existingMerchantUid
  } else {
    // Real Firebase Auth + users/{uid} doc, role 'merchant', but never
    // used for interactive login — no password is set, and nothing here
    // mints a client-facing session for it (SAI-00 decision 5).
    let userRecord
    try {
      userRecord = await auth.getUserByEmail(input.merchantEmail)
    } catch {
      userRecord = await auth.createUser({
        email: input.merchantEmail,
        emailVerified: true,
        displayName: input.merchantDisplayName,
        disabled: false,
      })
    }
    merchantUid = userRecord.uid
    await db.collection('users').doc(merchantUid).set(
      {
        fullName: input.merchantDisplayName,
        email: input.merchantEmail,
        role: 'merchant',
        preferredLanguage: 'fr',
        isApiAccount: true, // not a human login — distinguishes this in admin lists
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    )
  }

  const hmacSecret = crypto.randomBytes(32).toString('hex')
  const outboundHmacSecret = crypto.randomBytes(32).toString('hex')

  await db.collection('partners').doc(input.partnerId).set({
    name: input.partnerName,
    hmacSecret,
    outboundHmacSecret,
    webhookUrl: input.webhookUrl ?? null,
    merchantUid,
    testMode: input.testMode,
    active: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdBy: input.createdBy ?? null,
  })

  return { partnerId: input.partnerId, merchantUid, hmacSecret, outboundHmacSecret }
}
