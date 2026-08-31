import { db, functions } from '../lib/admin'
import { validateWebhookUrl } from '../lib/validateWebhookUrl'

/**
 * Admin-console entry point for setting/rotating a partner's webhookUrl —
 * same context.auth?.uid -> users/{uid}.role === 'admin' guard as
 * adminProvisionPartner. This is the only way to change it going forward;
 * previously it was either set at provisioning time or edited by hand
 * directly in Firestore (AROM's was set that way as a one-off).
 *
 * There is no partner self-service path here or anywhere else in this
 * codebase — a partner cannot log in and manage their own webhookUrl.
 * partners/{partnerId} has no per-partner auth boundary at all today,
 * only isAdmin(). That's a separate, larger gap than this ask covers.
 */
export const adminUpdatePartnerWebhookUrl = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    if (!context.auth?.uid)
      throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const callerSnap = await db.collection('users').doc(context.auth.uid).get()
    if (callerSnap.data()?.role !== 'admin')
      throw new functions.https.HttpsError('permission-denied', 'Admin only')

    const { partnerId, webhookUrl } = (data ?? {}) as { partnerId?: string; webhookUrl?: string }
    if (!partnerId || !webhookUrl) {
      throw new functions.https.HttpsError('invalid-argument', 'partnerId and webhookUrl required')
    }

    const check = validateWebhookUrl(webhookUrl)
    if (!check.valid) {
      throw new functions.https.HttpsError('invalid-argument', check.reason)
    }

    const partnerRef = db.collection('partners').doc(partnerId)
    const partnerSnap = await partnerRef.get()
    if (!partnerSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'Partner not found')
    }

    await partnerRef.update({ webhookUrl })
    functions.logger.info(`adminUpdatePartnerWebhookUrl: ${context.auth.uid} updated webhookUrl for partner ${partnerId}`)
    return { success: true }
  })
