import * as admin from 'firebase-admin'

if (!admin.apps.length) admin.initializeApp()

/**
 * CLI entry point for partner onboarding — thin wrapper around
 * provisionPartnerCore (src/partners/provisionPartnerCore.ts), the same
 * logic the admin-console CF (adminProvisionPartner.ts) uses. Prefer the
 * admin console for day-to-day provisioning; this script remains useful
 * for local/emulator testing where there's no deployed admin UI to click
 * through.
 *
 * Run via:
 *   npx ts-node -e 'require("./src/scripts/provisionPartner").provisionPartner({
 *     partnerId: "arom",
 *     partnerName: "AROM",
 *     merchantMode: "new",
 *     merchantEmail: "arom-api@partners.mombongo.coop",
 *     merchantDisplayName: "AROM — compte API",
 *     testMode: true,
 *   })'
 *
 * Prints the generated hmacSecret/outboundHmacSecret once — these are
 * never re-logged after this run; share them with the partner
 * out-of-band and store them securely on your side too.
 */
export async function provisionPartner(
  opts: import('../partners/provisionPartnerCore').ProvisionPartnerInput,
): Promise<void> {
  const { provisionPartnerCore } = await import('../partners/provisionPartnerCore')
  const result = await provisionPartnerCore(opts)
  console.log(`\nProvisioned partners/${result.partnerId} (merchantUid: ${result.merchantUid}).`)
  console.log(`Share these with the partner out-of-band — not logged anywhere else:`)
  console.log(`  hmacSecret (inbound, partner signs requests to Mombongo with this): ${result.hmacSecret}`)
  console.log(`  outboundHmacSecret (Mombongo signs notifications to the partner with this): ${result.outboundHmacSecret}`)
}
