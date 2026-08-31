import * as crypto from 'crypto'
import * as admin from 'firebase-admin'

if (!admin.apps.length) admin.initializeApp()
const db = admin.firestore()
const auth = admin.auth()

/**
 * One-time partner onboarding: provisions the shared Mombongo merchant
 * account a partner's invoice payments post through (SAI-00 decision 5 —
 * one "AROM API merchant" account, not one per AROM end-user), plus the
 * partners/{partnerId} doc with fresh HMAC secrets.
 *
 * Run once per partner via:
 *   npx ts-node -e 'require("./src/scripts/provisionPartner").provisionPartner({
 *     partnerId: "arom",
 *     partnerName: "AROM",
 *     merchantEmail: "arom-api@partners.mombongo.coop",
 *     merchantDisplayName: "AROM — compte API",
 *     testMode: true,
 *   })'
 *
 * Prints the generated hmacSecret/outboundHmacSecret once — these are
 * never re-readable after this run (only their values in Firestore, not
 * logged again), share them with the partner out-of-band and store them
 * securely on your side too.
 */
export async function provisionPartner(opts: {
  partnerId: string
  partnerName: string
  merchantEmail: string
  merchantDisplayName: string
  webhookUrl?: string
  testMode: boolean
}): Promise<void> {
  const { partnerId, partnerName, merchantEmail, merchantDisplayName, webhookUrl, testMode } = opts

  const existingPartner = await db.collection('partners').doc(partnerId).get()
  if (existingPartner.exists) {
    throw new Error(`partners/${partnerId} already exists — this script does not overwrite. ` +
      `Edit the doc directly (e.g. to rotate a secret) instead of re-running provisioning.`)
  }

  // Merchant account: a real Firebase Auth + users/{uid} doc, role
  // 'merchant', but never used for interactive login — no password is
  // set, and nothing in this sprint mints a client-facing session for it
  // (see SAI-00 decision 5 on why no token-minting is needed for the
  // scope built so far).
  let merchantUid: string
  try {
    const existingUser = await auth.getUserByEmail(merchantEmail)
    merchantUid = existingUser.uid
    console.log(`Reusing existing Firebase Auth user for ${merchantEmail}: ${merchantUid}`)
  } catch {
    const created = await auth.createUser({
      email: merchantEmail,
      emailVerified: true,
      displayName: merchantDisplayName,
      disabled: false,
    })
    merchantUid = created.uid
    console.log(`Created Firebase Auth user for ${merchantEmail}: ${merchantUid}`)
  }

  await db.collection('users').doc(merchantUid).set(
    {
      fullName: merchantDisplayName,
      email: merchantEmail,
      role: 'merchant',
      preferredLanguage: 'fr',
      isApiAccount: true, // not a human login — mirrors nothing today, new marker so this account is visually distinguishable in admin lists
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  )

  const hmacSecret = crypto.randomBytes(32).toString('hex')
  const outboundHmacSecret = crypto.randomBytes(32).toString('hex')

  await db.collection('partners').doc(partnerId).set({
    name: partnerName,
    hmacSecret,
    outboundHmacSecret,
    webhookUrl: webhookUrl ?? null, // AROM's inbound URL — not available yet, see SAI-00 manual setup
    merchantUid,
    testMode,
    active: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  })

  console.log(`\nProvisioned partners/${partnerId}. Share these with the partner out-of-band — not logged anywhere else:`)
  console.log(`  hmacSecret (inbound, partner signs requests to Mombongo with this): ${hmacSecret}`)
  console.log(`  outboundHmacSecret (Mombongo signs notifications to the partner with this): ${outboundHmacSecret}`)
}
