import { db, functions } from '../lib/admin'
import { provisionPartnerCore, type ProvisionPartnerInput } from './provisionPartnerCore'
import { validateWebhookUrl } from '../lib/validateWebhookUrl'

/**
 * Admin-console entry point for partner onboarding — same
 * context.auth?.uid -> users/{uid}.role === 'admin' guard as every other
 * admin CF (adminTriggerMorningPricePush, adminRetryPartnerNotification).
 * Lets any admin provision a new partner from mombongo-admin directly,
 * without anyone running a script — see provisionPartnerCore.ts for the
 * shared logic.
 *
 * Secrets are returned once in the response for the admin UI to display
 * — they are not re-sent or logged anywhere after this call. They remain
 * readable later only via a direct Firestore read of the partners doc
 * (Admin SDK / an admin-role Firestore read), same as before.
 */
export const adminProvisionPartner = functions
  .region('europe-west1')
  .https.onCall(async (data, context) => {
    if (!context.auth?.uid)
      throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const callerSnap = await db.collection('users').doc(context.auth.uid).get()
    if (callerSnap.data()?.role !== 'admin')
      throw new functions.https.HttpsError('permission-denied', 'Admin only')

    const body = data as {
      partnerId?: string
      partnerName?: string
      webhookUrl?: string
      testMode?: boolean
      merchantMode?: 'new' | 'existing'
      merchantEmail?: string
      merchantDisplayName?: string
      existingMerchantUid?: string
    }

    if (!body.partnerId || !body.partnerName || !body.merchantMode)
      throw new functions.https.HttpsError('invalid-argument', 'partnerId, partnerName, and merchantMode are required')

    if (body.webhookUrl) {
      const check = validateWebhookUrl(body.webhookUrl)
      if (!check.valid) throw new functions.https.HttpsError('invalid-argument', check.reason)
    }

    let input: ProvisionPartnerInput
    if (body.merchantMode === 'existing') {
      if (!body.existingMerchantUid)
        throw new functions.https.HttpsError('invalid-argument', 'existingMerchantUid required for merchantMode "existing"')
      input = {
        partnerId: body.partnerId,
        partnerName: body.partnerName,
        webhookUrl: body.webhookUrl ?? null,
        testMode: body.testMode ?? true, // fail toward test, not live
        createdBy: context.auth.uid,
        merchantMode: 'existing',
        existingMerchantUid: body.existingMerchantUid,
      }
    } else {
      if (!body.merchantEmail || !body.merchantDisplayName)
        throw new functions.https.HttpsError('invalid-argument', 'merchantEmail and merchantDisplayName required for merchantMode "new"')
      input = {
        partnerId: body.partnerId,
        partnerName: body.partnerName,
        webhookUrl: body.webhookUrl ?? null,
        testMode: body.testMode ?? true,
        createdBy: context.auth.uid,
        merchantMode: 'new',
        merchantEmail: body.merchantEmail,
        merchantDisplayName: body.merchantDisplayName,
      }
    }

    try {
      const result = await provisionPartnerCore(input)
      functions.logger.info(`adminProvisionPartner: ${context.auth.uid} provisioned partner ${result.partnerId}`)
      return result
    } catch (err) {
      throw new functions.https.HttpsError('failed-precondition', err instanceof Error ? err.message : 'Provisioning failed')
    }
  })
