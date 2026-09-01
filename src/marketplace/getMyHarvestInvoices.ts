import { db, functions } from '../lib/admin'

/**
 * Merchant viewing their own harvest-sale invoices (SDP-07) — origin
 * scoped to 'harvest_sale' so this doesn't leak unrelated partner_api
 * invoices a merchant's uid happens to also be linked to via a partner
 * doc's merchantUid.
 */
export const getMyHarvestInvoices = functions
  .region('europe-west1')
  .https.onCall(async (_data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const snap = await db.collection('external_invoices')
      .where('merchantId', '==', uid)
      .where('origin', '==', 'harvest_sale')
      .orderBy('createdAt', 'desc')
      .get()

    return { invoices: snap.docs.map(d => ({ id: d.id, ...d.data() })) }
  })
