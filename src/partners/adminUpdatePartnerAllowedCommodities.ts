import { db, functions } from '../lib/admin'
import { canonicalizeCommodity } from '../lib/commodity'

/**
 * Admin-console entry point for scoping which commodities a partner's
 * catalog access covers — enforced server-side in
 * getExternalPublishedListings.ts, not just a convenience filter the
 * partner could bypass by omitting it from their request. Mirrors
 * adminUpdatePartnerWebhookUrl's shape.
 *
 * null clears the restriction (unrestricted — every active listing
 * visible, the pre-existing behavior for partners provisioned before
 * this existed). An explicit [] means "nothing", not "everything" — the
 * two are never conflated here or in the enforcement point.
 */
export const adminUpdatePartnerAllowedCommodities = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    if (!context.auth?.uid)
      throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const callerSnap = await db.collection('users').doc(context.auth.uid).get()
    if (callerSnap.data()?.role !== 'admin')
      throw new functions.https.HttpsError('permission-denied', 'Admin only')

    const { partnerId, allowedCommodities } = (data ?? {}) as { partnerId?: string; allowedCommodities?: string[] | null }
    if (!partnerId) {
      throw new functions.https.HttpsError('invalid-argument', 'partnerId required')
    }
    if (allowedCommodities !== null && allowedCommodities !== undefined) {
      if (!Array.isArray(allowedCommodities) || allowedCommodities.some((c) => typeof c !== 'string' || !c.trim())) {
        throw new functions.https.HttpsError('invalid-argument', 'allowedCommodities must be an array of non-empty strings, or null')
      }
    }

    const partnerRef = db.collection('partners').doc(partnerId)
    const partnerSnap = await partnerRef.get()
    if (!partnerSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'Partner not found')
    }

    await partnerRef.update({
      allowedCommodityCodes: allowedCommodities ? allowedCommodities.map(canonicalizeCommodity) : null,
    })
    functions.logger.info(`adminUpdatePartnerAllowedCommodities: ${context.auth.uid} updated allowedCommodities for partner ${partnerId}`)
    return { success: true }
  })
