import { db, functions } from '../lib/admin'

/**
 * Farmer-facing equivalent of getMyHarvestInvoices — nothing showed a
 * farmer the invoices issued in their name at all before this, for any
 * origin (harvest_sale, admin_assisted, or a cooperative where they're
 * not farmers[0]). Uses farmerIds (array-contains) rather than farmerId
 * so a cooperative's other members show up too, not just the first one
 * listed on the invoice.
 *
 * Resolves the merchant's name server-side, same reason mombongo-web
 * can't do it itself: the frontend has no direct Firestore access, and a
 * farmer has no permission to read another user's profile even if it did.
 */
export const getMyIssuedInvoices = functions
  .region('europe-west1')
  .https.onCall(async (_data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

    const snap = await db.collection('external_invoices')
      .where('farmerIds', 'array-contains', uid)
      .orderBy('createdAt', 'desc')
      .get()

    const merchantIds = Array.from(new Set(snap.docs.map((d) => d.data().merchantId as string).filter(Boolean)))
    const merchantSnaps = await Promise.all(merchantIds.map((id) => db.collection('users').doc(id).get()))
    const merchantNames = new Map(
      merchantSnaps.map((s) => [s.id, (s.data()?.fullName as string) || (s.data()?.displayName as string) || 'Commerçant']),
    )

    return {
      invoices: snap.docs.map((d) => {
        const data = d.data()
        return {
          id: d.id,
          origin: data.origin,
          merchantId: data.merchantId,
          merchantName: merchantNames.get(data.merchantId as string) ?? 'Commerçant',
          commodity: data.commodity ?? null,
          quantityKg: data.quantityKg ?? null,
          contributedKg: Array.isArray(data.farmers)
            ? (data.farmers as { farmerId: string; contributedKg: number }[]).find((f) => f.farmerId === uid)?.contributedKg ?? null
            : data.quantityKg ?? null,
          isCooperative: !!data.isCooperative,
          amountUsd: data.amountUsd,
          currency: data.currency,
          status: data.status,
          createdAt: data.createdAt,
          paidAt: data.paidAt ?? null,
        }
      }),
    }
  })
