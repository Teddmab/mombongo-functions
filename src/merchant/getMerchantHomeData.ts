import { db, functions } from '../lib/admin'

export const getMerchantHomeData = functions.region('europe-west1').https.onCall(async (_data, context) => {
  const uid = context.auth?.uid
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required')

  const [ordersSnap, listingsSnap] = await Promise.all([
    db.collection('product_orders')
      .where('merchantId', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(5)
      .get(),
    db.collection('product_listings')
      .where('status', '==', 'active')
      .orderBy('createdAt', 'desc')
      .limit(10)
      .get(),
  ])

  const orders = ordersSnap.docs.map(d => ({ id: d.id, ...d.data() }))
  const totalSpentCdf = orders.reduce((sum: number, o: any) => sum + (o.totalAmountCdf ?? 0), 0)
  const pendingOrders = orders.filter((o: any) => o.status === 'pending').length

  return {
    recentOrders: orders,
    recentListings: listingsSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    kpis: {
      totalOrders: ordersSnap.size,
      pendingOrders,
      totalSpentCdf,
    },
  }
})
