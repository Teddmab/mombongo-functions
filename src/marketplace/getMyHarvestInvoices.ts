import { db, functions } from '../lib/admin'

/**
 * Merchant viewing their own invoices (SDP-07) — origin scoped to
 * 'harvest_sale' and 'admin_assisted' (a real merchant can be the buyer
 * on either), excluding 'partner_api' so this doesn't leak invoices a
 * merchant's uid happens to also be linked to via a partner doc's
 * merchantUid — those are the partner's own systems' concern, surfaced
 * through their webhook, not this in-app screen.
 *
 * Resolves the farmer's name server-side (or every farmer's, for a
 * cooperative) — mombongo-web has no direct Firestore access and a
 * merchant has no permission to read another user's profile even if it
 * did, so without this the screen could only ever show a bare amount.
 */
export const getMyHarvestInvoices = functions
  .region('europe-west1')
  .https.onCall(async (_data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const snap = await db.collection('external_invoices')
      .where('merchantId', '==', uid)
      .where('origin', 'in', ['harvest_sale', 'admin_assisted'])
      .orderBy('createdAt', 'desc')
      .get()

    const farmerIds = Array.from(new Set(snap.docs.flatMap((d) => {
      const data = d.data()
      return Array.isArray(data.farmers)
        ? (data.farmers as { farmerId: string }[]).map((f) => f.farmerId)
        : [data.farmerId as string]
    }).filter(Boolean)))
    const farmerSnaps = await Promise.all(farmerIds.map((id) => db.collection('users').doc(id).get()))
    const farmerNames = new Map(
      farmerSnaps.map((s) => [s.id, (s.data()?.fullName as string) || (s.data()?.displayName as string) || 'Agriculteur']),
    )

    return {
      invoices: snap.docs.map((d) => {
        const data = d.data()
        const farmerNamesList = Array.isArray(data.farmers)
          ? (data.farmers as { farmerId: string }[]).map((f) => farmerNames.get(f.farmerId) ?? 'Agriculteur')
          : [farmerNames.get(data.farmerId as string) ?? 'Agriculteur']
        return {
          id: d.id,
          ...data,
          farmerNames: farmerNamesList,
        }
      }),
    }
  })
